use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{de, Deserialize, Deserializer, Serialize};
use sqlx::PgPool;

use crate::error::{AppError, AppResult};
use crate::models::{EvictResult, PresignResult, ReconcileResult, ScanResult, Snapshot, Volume};
use crate::paths;
use crate::r2::ObjectStore;
use crate::reconcile;
use crate::scanner;
use crate::snapshot::SnapshotManager;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub problem_root: Arc<std::path::Path>,
    pub store: Arc<dyn ObjectStore>,
    pub internal_token: String,
    pub eviction_enabled: bool,
    pub max_concurrent_uploads: usize,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/internal/health", get(health))
        .route("/internal/ready", get(ready))
        .route("/internal/volumes", get(get_volumes))
        .route("/internal/scan", post(scan))
        .route("/internal/snapshot", post(create_snapshot))
        .route("/internal/restore", post(restore))
        .route("/internal/evict", post(evict))
        .route("/internal/objects:delete", post(delete_object))
        .route("/internal/reconcile", post(reconcile_catalog))
        .route("/internal/problems/:code/usage", get(get_problem_usage))
        .route("/internal/presign", post(presign_download))
        .with_state(state)
}

fn check_token(headers: &HeaderMap, expected: &str) -> AppResult<()> {
    if expected.is_empty() {
        return Ok(());
    }
    let token = headers
        .get("x-internal-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if token != expected {
        return Err(AppError::Unauthorized);
    }
    Ok(())
}

async fn health(State(_s): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({"status": "ok", "version": env!("CARGO_PKG_VERSION")}))
}

async fn ready(
    State(s): State<AppState>,
    Query(query): Query<ReadyQuery>,
    headers: HeaderMap,
) -> AppResult<Json<serde_json::Value>> {
    check_token(&headers, &s.internal_token)?;
    sqlx::query("SELECT 1").execute(&s.db).await?;
    if query.problem_external_id.is_some() || query.code.is_some() {
        let problem_external_id = query
            .problem_external_id
            .ok_or_else(|| AppError::PathEscape("problem_external_id".to_string()))?;
        let code = query
            .code
            .ok_or_else(|| AppError::PathEscape("code".to_string()))?;
        let result = problem_readiness(&s, &problem_external_id, &code).await?;
        return Ok(Json(serde_json::to_value(result)?));
    }
    s.store.health_check().await?;
    Ok(Json(serde_json::json!({"status": "ready"})))
}

#[derive(Deserialize)]
struct ReadyQuery {
    problem_external_id: Option<String>,
    code: Option<String>,
}

#[derive(Serialize)]
struct ProblemReadyResponse {
    ready: bool,
    local_status: String,
    generation: Option<i64>,
    observed_at: chrono::DateTime<chrono::Utc>,
}

async fn problem_readiness(
    s: &AppState,
    problem_external_id: &str,
    code: &str,
) -> AppResult<ProblemReadyResponse> {
    let folder = paths::safe_problem_folder(s.problem_root.as_ref(), code)?;
    if !folder.exists() {
        let generation: Option<i64> = sqlx::query_scalar(
            r#"SELECT generation::BIGINT FROM snapshots
               WHERE problem_id = $1 AND state = 'ready'
               ORDER BY generation DESC LIMIT 1"#,
        )
        .bind(problem_external_id)
        .fetch_optional(&s.db)
        .await?;
        return Ok(ProblemReadyResponse {
            ready: false,
            local_status: "missing".to_string(),
            generation,
            observed_at: chrono::Utc::now(),
        });
    }
    if !folder.is_dir() {
        return Ok(ProblemReadyResponse {
            ready: false,
            local_status: "partial".to_string(),
            generation: None,
            observed_at: chrono::Utc::now(),
        });
    }
    let scan = match scanner::scan_problem_folder(s.problem_root.as_ref(), code) {
        Ok(scan) => scan,
        Err(_) => {
            return Ok(ProblemReadyResponse {
                ready: false,
                local_status: "partial".to_string(),
                generation: None,
                observed_at: chrono::Utc::now(),
            });
        }
    };
    let canonical = scanner::canonical_download_path_from_folder(&folder, &scan.files);
    let matched_generation = if canonical.is_some() {
        crate::db::ready_snapshot_matches_scan(&s.db, problem_external_id, &scan).await?
    } else {
        None
    };
    let latest_generation: Option<i64> = sqlx::query_scalar(
        r#"SELECT generation::BIGINT FROM snapshots
           WHERE problem_id = $1 AND state = 'ready'
           ORDER BY generation DESC LIMIT 1"#,
    )
    .bind(problem_external_id)
    .fetch_optional(&s.db)
    .await?;
    Ok(ProblemReadyResponse {
        ready: matched_generation.is_some(),
        local_status: if matched_generation.is_some() {
            "present".to_string()
        } else {
            "partial".to_string()
        },
        generation: matched_generation.or(latest_generation),
        observed_at: chrono::Utc::now(),
    })
}

async fn get_volumes(State(s): State<AppState>, headers: HeaderMap) -> AppResult<Json<Volume>> {
    check_token(&headers, &s.internal_token)?;
    let vol = scanner::scan_volume(s.problem_root.as_ref())?;
    Ok(Json(vol))
}

#[derive(Deserialize)]
struct ScanReq {
    code: String,
    problem_external_id: Option<String>,
}

async fn scan(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ScanReq>,
) -> AppResult<Json<ScanResult>> {
    check_token(&headers, &s.internal_token)?;
    let mut result = scanner::scan_problem_folder(s.problem_root.as_ref(), &req.code)?;
    result.problem_external_id = req.problem_external_id.clone();
    if let Some(pid) = &req.problem_external_id {
        let _ = crate::db::upsert_problem_usage(
            &s.db,
            pid,
            &req.code,
            result.logical_bytes,
            result.allocated_bytes,
            result.archive_bytes,
            result.auxiliary_bytes,
            result.file_count,
            "present",
        )
        .await;
    }
    Ok(Json(result))
}

#[derive(Deserialize)]
struct SnapshotReq {
    problem_external_id: String,
    generation: i64,
    code: String,
    fencing_token: i64,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_i64_string_or_number"
    )]
    dirty_version: Option<i64>,
}

fn deserialize_optional_i64_string_or_number<'de, D>(
    deserializer: D,
) -> Result<Option<i64>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum DirtyVersionWire {
        Number(i64),
        String(String),
    }

    match Option::<DirtyVersionWire>::deserialize(deserializer)? {
        None => Ok(None),
        Some(DirtyVersionWire::Number(value)) => Ok(Some(value)),
        Some(DirtyVersionWire::String(value)) => {
            if value.is_empty() {
                return Err(de::Error::custom("dirty_version decimal string is empty"));
            }
            value
                .parse::<i64>()
                .map(Some)
                .map_err(|_| de::Error::custom("dirty_version must be a decimal i64 string"))
        }
    }
}

async fn create_snapshot(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<SnapshotReq>,
) -> AppResult<Json<Snapshot>> {
    check_token(&headers, &s.internal_token)?;
    let scan = scanner::scan_problem_folder(s.problem_root.as_ref(), &req.code)?;
    let mgr = SnapshotManager::new(s.db.clone(), s.store.clone())
        .with_max_concurrent_uploads(s.max_concurrent_uploads);
    let snap = mgr
        .create_snapshot(
            &req.problem_external_id,
            req.generation,
            req.fencing_token,
            req.dirty_version,
            s.problem_root.as_ref(),
            &scan,
        )
        .await?;
    Ok(Json(snap))
}

#[derive(Deserialize)]
struct RestoreReq {
    problem_external_id: String,
    generation: i64,
    dest: String,
    fencing_token: i64,
}

async fn restore(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<RestoreReq>,
) -> AppResult<Json<serde_json::Value>> {
    check_token(&headers, &s.internal_token)?;
    let mgr = SnapshotManager::new(s.db.clone(), s.store.clone());
    let dest = paths::safe_destination_under_root(
        s.problem_root.as_ref(),
        std::path::Path::new(&req.dest),
    )?;
    mgr.restore_snapshot(
        &req.problem_external_id,
        req.generation,
        req.fencing_token,
        &dest,
    )
    .await?;
    Ok(Json(serde_json::json!({"status": "ok"})))
}

#[derive(Deserialize)]
struct EvictReq {
    problem_external_id: String,
    code: String,
    dry_run: Option<bool>,
    force: Option<bool>,
    fencing_token: i64,
}

async fn evict(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<EvictReq>,
) -> AppResult<Json<EvictResult>> {
    check_token(&headers, &s.internal_token)?;
    if !s.eviction_enabled {
        return Err(AppError::EvictionDisabled);
    }
    let mgr = SnapshotManager::new(s.db.clone(), s.store.clone());
    let result = mgr
        .evict_local(
            &req.problem_external_id,
            s.problem_root.as_ref(),
            &req.code,
            req.dry_run.unwrap_or(true),
            req.force.unwrap_or(false),
            req.fencing_token,
        )
        .await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
struct ReconcileReq {
    problems: Vec<(String, String)>,
}

async fn reconcile_catalog(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ReconcileReq>,
) -> AppResult<Json<ReconcileResult>> {
    check_token(&headers, &s.internal_token)?;
    let result = reconcile::reconcile_catalog(s.problem_root.as_ref(), &s.db, req.problems).await?;
    Ok(Json(result))
}

async fn get_problem_usage(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(code): Path<String>,
) -> AppResult<Json<Option<crate::models::ProblemUsage>>> {
    check_token(&headers, &s.internal_token)?;
    let usage = crate::db::get_problem_usage_by_code(&s.db, &code).await?;
    Ok(Json(usage))
}

#[derive(Deserialize)]
struct PresignReq {
    problem_external_id: String,
    ttl_seconds: Option<u64>,
}

async fn presign_download(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<PresignReq>,
) -> AppResult<Json<PresignResult>> {
    check_token(&headers, &s.internal_token)?;
    let ttl = req.ttl_seconds.map(Duration::from_secs);
    let mgr = SnapshotManager::new(s.db.clone(), s.store.clone());
    let result = mgr.presign_download(&req.problem_external_id, ttl).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
struct DeleteObjectReq {
    object_key: String,
    fencing_token: i64,
}

async fn delete_object(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<DeleteObjectReq>,
) -> AppResult<Json<serde_json::Value>> {
    check_token(&headers, &s.internal_token)?;
    let mgr = SnapshotManager::new(s.db.clone(), s.store.clone());
    let deleted = mgr
        .delete_object(&req.object_key, req.fencing_token)
        .await?;
    Ok(Json(serde_json::json!({ "deleted": deleted })))
}

#[cfg(test)]
mod tests {
    use super::SnapshotReq;

    fn parse_snapshot_req(dirty_version: &str) -> serde_json::Result<SnapshotReq> {
        serde_json::from_str(&format!(
            r#"{{
              "problem_external_id": "p1",
              "generation": 7,
              "code": "abc",
              "fencing_token": 3,
              "dirty_version": {dirty_version}
            }}"#
        ))
    }

    #[test]
    fn snapshot_req_accepts_dirty_version_number() {
        let req = parse_snapshot_req("42").unwrap();
        assert_eq!(req.dirty_version, Some(42));
    }

    #[test]
    fn snapshot_req_accepts_dirty_version_decimal_string() {
        let req = parse_snapshot_req(r#""9007199254740993""#).unwrap();
        assert_eq!(req.dirty_version, Some(9_007_199_254_740_993));
    }

    #[test]
    fn snapshot_req_allows_null_or_missing_dirty_version() {
        assert_eq!(parse_snapshot_req("null").unwrap().dirty_version, None);
        let req: SnapshotReq = serde_json::from_str(
            r#"{
              "problem_external_id": "p1",
              "generation": 7,
              "code": "abc",
              "fencing_token": 3
            }"#,
        )
        .unwrap();
        assert_eq!(req.dirty_version, None);
    }

    #[test]
    fn snapshot_req_rejects_malformed_dirty_version() {
        assert!(parse_snapshot_req(r#""not-a-number""#).is_err());
        assert!(parse_snapshot_req(r#""1.5""#).is_err());
        assert!(parse_snapshot_req("1.5").is_err());
    }

    #[test]
    fn snapshot_req_rejects_dirty_version_overflow() {
        assert!(parse_snapshot_req(r#""9223372036854775808""#).is_err());
        assert!(parse_snapshot_req("9223372036854775808").is_err());
    }
}
