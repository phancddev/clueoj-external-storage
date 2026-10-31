use std::path::Path;
use std::sync::Arc;

use sqlx::PgPool;

use crate::db;
use crate::error::AppResult;
use crate::models::ReconcileResult;
use crate::scanner;

pub async fn reconcile_catalog(
    root: &Path,
    db: &PgPool,
    known: Vec<(String, String)>,
) -> AppResult<ReconcileResult> {
    let folders = scanner::list_problem_codes(root)?;
    let catalog: Vec<db::CatalogProblem> = known
        .into_iter()
        .map(|(external_id, code)| db::CatalogProblem {
            external_id,
            code,
            catalog_state: "present".to_string(),
        })
        .collect();
    let plan = build_reconcile_plan(&folders, &catalog);
    apply_reconcile_plan(root, db, plan).await
}

pub async fn full_reconcile(root: Arc<Path>, db: PgPool, interval: std::time::Duration) {
    loop {
        tracing::info!("running full reconcile");
        if let Err(e) = run_full_reconcile_once(root.as_ref(), &db).await {
            tracing::error!(error = %e, "full reconcile failed");
        }
        tracing::info!("full reconcile complete");
        tokio::time::sleep(interval).await;
    }
}

pub async fn run_full_reconcile_once(root: &Path, db: &PgPool) -> AppResult<ReconcileResult> {
    let folders = scanner::list_problem_codes(root)?;
    let catalog = db::list_catalog_problems(db).await?;
    let plan = build_reconcile_plan(&folders, &catalog);
    let healed = db::heal_usage_ready_projection(db).await?;
    if healed > 0 {
        tracing::info!(healed, "healed stale r2 ready projections");
    }
    apply_reconcile_plan(root, db, plan).await
}

async fn apply_reconcile_plan(
    root: &Path,
    db: &PgPool,
    plan: ReconcilePlan,
) -> AppResult<ReconcileResult> {
    let mut reused = 0usize;
    let mut scanned = 0usize;
    for item in &plan.known_present {
        db::remove_orphan_projection_for_code(db, &item.code).await?;
        if cached_usage_matches(root, db, &item.code, Some(&item.external_id)).await? {
            reused += 1;
            continue;
        }
        db::invalidate_tree_cache(db, &item.code).await?;
        let before = scanner::tree_fingerprint(root, &item.code)?;
        let scan = scanner::scan_problem_folder(root, &item.code)?;
        scanned += 1;
        db::upsert_problem_usage(
            db,
            &item.external_id,
            &item.code,
            scan.logical_bytes,
            scan.allocated_bytes,
            scan.archive_bytes,
            scan.auxiliary_bytes,
            scan.file_count,
            "present",
        )
        .await?;
        cache_stable_scan(root, db, &item.code, &before, &scan).await?;
    }

    for item in &plan.missing_known {
        db::upsert_missing_usage(db, &item.external_id).await?;
    }

    for code in &plan.orphans {
        if cached_usage_matches(root, db, code, None).await? {
            reused += 1;
            continue;
        }
        db::invalidate_tree_cache(db, code).await?;
        let before = scanner::tree_fingerprint(root, code)?;
        if let Ok(scan) = scanner::scan_problem_folder(root, code) {
            scanned += 1;
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
            cache_stable_scan(root, db, code, &before, &scan).await?;
        }
    }

    tracing::info!(reused, scanned, "problem reconciliation scan summary");

    Ok(ReconcileResult {
        discovered: plan.known_present.len() as i64,
        missing: plan.missing_known.len() as i64,
        orphans: plan.orphans.len() as i64,
        mirrors: 0,
        orphan_codes: plan.orphans,
        missing_codes: plan
            .missing_known
            .into_iter()
            .map(|item| item.code)
            .collect(),
    })
}

async fn cached_usage_matches(
    root: &Path,
    db: &PgPool,
    code: &str,
    id: Option<&str>,
) -> AppResult<bool> {
    let Some((_, _, accounted)) = db::cached_tree(db, code).await? else {
        return Ok(false);
    };
    let Some(saved) = accounted else {
        return Ok(false);
    };
    let current = scanner::tree_fingerprint(root, code)?;
    Ok(saved == current && db::usage_is_current(db, code, id).await?)
}

async fn cache_stable_scan(
    root: &Path,
    db: &PgPool,
    code: &str,
    before: &str,
    scan: &crate::models::ScanResult,
) -> AppResult<()> {
    let after = scanner::tree_fingerprint(root, code)?;
    if before == after {
        let folder = crate::paths::safe_problem_folder(root, code)?;
        let canonical = scanner::canonical_download_path_from_folder(&folder, &scan.files);
        db::cache_tree(db, code, before, canonical.as_deref(), true).await?;
    } else {
        tracing::warn!(
            code,
            "problem changed during reconciliation; cache not updated"
        );
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconcilePlan {
    pub known_present: Vec<db::CatalogProblem>,
    pub missing_known: Vec<db::CatalogProblem>,
    pub orphans: Vec<String>,
}

pub fn build_reconcile_plan(folders: &[String], catalog: &[db::CatalogProblem]) -> ReconcilePlan {
    let folder_set: std::collections::HashSet<&str> = folders.iter().map(String::as_str).collect();
    let active_catalog: Vec<&db::CatalogProblem> = catalog
        .iter()
        .filter(|p| is_active_catalog_state(&p.catalog_state))
        .collect();
    let by_code: std::collections::HashMap<&str, &db::CatalogProblem> = active_catalog
        .iter()
        .map(|p| (p.code.as_str(), *p))
        .collect();

    let mut known_present = Vec::new();
    let mut missing_known = Vec::new();
    let mut orphans = Vec::new();

    for folder in folders {
        if let Some(problem) = by_code.get(folder.as_str()) {
            known_present.push((*problem).clone());
        } else {
            orphans.push(folder.clone());
        }
    }
    for problem in active_catalog {
        if !folder_set.contains(problem.code.as_str()) {
            missing_known.push((*problem).clone());
        }
    }
    known_present.sort_by(|a, b| a.code.cmp(&b.code));
    missing_known.sort_by(|a, b| a.code.cmp(&b.code));
    orphans.sort();
    ReconcilePlan {
        known_present,
        missing_known,
        orphans,
    }
}

pub fn is_active_catalog_state(state: &str) -> bool {
    matches!(state, "present" | "mirror")
}
