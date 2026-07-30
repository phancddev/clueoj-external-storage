use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("problem folder missing: {0}")]
    ProblemFolderMissing(String),
    #[error("problem not found: {0}")]
    ProblemNotFound(String),
    #[error("snapshot not found: problem {problem_id} generation {generation}")]
    SnapshotNotFound { problem_id: String, generation: i64 },
    #[error("snapshot not ready: problem {problem_id} generation {generation}")]
    SnapshotNotReady { problem_id: String, generation: i64 },
    #[error("fencing token mismatch: expected {expected} got {got}")]
    FencingMismatch { expected: i64, got: i64 },
    #[error("eviction disabled")]
    EvictionDisabled,
    #[error("eviction requires dry_run unless explicitly forced")]
    EvictionDryRunRequired,
    #[error("r2 generation not ready+verified for problem {0}")]
    R2NotReady(String),
    #[error("internal token missing or invalid")]
    Unauthorized,
    #[error("storage object not found: {0}")]
    ObjectNotFound(String),
    #[error("checksum mismatch: expected {expected} got {got}")]
    ChecksumMismatch { expected: String, got: String },
    #[error("path escape detected: {0}")]
    PathEscape(String),
    #[error("file changed while scanning: {0}")]
    FileChurn(String),
    #[error("special filesystem entry rejected: {0}")]
    SpecialFile(String),
    #[error("manifest integrity error: {0}")]
    ManifestIntegrity(String),
    #[error("object still referenced by a retention-protected snapshot: {0}")]
    ObjectLiveReference(String),
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("r2 error: {0}")]
    R2(String),
    #[error("not implemented in current phase: {0}")]
    NotImplemented(String),
    #[error("{0}")]
    Internal(String),
}

#[derive(Serialize)]
struct ErrorResponse {
    code: &'static str,
    message: String,
    retryable: bool,
    request_id: String,
}

impl AppError {
    fn status_and_code(&self) -> (StatusCode, &'static str, bool) {
        match self {
            AppError::ProblemFolderMissing(_) => {
                (StatusCode::NOT_FOUND, "PROBLEM_FOLDER_MISSING", false)
            }
            AppError::ProblemNotFound(_) => (StatusCode::NOT_FOUND, "PROBLEM_NOT_FOUND", false),
            AppError::SnapshotNotFound { .. } => {
                (StatusCode::NOT_FOUND, "SNAPSHOT_NOT_FOUND", false)
            }
            AppError::SnapshotNotReady { .. } => (StatusCode::CONFLICT, "SNAPSHOT_NOT_READY", true),
            AppError::FencingMismatch { .. } => (StatusCode::CONFLICT, "FENCING_MISMATCH", false),
            AppError::EvictionDisabled => (StatusCode::FORBIDDEN, "EVICTION_DISABLED", false),
            AppError::EvictionDryRunRequired => {
                (StatusCode::BAD_REQUEST, "EVICTION_DRY_RUN_REQUIRED", false)
            }
            AppError::R2NotReady(_) => (StatusCode::CONFLICT, "R2_NOT_READY", true),
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "UNAUTHORIZED", false),
            AppError::ObjectNotFound(_) => (StatusCode::NOT_FOUND, "OBJECT_NOT_FOUND", false),
            AppError::ChecksumMismatch { .. } => (StatusCode::CONFLICT, "CHECKSUM_MISMATCH", false),
            AppError::PathEscape(_) => (StatusCode::BAD_REQUEST, "PATH_ESCAPE", false),
            AppError::FileChurn(_) => (StatusCode::CONFLICT, "FILE_CHURN", true),
            AppError::SpecialFile(_) => (StatusCode::BAD_REQUEST, "SPECIAL_FILE", false),
            AppError::ManifestIntegrity(_) => (StatusCode::CONFLICT, "MANIFEST_INTEGRITY", false),
            AppError::ObjectLiveReference(_) => {
                (StatusCode::CONFLICT, "OBJECT_LIVE_REFERENCE", false)
            }
            AppError::Database(_) => (StatusCode::INTERNAL_SERVER_ERROR, "DATABASE_ERROR", true),
            AppError::Io(_) => (StatusCode::INTERNAL_SERVER_ERROR, "IO_ERROR", true),
            AppError::Json(_) => (StatusCode::INTERNAL_SERVER_ERROR, "JSON_ERROR", true),
            AppError::R2(_) => (StatusCode::INTERNAL_SERVER_ERROR, "R2_ERROR", true),
            AppError::NotImplemented(_) => (StatusCode::NOT_IMPLEMENTED, "NOT_IMPLEMENTED", false),
            AppError::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", true),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, retryable) = self.status_and_code();
        let body = ErrorResponse {
            code,
            message: self.to_string(),
            retryable,
            request_id: Uuid::new_v4().to_string(),
        };
        (status, axum::Json(body)).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
