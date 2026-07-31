use std::path::Path;
use std::sync::Arc;

use crate::error::{AppError, AppResult};
use crate::models::{
    manifest_key, object_key_for_sha256, EvictResult, Manifest, ManifestFile, PresignResult,
    ScanResult, Snapshot,
};
use crate::paths;
use crate::r2::ObjectStore;
use crate::scanner;
use futures::{stream, StreamExt, TryStreamExt};
use sqlx::PgPool;

pub struct SnapshotManager {
    pub db: PgPool,
    pub store: Arc<dyn ObjectStore>,
    max_concurrent_uploads: usize,
}

pub fn gc_delete_timeline_is_safe(events: &[&str]) -> bool {
    let mut lock_held = false;
    let mut deleted = false;
    let mut ready = false;
    for event in events {
        match *event {
            "delete_lock" => lock_held = true,
            "delete_unlock" => lock_held = false,
            "delete_object" => {
                if ready {
                    return false;
                }
                deleted = true;
            }
            "finalize_ready" => {
                if lock_held {
                    return false;
                }
                if deleted {
                    return false;
                }
                ready = true;
            }
            _ => {}
        }
    }
    true
}

pub fn should_clear_dirty_after_snapshot(
    dirty: bool,
    dirty_generation: Option<i64>,
    dirty_version: i64,
    snapshot_generation: i64,
    expected_dirty_version: Option<i64>,
) -> bool {
    dirty
        && expected_dirty_version == Some(dirty_version)
        && dirty_generation.is_some_and(|generation| generation <= snapshot_generation)
}

impl SnapshotManager {
    pub fn new(db: PgPool, store: Arc<dyn ObjectStore>) -> Self {
        Self {
            db,
            store,
            max_concurrent_uploads: 1,
        }
    }

    pub fn with_max_concurrent_uploads(mut self, max_concurrent_uploads: usize) -> Self {
        self.max_concurrent_uploads = max_concurrent_uploads.max(1);
        self
    }

    pub async fn create_snapshot(
        &self,
        problem_id: &str,
        generation: i64,
        fencing_token: i64,
        expected_dirty_version: Option<i64>,
        problem_root: &Path,
        scan: &ScanResult,
    ) -> AppResult<Snapshot> {
        let requested_snapshot_id = uuid::Uuid::new_v4();
        let now = chrono::Utc::now();

        self.ensure_latest_fencing(problem_id, fencing_token)
            .await?;

        // A failed attempt must be retryable with the same generation. Reuse
        // only an error row; active, ready, and superseded generations remain
        // immutable and continue to reject concurrent writers.
        let snapshot_row = sqlx::query_as::<_, (uuid::Uuid, chrono::DateTime<chrono::Utc>)>(
            r#"INSERT INTO snapshots (id, problem_id, generation, state, file_count, total_bytes, created_at)
               VALUES ($1, $2, $3, 'discovered', 0, 0, $4)
               ON CONFLICT (problem_id, generation) DO UPDATE SET
                   state = 'discovered',
                   file_count = 0,
                   total_bytes = 0,
                   manifest_key = NULL,
                   error_code = NULL,
                   error_message = NULL,
                   completed_at = NULL
               WHERE snapshots.state = 'error'
               RETURNING snapshots.id, snapshots.created_at"#,
        )
        .bind(requested_snapshot_id)
        .bind(problem_id)
        .bind(generation)
        .bind(now)
        .fetch_optional(&self.db)
        .await?;
        let Some((snapshot_id, created_at)) = snapshot_row else {
            return Err(AppError::Internal(format!(
                "snapshot generation {generation} already exists for problem {problem_id}"
            )));
        };
        // Defensive cleanup for any future failure path that may have written
        // object identities before rolling the snapshot into the error state.
        sqlx::query("DELETE FROM snapshot_objects WHERE snapshot_id = $1")
            .bind(snapshot_id)
            .execute(&self.db)
            .await?;

        let result = self
            .create_snapshot_after_insert(
                snapshot_id,
                problem_id,
                generation,
                fencing_token,
                expected_dirty_version,
                problem_root,
                scan,
                created_at,
            )
            .await;
        if let Err(e) = &result {
            self.mark_snapshot_error(snapshot_id, e).await?;
        }
        result
    }

    #[allow(clippy::too_many_arguments)]
    async fn create_snapshot_after_insert(
        &self,
        snapshot_id: uuid::Uuid,
        problem_id: &str,
        generation: i64,
        fencing_token: i64,
        expected_dirty_version: Option<i64>,
        problem_root: &Path,
        scan: &ScanResult,
        now: chrono::DateTime<chrono::Utc>,
    ) -> AppResult<Snapshot> {
        sqlx::query(r#"UPDATE snapshots SET state = 'hashing' WHERE id = $1"#)
            .bind(snapshot_id)
            .execute(&self.db)
            .await?;

        let folder = paths::safe_problem_folder(problem_root, &scan.code)?;
        let mkey = manifest_key(problem_id, generation);
        let canonical_download_path =
            scanner::canonical_download_path_from_folder(&folder, &scan.files).ok_or_else(
                || {
                    AppError::ManifestIntegrity(
                        "problem folder must contain init.yml with an existing canonical archive"
                            .to_string(),
                    )
                },
            )?;
        self.prepare_snapshot_upload(snapshot_id, problem_id, scan, &mkey)
            .await?;

        let store = self.store.clone();
        let db = self.db.clone();
        let mut manifest_files: Vec<ManifestFile> = stream::iter(scan.files.clone())
            .map(|file| {
                let store = store.clone();
                let folder = folder.clone();
                let db = db.clone();
                async move { upload_manifest_file(db, snapshot_id, store, folder, file).await }
            })
            .buffer_unordered(self.max_concurrent_uploads)
            .try_collect()
            .await?;
        manifest_files.sort_by(|a, b| a.path.cmp(&b.path));
        let total_bytes: u64 = manifest_files
            .iter()
            .filter(|f| f.duplicate_of.is_none())
            .map(|f| f.size)
            .sum();

        sqlx::query(
            r#"UPDATE snapshots SET state = 'verifying' WHERE id = $1 AND state = 'uploading'"#,
        )
        .bind(snapshot_id)
        .execute(&self.db)
        .await?;

        let manifest = Manifest {
            schema_version: 3,
            problem_id: problem_id.to_string(),
            code: scan.code.clone(),
            generation,
            created_at: now,
            files: manifest_files.clone(),
            canonical_download_path: Some(canonical_download_path),
            total_bytes,
            file_count: manifest_files.len() as i64,
        };
        let manifest_json = serde_json::to_vec(&manifest)?;
        let manifest_sha = crate::hasher::sha256_bytes(&manifest_json);
        self.store
            .put_object(&mkey, manifest_json, &manifest_sha)
            .await?;
        if !self.store.verify_object(&mkey, &manifest_sha).await? {
            return Err(AppError::R2(format!(
                "manifest verification failed for {mkey}"
            )));
        }

        self.finalize_snapshot_cas(
            snapshot_id,
            problem_id,
            generation,
            fencing_token,
            expected_dirty_version,
            &manifest_files,
            manifest_files.len() as i64,
            total_bytes,
            &mkey,
        )
        .await?;

        Ok(Snapshot {
            id: snapshot_id,
            problem_id: problem_id.to_string(),
            generation,
            state: "ready".to_string(),
            file_count: manifest_files.len() as i64,
            total_bytes,
            manifest_key: Some(mkey),
            error_code: None,
            error_message: None,
            created_at: now,
            completed_at: Some(chrono::Utc::now()),
        })
    }

    async fn prepare_snapshot_upload(
        &self,
        snapshot_id: uuid::Uuid,
        problem_id: &str,
        scan: &ScanResult,
        manifest_key: &str,
    ) -> AppResult<()> {
        let mut tx = self.db.begin().await?;
        // Serialize claim creation with retention candidate selection. The
        // snapshot is already in an active state, so maintenance will skip it;
        // this lock closes the remaining mark-after-claim race.
        sqlx::query(
            "SELECT pg_advisory_xact_lock(hashtextextended('snapshot-retention:apply', 2907))",
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 2907))")
            .bind(problem_id)
            .execute(&mut *tx)
            .await?;

        let mut object_keys: Vec<String> = scan
            .files
            .iter()
            .map(|file| object_key_for_sha256(&file.sha256))
            .collect();
        object_keys.push(manifest_key.to_string());
        object_keys.sort_unstable();
        object_keys.dedup();
        for key in &object_keys {
            sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 2907))")
                .bind(key)
                .execute(&mut *tx)
                .await?;
        }
        // A content-addressed key may have been collected in an earlier
        // lifecycle and then uploaded again. Once this snapshot claims it,
        // any historical GC mark must be discarded and recreated only after
        // the new snapshot's retention window expires.
        sqlx::query("DELETE FROM gc_marks WHERE object_key = ANY($1)")
            .bind(&object_keys)
            .execute(&mut *tx)
            .await?;

        let uploading = sqlx::query(
            r#"UPDATE snapshots
               SET state = 'uploading', manifest_key = $2
               WHERE id = $1 AND state = 'hashing'"#,
        )
        .bind(snapshot_id)
        .bind(manifest_key)
        .execute(&mut *tx)
        .await?;
        if uploading.rows_affected() != 1 {
            return Err(AppError::Internal(
                "snapshot upload preparation CAS failed".to_string(),
            ));
        }

        for file in &scan.files {
            sqlx::query(
                r#"INSERT INTO snapshot_objects
                     (snapshot_id, sha256, rel_path, size_bytes, object_key, uploaded, verified)
                   VALUES ($1, $2, $3, $4, $5, false, false)
                   ON CONFLICT (snapshot_id, rel_path) DO UPDATE SET
                     sha256 = EXCLUDED.sha256,
                     size_bytes = EXCLUDED.size_bytes,
                     object_key = EXCLUDED.object_key,
                     uploaded = false,
                     verified = false"#,
            )
            .bind(snapshot_id)
            .bind(&file.sha256)
            .bind(&file.path)
            .bind(file.size as i64)
            .bind(object_key_for_sha256(&file.sha256))
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;
        Ok(())
    }

    async fn mark_snapshot_error(&self, snapshot_id: uuid::Uuid, err: &AppError) -> AppResult<()> {
        sqlx::query(
            r#"UPDATE snapshots
               SET state = 'error', error_code = $2, error_message = $3, completed_at = now()
               WHERE id = $1 AND state <> 'ready'"#,
        )
        .bind(snapshot_id)
        .bind(error_code(err))
        .bind(err.to_string())
        .execute(&self.db)
        .await?;
        Ok(())
    }

    async fn ensure_latest_fencing(&self, problem_id: &str, fencing_token: i64) -> AppResult<()> {
        let latest: Option<i64> =
            sqlx::query_scalar(r#"SELECT MAX(fencing_token) FROM jobs WHERE problem_id = $1"#)
                .bind(problem_id)
                .fetch_optional(&self.db)
                .await?;
        if latest.unwrap_or(0) > fencing_token {
            return Err(AppError::FencingMismatch {
                expected: fencing_token,
                got: latest.unwrap_or(0),
            });
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn finalize_snapshot_cas(
        &self,
        snapshot_id: uuid::Uuid,
        problem_id: &str,
        generation: i64,
        fencing_token: i64,
        expected_dirty_version: Option<i64>,
        manifest_files: &[ManifestFile],
        file_count: i64,
        total_bytes: u64,
        manifest_key: &str,
    ) -> AppResult<()> {
        let mut tx = self.db.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 2907))")
            .bind(problem_id)
            .execute(&mut *tx)
            .await?;
        ensure_latest_fencing_tx(&mut tx, problem_id, fencing_token).await?;
        let current: Option<i64> = sqlx::query_scalar(
            r#"SELECT snapshot_generation::BIGINT FROM problem_usage WHERE problem_id = $1 FOR UPDATE"#,
        )
        .bind(problem_id)
        .fetch_optional(&mut *tx)
        .await?
        .flatten();
        if let Some(current) = current {
            if current >= generation {
                return Err(AppError::FencingMismatch {
                    expected: generation,
                    got: current,
                });
            }
        }

        sqlx::query(
            r#"UPDATE snapshots
               SET state = 'superseded', superseded_at = now()
               WHERE problem_id = $1 AND state = 'ready' AND generation < $2"#,
        )
        .bind(problem_id)
        .bind(generation)
        .execute(&mut *tx)
        .await?;

        let ready = sqlx::query(
            r#"UPDATE snapshots
               SET state = 'ready', completed_at = now(),
                   file_count = $2, total_bytes = $3, manifest_key = $4
               WHERE id = $1 AND problem_id = $5 AND generation = $6 AND state = 'verifying'"#,
        )
        .bind(snapshot_id)
        .bind(file_count as i32)
        .bind(total_bytes as i64)
        .bind(manifest_key)
        .bind(problem_id)
        .bind(generation)
        .execute(&mut *tx)
        .await?;
        if ready.rows_affected() != 1 {
            return Err(AppError::Internal(
                "snapshot final CAS failed before READY".to_string(),
            ));
        }

        for file in manifest_files {
            sqlx::query(
                r#"INSERT INTO snapshot_objects
                     (snapshot_id, sha256, rel_path, size_bytes, object_key, uploaded, verified)
                   VALUES ($1, $2, $3, $4, $5, true, true)
                   ON CONFLICT (snapshot_id, rel_path) DO UPDATE SET
                     sha256 = EXCLUDED.sha256,
                     size_bytes = EXCLUDED.size_bytes,
                     object_key = EXCLUDED.object_key,
                     uploaded = true,
                     verified = true"#,
            )
            .bind(snapshot_id)
            .bind(&file.sha256)
            .bind(&file.path)
            .bind(file.size as i64)
            .bind(&file.object_key)
            .execute(&mut *tx)
            .await?;
        }

        let usage = sqlx::query(
            r#"UPDATE problem_usage
               SET r2_status = 'ready', snapshot_generation = $2,
                   observed_at = now(), stale = false
               WHERE problem_id = $1
                 AND (snapshot_generation IS NULL OR snapshot_generation < $2)"#,
        )
        .bind(problem_id)
        .bind(generation)
        .execute(&mut *tx)
        .await?;
        if usage.rows_affected() != 1 {
            return Err(AppError::Internal(
                "problem_usage generation CAS failed".to_string(),
            ));
        }
        if let Some(expected_dirty_version) = expected_dirty_version {
            sqlx::query(
                r#"UPDATE problems
                   SET dirty = false, dirty_generation = NULL, observed_at = now(), stale = false
                   WHERE external_id = $1
                     AND dirty = true
                     AND dirty_generation IS NOT NULL
                     AND dirty_generation <= $2
                     AND dirty_version = $3"#,
            )
            .bind(problem_id)
            .bind(generation)
            .bind(expected_dirty_version)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn restore_snapshot(
        &self,
        problem_id: &str,
        generation: i64,
        fencing_token: i64,
        dest: &Path,
    ) -> AppResult<()> {
        // Fencing: a stale worker must not overwrite local files after a newer job.
        let latest: Option<i64> =
            sqlx::query_scalar(r#"SELECT MAX(fencing_token) FROM jobs WHERE problem_id = $1"#)
                .bind(problem_id)
                .fetch_optional(&self.db)
                .await?;
        if latest.unwrap_or(0) > fencing_token {
            return Err(AppError::FencingMismatch {
                expected: fencing_token,
                got: latest.unwrap_or(0),
            });
        }

        let generation = self
            .resolve_ready_generation(problem_id, generation)
            .await?;
        let mkey = manifest_key(problem_id, generation);
        let manifest_bytes = match self.store.get_object(&mkey).await {
            Err(AppError::ObjectNotFound(_)) => {
                return Err(AppError::R2ManifestMissing {
                    problem_id: problem_id.to_string(),
                    generation,
                    key: mkey,
                });
            }
            result => result?,
        };
        let manifest: Manifest = serde_json::from_slice(&manifest_bytes)
            .map_err(|e| AppError::Internal(format!("manifest parse: {e}")))?;
        validate_manifest(&manifest, problem_id, generation)?;

        paths::validate_relative_path(
            dest.file_name()
                .and_then(|s| s.to_str())
                .unwrap_or_default(),
        )?;
        let parent = dest
            .parent()
            .ok_or_else(|| AppError::PathEscape(dest.display().to_string()))?;
        let staging = parent.join(format!(
            ".{}.restore.{}",
            dest.file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("problem"),
            uuid::Uuid::new_v4()
        ));
        if staging.exists() {
            tokio::fs::remove_dir_all(&staging)
                .await
                .map_err(AppError::Io)?;
        }
        tokio::fs::create_dir_all(&staging)
            .await
            .map_err(AppError::Io)?;

        let restore_result =
            materialize_manifest_files(self.store.as_ref(), &manifest, &staging).await;

        if let Err(e) = restore_result {
            let _ = tokio::fs::remove_dir_all(&staging).await;
            return Err(e);
        }

        // ClueOJ uploads use the same flock key. Only the short publication
        // phase is locked; downloading R2 objects into the hidden staging
        // directory does not block uploads.
        let _file_lock = paths::lock_problem_data(parent, problem_id)?;
        let mut tx = self.db.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 2907))")
            .bind(problem_id)
            .execute(&mut *tx)
            .await?;
        ensure_latest_fencing_tx(&mut tx, problem_id, fencing_token).await?;
        let ready: Option<i64> = sqlx::query_scalar(
            r#"SELECT generation::BIGINT FROM snapshots
               WHERE problem_id = $1 AND generation = $2 AND state = 'ready'
               FOR UPDATE"#,
        )
        .bind(problem_id)
        .bind(generation)
        .fetch_optional(&mut *tx)
        .await?;
        if ready.is_none() {
            let _ = tokio::fs::remove_dir_all(&staging).await;
            return Err(AppError::SnapshotNotReady {
                problem_id: problem_id.to_string(),
                generation,
            });
        }
        let dirty: bool =
            sqlx::query_scalar("SELECT dirty FROM problems WHERE external_id = $1 FOR UPDATE")
                .bind(problem_id)
                .fetch_one(&mut *tx)
                .await?;
        if dirty {
            let _ = tokio::fs::remove_dir_all(&staging).await;
            return Err(AppError::FileChurn(problem_id.to_string()));
        }
        if dest.exists() {
            let code = dest
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| AppError::PathEscape(dest.display().to_string()))?;
            let current_scan = crate::scanner::scan_problem_folder(parent, code)?;
            let matching =
                crate::db::ready_snapshot_matches_scan(&self.db, problem_id, &current_scan).await?;
            if matching != Some(generation) {
                let _ = tokio::fs::remove_dir_all(&staging).await;
                return Err(AppError::FileChurn(problem_id.to_string()));
            }
        }
        let old = parent.join(format!(
            ".{}.old.{}",
            dest.file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("problem"),
            uuid::Uuid::new_v4()
        ));
        if dest.exists() {
            tokio::fs::rename(dest, &old).await.map_err(AppError::Io)?;
        }
        if let Err(e) = tokio::fs::rename(&staging, dest).await {
            if old.exists() {
                let _ = tokio::fs::rename(&old, dest).await;
            }
            let _ = tokio::fs::remove_dir_all(&staging).await;
            return Err(AppError::Io(e));
        }
        sqlx::query(
            r#"UPDATE problem_usage
               SET local_status = 'present', observed_at = now(),
                   last_accessed_at = now(), stale = false
               WHERE problem_id = $1"#,
        )
        .bind(problem_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        if old.exists() {
            let _ = tokio::fs::remove_dir_all(&old).await;
        }
        tracing::info!(problem_id, generation, "snapshot restored");
        Ok(())
    }

    async fn resolve_ready_generation(&self, problem_id: &str, generation: i64) -> AppResult<i64> {
        if generation > 0 {
            return Ok(generation);
        }
        let latest: Option<i64> = sqlx::query_scalar(
            r#"SELECT generation::BIGINT FROM snapshots
               WHERE problem_id = $1 AND state = 'ready'
               ORDER BY generation DESC LIMIT 1"#,
        )
        .bind(problem_id)
        .fetch_optional(&self.db)
        .await?;
        latest.ok_or_else(|| AppError::R2NotReady(problem_id.to_string()))
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn evict_local(
        &self,
        problem_id: &str,
        problem_root: &Path,
        code: &str,
        dry_run: bool,
        force: bool,
        fencing_token: i64,
        idle_before: Option<chrono::DateTime<chrono::Utc>>,
    ) -> AppResult<EvictResult> {
        // Fencing: stale worker must not evict after a newer job mutated state.
        let latest: Option<i64> =
            sqlx::query_scalar(r#"SELECT MAX(fencing_token) FROM jobs WHERE problem_id = $1"#)
                .bind(problem_id)
                .fetch_optional(&self.db)
                .await?;
        if latest.unwrap_or(0) > fencing_token {
            return Err(AppError::FencingMismatch {
                expected: fencing_token,
                got: latest.unwrap_or(0),
            });
        }

        if !force && !dry_run {
            return Err(AppError::EvictionDryRunRequired);
        }

        let row = sqlx::query_scalar::<_, Option<i64>>(
            r#"SELECT snapshot_generation::BIGINT FROM problem_usage
               WHERE problem_id = $1 AND lower(r2_status) = 'ready'"#,
        )
        .bind(problem_id)
        .fetch_optional(&self.db)
        .await?;

        let gen = row
            .flatten()
            .ok_or(AppError::R2NotReady(problem_id.to_string()))?;

        let _file_lock = paths::lock_problem_data(problem_root, problem_id)?;
        let folder = paths::safe_problem_folder(problem_root, code)?;
        if !folder.exists() {
            return Ok(EvictResult {
                problem_id: problem_id.to_string(),
                dry_run,
                freed_bytes: 0,
                files_removed: 0,
                preserved_init_yml: false,
            });
        }
        let scan = crate::scanner::scan_problem_folder(problem_root, code)?;
        let matching = crate::db::ready_snapshot_matches_scan(&self.db, problem_id, &scan).await?;
        if matching != Some(gen) {
            return Err(AppError::EvictionDirty);
        }
        let freed = scan.logical_bytes;
        let removed = scan.file_count;
        if dry_run {
            return Ok(EvictResult {
                problem_id: problem_id.to_string(),
                dry_run: true,
                freed_bytes: freed,
                files_removed: removed,
                preserved_init_yml: false,
            });
        } else {
            let mut tx = self.db.begin().await?;
            sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 2907))")
                .bind(problem_id)
                .execute(&mut *tx)
                .await?;
            ensure_latest_fencing_tx(&mut tx, problem_id, fencing_token).await?;
            let current =
                sqlx::query_as::<_, (Option<i64>, bool, Option<chrono::DateTime<chrono::Utc>>)>(
                    r#"SELECT pu.snapshot_generation::BIGINT, p.dirty, pu.last_accessed_at
                   FROM problem_usage pu
                   JOIN problems p ON p.external_id = pu.problem_id
                   WHERE pu.problem_id = $1 AND lower(pu.r2_status) = 'ready'
                   FOR UPDATE OF pu, p"#,
                )
                .bind(problem_id)
                .fetch_optional(&mut *tx)
                .await?;
            let Some((current_generation, dirty, last_accessed_at)) = current else {
                return Err(AppError::R2NotReady(problem_id.to_string()));
            };
            if current_generation != Some(gen) {
                return Err(AppError::R2NotReady(problem_id.to_string()));
            }
            if dirty {
                return Err(AppError::EvictionDirty);
            }
            if idle_before.is_some_and(|cutoff| {
                last_accessed_at.is_some_and(|last_access| last_access > cutoff)
            }) {
                return Err(AppError::EvictionRecentlyAccessed);
            }

            let staging = folder.with_file_name(format!(
                ".{}.evict.{}",
                folder
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("problem"),
                uuid::Uuid::new_v4()
            ));
            tokio::fs::rename(&folder, &staging)
                .await
                .map_err(AppError::Io)?;
            let updated = sqlx::query(
                r#"UPDATE problem_usage
                   SET local_status = 'missing', observed_at = NOW(), stale = false
                   WHERE problem_id = $1
                     AND snapshot_generation = $2
                     AND lower(r2_status) = 'ready'"#,
            )
            .bind(problem_id)
            .bind(gen)
            .execute(&mut *tx)
            .await;
            if let Err(err) = updated {
                let _ = tokio::fs::rename(&staging, &folder).await;
                return Err(AppError::Database(err));
            }
            if let Err(err) = tx.commit().await {
                let _ = tokio::fs::rename(&staging, &folder).await;
                return Err(AppError::Database(err));
            }
            if let Err(err) = tokio::fs::remove_dir_all(&staging).await {
                tracing::warn!(error = %err, path = ?staging, "evicted staging cleanup failed");
            }
        }

        Ok(EvictResult {
            problem_id: problem_id.to_string(),
            dry_run,
            freed_bytes: freed,
            files_removed: removed,
            preserved_init_yml: false,
        })
    }

    pub async fn presign_download(
        &self,
        problem_id: &str,
        ttl: Option<std::time::Duration>,
    ) -> AppResult<PresignResult> {
        let gen = self.resolve_ready_generation(problem_id, 0).await?;

        let mkey = manifest_key(problem_id, gen);
        let manifest_bytes = self.store.get_object(&mkey).await?;
        let manifest: Manifest = serde_json::from_slice(&manifest_bytes)
            .map_err(|e| AppError::Internal(format!("manifest parse: {e}")))?;
        validate_manifest(&manifest, problem_id, gen)?;

        presign_canonical_from_manifest(self.store.as_ref(), &manifest, ttl).await
    }

    pub async fn delete_object(&self, object_key: &str, fencing_token: i64) -> AppResult<bool> {
        paths::validate_managed_object_key(object_key)?;
        let mut conn = self.db.acquire().await?;
        sqlx::query("SELECT pg_advisory_lock(hashtextextended($1, 2907))")
            .bind(object_key)
            .execute(&mut *conn)
            .await?;
        let result = self
            .delete_object_while_locked(&mut conn, object_key, fencing_token)
            .await;
        let _ = sqlx::query("SELECT pg_advisory_unlock(hashtextextended($1, 2907))")
            .bind(object_key)
            .execute(&mut *conn)
            .await;
        result
    }

    async fn delete_object_while_locked(
        &self,
        conn: &mut sqlx::pool::PoolConnection<sqlx::Postgres>,
        object_key: &str,
        fencing_token: i64,
    ) -> AppResult<bool> {
        ensure_current_gc_fencing_conn(conn, fencing_token).await?;
        ensure_no_live_refs_conn(conn, object_key).await?;
        let meta = self.store.head_object(object_key).await?;
        if !meta.exists {
            return Ok(false);
        }
        ensure_current_gc_fencing_conn(conn, fencing_token).await?;
        ensure_no_live_refs_conn(conn, object_key).await?;
        self.store.delete_object(object_key).await?;
        ensure_current_gc_fencing_conn(conn, fencing_token).await?;
        ensure_no_live_refs_conn(conn, object_key).await?;
        Ok(true)
    }
}

/// Materialize a verified manifest into an empty staging directory.
///
/// Regular files are downloaded once, hardlink entries are recreated from
/// their manifest source, and safe relative symlinks are restored without
/// following them. Permission bits are restored after regular content is
/// durable; ownership deliberately remains that of the storage runtime.
pub async fn materialize_manifest_files(
    store: &dyn ObjectStore,
    manifest: &Manifest,
    staging: &Path,
) -> AppResult<()> {
    for file in manifest
        .files
        .iter()
        .filter(|file| file.duplicate_of.is_none() && file.symlink_target.is_none())
    {
        paths::validate_relative_path(&file.path)?;
        let target = paths::safe_join(staging, &file.path)?;
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(AppError::Io)?;
        }
        let file_name = target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("file");
        let tmp = target.with_file_name(format!(".{file_name}.restore.{}", uuid::Uuid::new_v4()));
        let actual = match store.get_object_to_path(&file.object_key, &tmp).await {
            Err(AppError::ObjectNotFound(_)) => {
                return Err(AppError::R2ObjectMissing {
                    path: file.path.clone(),
                    key: file.object_key.clone(),
                });
            }
            result => result?,
        };
        if actual != file.sha256 {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(AppError::ChecksumMismatch {
                expected: file.sha256.clone(),
                got: actual,
            });
        }
        tokio::fs::rename(&tmp, &target)
            .await
            .map_err(AppError::Io)?;
        restore_mode(&target, file.mode).await?;
    }

    for file in manifest
        .files
        .iter()
        .filter(|file| file.duplicate_of.is_some() && file.symlink_target.is_none())
    {
        paths::validate_relative_path(&file.path)?;
        let source_path = file.duplicate_of.as_deref().ok_or_else(|| {
            AppError::ManifestIntegrity(format!("hardlink source missing for {}", file.path))
        })?;
        paths::validate_relative_path(source_path)?;
        let source_manifest = manifest
            .files
            .iter()
            .find(|candidate| candidate.path == source_path)
            .ok_or_else(|| {
                AppError::ManifestIntegrity(format!(
                    "hardlink source {source_path} missing for {}",
                    file.path
                ))
            })?;
        if source_manifest.duplicate_of.is_some()
            || source_manifest.symlink_target.is_some()
            || source_manifest.sha256 != file.sha256
            || source_manifest.size != file.size
        {
            return Err(AppError::ManifestIntegrity(format!(
                "hardlink source metadata mismatch for {}",
                file.path
            )));
        }
        let source = paths::safe_join(staging, source_path)?;
        let target = paths::safe_join(staging, &file.path)?;
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(AppError::Io)?;
        }
        tokio::fs::hard_link(&source, &target)
            .await
            .map_err(AppError::Io)?;
        restore_mode(&target, file.mode).await?;
    }

    for file in manifest
        .files
        .iter()
        .filter(|file| file.symlink_target.is_some())
    {
        paths::validate_relative_path(&file.path)?;
        let link_target = file.symlink_target.as_deref().ok_or_else(|| {
            AppError::ManifestIntegrity(format!("symlink target missing for {}", file.path))
        })?;
        paths::validate_symlink_target(&file.path, link_target)?;
        let object = match store.get_object(&file.object_key).await {
            Err(AppError::ObjectNotFound(_)) => {
                return Err(AppError::R2ObjectMissing {
                    path: file.path.clone(),
                    key: file.object_key.clone(),
                });
            }
            result => result?,
        };
        let actual = crate::hasher::sha256_bytes(&object);
        if actual != file.sha256 || object.as_ref() != link_target.as_bytes() {
            return Err(AppError::ChecksumMismatch {
                expected: file.sha256.clone(),
                got: actual,
            });
        }
        let target = paths::safe_join(staging, &file.path)?;
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(AppError::Io)?;
        }
        create_symlink(link_target, &target)?;
    }
    Ok(())
}

#[cfg(unix)]
fn create_symlink(link_target: &str, path: &Path) -> AppResult<()> {
    std::os::unix::fs::symlink(link_target, path).map_err(AppError::Io)
}

#[cfg(not(unix))]
fn create_symlink(_link_target: &str, path: &Path) -> AppResult<()> {
    Err(AppError::SpecialFile(format!(
        "symlink restore unsupported on this platform: {}",
        path.display()
    )))
}

#[cfg(unix)]
async fn restore_mode(path: &Path, mode: u32) -> AppResult<()> {
    use std::os::unix::fs::PermissionsExt;
    if mode == 0 {
        return Ok(());
    }
    let permissions = std::fs::Permissions::from_mode(mode & 0o777);
    tokio::fs::set_permissions(path, permissions)
        .await
        .map_err(AppError::Io)
}

#[cfg(not(unix))]
async fn restore_mode(_path: &Path, _mode: u32) -> AppResult<()> {
    Ok(())
}

pub async fn presign_canonical_from_manifest(
    store: &dyn ObjectStore,
    manifest: &Manifest,
    ttl: Option<std::time::Duration>,
) -> AppResult<PresignResult> {
    let canonical = manifest
        .canonical_download_path
        .as_deref()
        .ok_or_else(|| AppError::ObjectNotFound("canonical download artifact".into()))?;
    let archive = manifest
        .files
        .iter()
        .find(|f| f.path == canonical)
        .ok_or_else(|| AppError::ObjectNotFound("canonical download artifact".into()))?;

    let filename = std::path::Path::new(&archive.path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".to_string());

    let meta = store.head_object(&archive.object_key).await?;
    if !meta.exists || meta.size != archive.size {
        return Err(AppError::R2NotReady(manifest.problem_id.clone()));
    }
    match meta.sha256.as_deref() {
        Some(sha) if sha == archive.sha256 => {}
        Some(sha) => {
            return Err(AppError::ChecksumMismatch {
                expected: archive.sha256.clone(),
                got: sha.to_string(),
            });
        }
        None => return Err(AppError::R2NotReady(manifest.problem_id.clone())),
    }

    store.presign_get(&archive.object_key, &filename, ttl).await
}

async fn upload_manifest_file(
    db: PgPool,
    snapshot_id: uuid::Uuid,
    store: Arc<dyn ObjectStore>,
    folder: std::path::PathBuf,
    file: crate::models::FileEntry,
) -> AppResult<ManifestFile> {
    paths::validate_relative_path(&file.path)?;
    let abs = paths::safe_join(&folder, &file.path)?;
    let symlink_bytes = file
        .symlink_target
        .as_ref()
        .map(|target| target.as_bytes().to_vec());
    if let Some(target) = file.symlink_target.as_deref() {
        paths::validate_symlink_target(&file.path, target)?;
    }
    let stable_sha = if let Some(bytes) = symlink_bytes.as_deref() {
        crate::hasher::sha256_bytes(bytes)
    } else {
        crate::hasher::stable_sha256_file(&abs, 2)?
    };
    if stable_sha != file.sha256 {
        return Err(AppError::ChecksumMismatch {
            expected: file.sha256,
            got: stable_sha,
        });
    }
    let object_key = object_key_for_sha256(&stable_sha);
    let meta = store.head_object(&object_key).await?;
    if meta.exists {
        if !store.verify_object(&object_key, &stable_sha).await? {
            return Err(AppError::ChecksumMismatch {
                expected: stable_sha,
                got: format!("existing object differs at {object_key}"),
            });
        }
    } else {
        if let Some(bytes) = symlink_bytes {
            store.put_object(&object_key, bytes, &stable_sha).await?;
        } else {
            store
                .put_object_from_path(&object_key, &abs, &stable_sha)
                .await?;
        }
        if !store.verify_object(&object_key, &stable_sha).await? {
            return Err(AppError::ChecksumMismatch {
                expected: stable_sha,
                got: "uploaded object verification failed".to_string(),
            });
        }
    }
    let updated = sqlx::query(
        r#"UPDATE snapshot_objects
           SET sha256 = $3, size_bytes = $4, object_key = $5,
               uploaded = true, verified = true
           WHERE snapshot_id = $1 AND rel_path = $2"#,
    )
    .bind(snapshot_id)
    .bind(&file.path)
    .bind(&stable_sha)
    .bind(file.size as i64)
    .bind(&object_key)
    .execute(&db)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(AppError::Internal(format!(
            "snapshot object claim missing for {}",
            file.path
        )));
    }
    Ok(ManifestFile {
        path: file.path,
        sha256: stable_sha,
        size: file.size,
        allocated_bytes: file.allocated_bytes,
        mode: file.mode,
        dev: file.dev,
        ino: file.ino,
        nlink: file.nlink,
        duplicate_of: file.duplicate_of,
        symlink_target: file.symlink_target,
        object_key,
    })
}

async fn ensure_latest_fencing_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    problem_id: &str,
    fencing_token: i64,
) -> AppResult<()> {
    let latest: Option<i64> =
        sqlx::query_scalar(r#"SELECT MAX(fencing_token) FROM jobs WHERE problem_id = $1"#)
            .bind(problem_id)
            .fetch_optional(&mut **tx)
            .await?;
    if latest.unwrap_or(0) > fencing_token {
        return Err(AppError::FencingMismatch {
            expected: fencing_token,
            got: latest.unwrap_or(0),
        });
    }
    Ok(())
}

async fn ensure_no_live_refs_conn(
    conn: &mut sqlx::pool::PoolConnection<sqlx::Postgres>,
    object_key: &str,
) -> AppResult<()> {
    let refs: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(DISTINCT s.id)
           FROM snapshot_objects so
           JOIN snapshots s ON s.id = so.snapshot_id
           WHERE so.object_key = $1
             AND snapshot_is_gc_protected(
               s.state, s.superseded_at, s.completed_at
             )"#,
    )
    .bind(object_key)
    .fetch_one(&mut **conn)
    .await?;
    if refs > 0 {
        return Err(AppError::ObjectLiveReference(object_key.to_string()));
    }
    let manifest_refs: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM snapshots
           WHERE manifest_key = $1
             AND snapshot_is_gc_protected(
               state, superseded_at, completed_at
             )"#,
    )
    .bind(object_key)
    .fetch_one(&mut **conn)
    .await?;
    if manifest_refs > 0 {
        return Err(AppError::ObjectLiveReference(object_key.to_string()));
    }
    Ok(())
}

async fn ensure_current_gc_fencing_conn(
    conn: &mut sqlx::pool::PoolConnection<sqlx::Postgres>,
    fencing_token: i64,
) -> AppResult<()> {
    let latest: Option<i64> = sqlx::query_scalar(
        r#"SELECT MAX(fencing_token)
           FROM jobs
           WHERE problem_id IS NULL AND job_type = 'gc_collect'"#,
    )
    .fetch_optional(&mut **conn)
    .await?;
    if latest.unwrap_or(0) > fencing_token {
        return Err(AppError::FencingMismatch {
            expected: fencing_token,
            got: latest.unwrap_or(0),
        });
    }
    Ok(())
}

fn error_code(err: &AppError) -> &'static str {
    match err {
        AppError::ChecksumMismatch { .. } => "checksum_mismatch",
        AppError::FileChurn(_) => "file_churn",
        AppError::FencingMismatch { .. } => "fencing_mismatch",
        AppError::R2(_) => "r2_error",
        AppError::R2ManifestMissing { .. } => "r2_manifest_missing",
        AppError::R2ObjectMissing { .. } | AppError::ObjectNotFound(_) => "r2_object_missing",
        AppError::ManifestIntegrity(_) => "manifest_integrity",
        AppError::PathEscape(_) => "path_escape",
        AppError::SpecialFile(_) => "special_file",
        _ => "internal_error",
    }
}

fn validate_manifest(manifest: &Manifest, problem_id: &str, generation: i64) -> AppResult<()> {
    if manifest.schema_version == 0 || manifest.schema_version > 3 {
        return Err(AppError::ManifestIntegrity(format!(
            "unsupported schema_version {}",
            manifest.schema_version
        )));
    }
    if manifest.problem_id != problem_id || manifest.generation != generation {
        return Err(AppError::ManifestIntegrity(format!(
            "manifest identity mismatch: {}:{} expected {problem_id}:{generation}",
            manifest.problem_id, manifest.generation
        )));
    }
    let mut paths_seen = std::collections::HashSet::new();
    let mut files_by_path = std::collections::HashSet::new();
    let mut logical = 0u64;
    for file in &manifest.files {
        paths::validate_relative_path(&file.path)?;
        if !paths_seen.insert(file.path.as_str()) {
            return Err(AppError::ManifestIntegrity(format!(
                "duplicate path {}",
                file.path
            )));
        }
        if file.object_key != object_key_for_sha256(&file.sha256) {
            return Err(AppError::ManifestIntegrity(format!(
                "object key mismatch for {}",
                file.path
            )));
        }
        if let Some(target) = file.symlink_target.as_deref() {
            if manifest.schema_version < 3 || file.duplicate_of.is_some() {
                return Err(AppError::ManifestIntegrity(format!(
                    "invalid symlink metadata for {}",
                    file.path
                )));
            }
            paths::validate_symlink_target(&file.path, target)?;
            let target_sha = crate::hasher::sha256_bytes(target.as_bytes());
            if file.sha256 != target_sha || file.size != target.len() as u64 {
                return Err(AppError::ManifestIntegrity(format!(
                    "symlink metadata mismatch for {}",
                    file.path
                )));
            }
        }
        if file.duplicate_of.is_none() {
            logical += file.size;
        }
        files_by_path.insert(file.path.as_str());
    }
    if manifest.file_count != manifest.files.len() as i64 || manifest.total_bytes != logical {
        return Err(AppError::ManifestIntegrity(
            "manifest counts do not match file list".to_string(),
        ));
    }
    if let Some(canonical) = &manifest.canonical_download_path {
        paths::validate_relative_path(canonical)?;
        if !files_by_path.contains(canonical.as_str()) {
            return Err(AppError::ManifestIntegrity(format!(
                "canonical artifact missing: {canonical}"
            )));
        }
        if manifest
            .files
            .iter()
            .any(|file| file.path == *canonical && file.symlink_target.is_some())
        {
            return Err(AppError::ManifestIntegrity(
                "canonical artifact cannot be a symlink".to_string(),
            ));
        }
    }
    Ok(())
}
