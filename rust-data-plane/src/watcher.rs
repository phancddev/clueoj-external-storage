use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use notify::event::{CreateKind, RemoveKind};
use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use sqlx::PgPool;
use tokio::sync::mpsc;

use crate::db;
use crate::r2::ObjectStore;
use crate::scanner;
use crate::snapshot::SnapshotManager;

const DEBOUNCE_DELAY: Duration = Duration::from_secs(5);
const DEBOUNCE_MAX_DELAY: Duration = Duration::from_secs(30);
const WATCHER_LEASE_SECONDS: i64 = 300;
const WATCHER_LEASE_RENEW_SECONDS: i64 = 60;

#[derive(Debug, Clone, Copy)]
struct DebounceState {
    first_seen: tokio::time::Instant,
    deadline: tokio::time::Instant,
}

pub fn spawn_watcher(
    root: Arc<Path>,
    db: PgPool,
    store: Arc<dyn ObjectStore>,
    judge_update_urls: Vec<String>,
) {
    let root_for_closure = root.clone();
    tokio::spawn(async move {
        let (tx, mut rx) = mpsc::channel::<String>(256);
        let root_for_cb = root_for_closure.clone();
        let mut watcher = match RecommendedWatcher::new(
            move |res: notify::Result<notify::Event>| {
                if let Ok(event) = res {
                    for code in problem_codes_from_event(root_for_cb.as_ref(), &event) {
                        let _ = tx.blocking_send(code);
                    }
                }
            },
            Config::default().with_poll_interval(Duration::from_secs(2)),
        ) {
            Ok(w) => w,
            Err(e) => {
                tracing::error!(error = %e, "watcher init failed");
                return;
            }
        };

        if let Err(e) = watcher.watch(root.as_ref(), RecursiveMode::Recursive) {
            tracing::error!(error = %e, "watcher start failed");
            return;
        }
        tracing::info!(root = ?root.as_ref(), "filesystem watcher started");
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(3))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("valid judge notification client");
        let (notify_tx, mut notify_rx) = mpsc::channel::<()>(1);
        tokio::spawn(async move {
            while notify_rx.recv().await.is_some() {
                notify_judges(&http, &judge_update_urls).await;
            }
        });
        // Refresh once after a storage restart in case problem changes happened
        // while this watcher was down. Judges also enumerate on their own start.
        let _ = notify_tx.try_send(());

        let mut debounce: std::collections::HashMap<String, DebounceState> =
            std::collections::HashMap::new();
        loop {
            let next_deadline = debounce.values().map(|v| v.deadline).min();
            tokio::select! {
                maybe_code = rx.recv() => {
                    let Some(code) = maybe_code else { break; };
                    let now = tokio::time::Instant::now();
                    update_debounce(&mut debounce, code.clone(), now);
                    tracing::debug!(code, "change detected, debounce deadline updated");
                    if let Err(e) = db::mark_stale(&db, &code).await {
                        tracing::warn!(error = %e, code, "mark_stale failed");
                    }
                }
                _ = sleep_until_optional(next_deadline), if next_deadline.is_some() => {
                    let now = tokio::time::Instant::now();
                    let ready: Vec<String> = debounce
                        .iter()
                        .filter(|(_, state)| state.deadline <= now)
                        .map(|(code, _)| code.clone())
                        .collect();
                    if !ready.is_empty() {
                        let _ = notify_tx.try_send(());
                    }
                    for code in ready {
                        debounce.remove(&code);
                        if let Err(e) = snapshot_dirty_code(root.as_ref(), &db, store.clone(), &code).await {
                            tracing::warn!(error = %e, code, "auto snapshot after dirty failed");
                        }
                    }
                }
            }
        }
    });
}

async fn notify_judges(client: &reqwest::Client, urls: &[String]) {
    futures::future::join_all(urls.iter().map(|url| async move {
        for attempt in 0..3 {
            match client.post(url).send().await {
                Ok(response) if response.status().is_success() => return,
                Ok(response) => tracing::warn!(url, status = %response.status(), attempt, "judge update rejected"),
                Err(error) => tracing::warn!(url, %error, attempt, "judge update failed"),
            }
            if attempt < 2 {
                tokio::time::sleep(Duration::from_secs(1 << attempt)).await;
            }
        }
    })).await;
}

async fn sleep_until_optional(deadline: Option<tokio::time::Instant>) {
    if let Some(deadline) = deadline {
        tokio::time::sleep_until(deadline).await;
    }
}

fn update_debounce(
    debounce: &mut std::collections::HashMap<String, DebounceState>,
    code: String,
    now: tokio::time::Instant,
) {
    debounce
        .entry(code)
        .and_modify(|state| {
            state.deadline = now + debounce_wait_for_age(now.duration_since(state.first_seen));
        })
        .or_insert(DebounceState {
            first_seen: now,
            deadline: now + DEBOUNCE_DELAY,
        });
}

pub fn debounce_wait_for_age(age: Duration) -> Duration {
    DEBOUNCE_DELAY.min(DEBOUNCE_MAX_DELAY.saturating_sub(age))
}

async fn snapshot_dirty_code(
    root: &Path,
    db: &PgPool,
    store: Arc<dyn ObjectStore>,
    code: &str,
) -> crate::error::AppResult<()> {
    let folder = crate::paths::safe_problem_folder(root, code)?;
    if !folder.exists() {
        db::mark_local_missing_by_code(db, code).await?;
        tracing::info!(
            code,
            "watcher marked problem folder missing without snapshot"
        );
        return Ok(());
    }
    if !folder.is_dir() {
        tracing::debug!(code, "watcher ignored non-directory path in problem root");
        return Ok(());
    }
    let mut scan = scanner::scan_problem_folder(root, code)?;
    if scanner::canonical_download_path_from_folder(&folder, &scan.files).is_some() {
        if let Some((problem_id, generation)) =
            db::ready_snapshot_matches_scan_by_code(db, code, &scan).await?
        {
            db::mark_local_verified(db, &problem_id, generation).await?;
            tracing::info!(
                code,
                problem_id,
                generation,
                "watcher verified no-op/restore event against READY snapshot"
            );
            return Ok(());
        }
    }
    let worker_id = format!("rust-watcher:{}", std::process::id());
    let Some((job_id, problem_id, generation, fencing_token, dirty_version)) =
        db::acquire_dirty_snapshot_job_by_code(db, code, &worker_id, WATCHER_LEASE_SECONDS).await?
    else {
        scan_orphan_now(root, db, code).await?;
        return Ok(());
    };
    let (lost_tx, mut lost_rx) = tokio::sync::watch::channel(false);
    let heartbeat_db = db.clone();
    let heartbeat_owner = worker_id.clone();
    let heartbeat = tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(WATCHER_LEASE_RENEW_SECONDS as u64)).await;
            match db::renew_job_lease(
                &heartbeat_db,
                job_id,
                &heartbeat_owner,
                fencing_token,
                WATCHER_LEASE_SECONDS,
            )
            .await
            {
                Ok(true) => {}
                Ok(false) | Err(_) => {
                    let _ = lost_tx.send(true);
                    break;
                }
            }
        }
    });

    let work = async {
        scan.problem_external_id = Some(problem_id.clone());
        db::assert_job_lease(db, job_id, &worker_id, fencing_token).await?;
        db::upsert_problem_usage(
            db,
            &problem_id,
            code,
            scan.logical_bytes,
            scan.allocated_bytes,
            scan.archive_bytes,
            scan.auxiliary_bytes,
            scan.file_count,
            "present",
        )
        .await?;
        db::assert_job_lease(db, job_id, &worker_id, fencing_token).await?;
        let mgr = SnapshotManager::new(db.clone(), store);
        let (snap, run_upload) = mgr
            .claim_snapshot(&problem_id, generation, fencing_token)
            .await?;
        if run_upload {
            mgr.run_snapshot_upload(
                snap.id,
                &problem_id,
                generation,
                fencing_token,
                Some(dirty_version),
                root,
                &scan,
                snap.created_at,
            )
            .await?;
        }
        let snap_id = snap.id;
        db::complete_job(
            db,
            job_id,
            &worker_id,
            fencing_token,
            serde_json::json!({"snapshot_id": snap_id, "generation": generation}),
        )
        .await?;
        Ok(())
    };

    let result: crate::error::AppResult<()> = tokio::select! {
        result = work => result,
        changed = lost_rx.changed() => {
            let _ = changed;
            Err(crate::error::AppError::FencingMismatch {
                expected: fencing_token,
                got: -1,
            })
        }
    };
    heartbeat.abort();
    if let Err(e) = &result {
        let _ = db::fail_job(
            db,
            job_id,
            &worker_id,
            fencing_token,
            "dirty_snapshot_failed",
            &e.to_string(),
        )
        .await;
    }
    result
}

async fn scan_orphan_now(root: &Path, db: &PgPool, code: &str) -> crate::error::AppResult<()> {
    tracing::info!(code, "dirty code is not in catalog; accounting as orphan");
    let scan = scanner::scan_problem_folder(root, code)?;
    db::upsert_discovered_usage(
        db,
        code,
        scan.logical_bytes,
        scan.allocated_bytes,
        scan.archive_bytes,
        scan.auxiliary_bytes,
        scan.file_count,
    )
    .await?;
    Ok(())
}

pub fn problem_codes_from_paths(root: &Path, paths: &[std::path::PathBuf]) -> Vec<String> {
    let mut codes = std::collections::BTreeSet::new();
    for path in paths {
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let mut parts = relative.iter();
        let Some(code) = parts.next().and_then(|s| s.to_str()) else {
            continue;
        };
        if !code.starts_with('.')
            && crate::paths::validate_problem_code(code).is_ok()
            && (parts.next().is_some() || root.join(code).is_dir())
        {
            codes.insert(code.to_string());
        }
    }
    codes.into_iter().collect()
}

pub fn problem_codes_from_event(root: &Path, event: &notify::Event) -> Vec<String> {
    let mut codes: std::collections::BTreeSet<String> =
        problem_codes_from_paths(root, &event.paths)
            .into_iter()
            .collect();
    if matches!(
        event.kind,
        EventKind::Remove(RemoveKind::Folder) | EventKind::Create(CreateKind::Folder)
    ) {
        for path in &event.paths {
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            if relative.components().count() != 1 {
                continue;
            }
            let Some(code) = relative.to_str() else {
                continue;
            };
            if !code.starts_with('.') && crate::paths::validate_problem_code(code).is_ok() {
                codes.insert(code.to_string());
            }
        }
    }
    codes.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::notify_judges;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn judge_notification_uses_control_endpoint() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 1024];
            let bytes = socket.read(&mut request).await.unwrap();
            assert!(std::str::from_utf8(&request[..bytes])
                .unwrap()
                .starts_with("POST /update/problems HTTP/1.1"));
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                .await
                .unwrap();
        });
        let endpoint = format!("http://{address}/update/problems");
        notify_judges(&reqwest::Client::new(), &[endpoint]).await;
        server.await.unwrap();
    }
}
