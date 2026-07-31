use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Volume {
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub available_bytes: u64,
    pub observed_at: chrono::DateTime<chrono::Utc>,
    pub stale: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Problem {
    pub external_id: String,
    pub code: String,
    pub owner_organization: Option<String>,
    pub is_manually_managed: bool,
    pub mirror_of: Option<String>,
    pub mirror_root: Option<String>,
    pub catalog_state: String,
    pub observed_at: chrono::DateTime<chrono::Utc>,
    pub stale: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProblemUsage {
    pub problem_id: String,
    pub code: String,
    pub logical_bytes: u64,
    pub allocated_bytes: u64,
    pub archive_bytes: u64,
    pub auxiliary_bytes: u64,
    pub file_count: i64,
    pub local_status: String,
    pub r2_status: String,
    pub snapshot_generation: Option<i64>,
    pub orphan_bytes: u64,
    pub referenced_bytes: u64,
    pub observed_at: chrono::DateTime<chrono::Utc>,
    pub stale: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub id: uuid::Uuid,
    pub problem_id: String,
    pub generation: i64,
    pub state: String,
    pub file_count: i64,
    pub total_bytes: u64,
    pub manifest_key: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub completed_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Job {
    pub id: uuid::Uuid,
    pub idempotency_key: String,
    pub job_type: String,
    pub problem_id: Option<String>,
    pub target_generation: Option<i64>,
    pub state: String,
    pub lease_owner: Option<String>,
    pub lease_expires_at: Option<chrono::DateTime<chrono::Utc>>,
    pub fencing_token: i64,
    pub attempt: i32,
    pub max_attempts: i32,
    pub result: Option<serde_json::Value>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    pub completed_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub path: String,
    pub sha256: String,
    pub size: u64,
    pub allocated_bytes: u64,
    pub dev: u64,
    pub ino: u64,
    pub nlink: u64,
    #[serde(default)]
    pub mode: u32,
    #[serde(default)]
    pub duplicate_of: Option<String>,
    #[serde(default)]
    pub symlink_target: Option<String>,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub problem_external_id: Option<String>,
    pub code: String,
    pub logical_bytes: u64,
    pub allocated_bytes: u64,
    pub archive_bytes: u64,
    pub auxiliary_bytes: u64,
    pub file_count: i64,
    pub files: Vec<FileEntry>,
    pub observed_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReconcileResult {
    pub discovered: i64,
    pub missing: i64,
    pub orphans: i64,
    pub mirrors: i64,
    pub orphan_codes: Vec<String>,
    pub missing_codes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    #[serde(default)]
    pub schema_version: u32,
    pub problem_id: String,
    #[serde(default)]
    pub code: String,
    pub generation: i64,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub files: Vec<ManifestFile>,
    #[serde(default)]
    pub canonical_download_path: Option<String>,
    pub total_bytes: u64,
    pub file_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestFile {
    pub path: String,
    pub sha256: String,
    pub size: u64,
    pub allocated_bytes: u64,
    #[serde(default)]
    pub mode: u32,
    #[serde(default)]
    pub dev: u64,
    #[serde(default)]
    pub ino: u64,
    #[serde(default)]
    pub nlink: u64,
    #[serde(default)]
    pub duplicate_of: Option<String>,
    #[serde(default)]
    pub symlink_target: Option<String>,
    pub object_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvictResult {
    pub problem_id: String,
    pub dry_run: bool,
    pub freed_bytes: u64,
    pub files_removed: i64,
    pub preserved_init_yml: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresignResult {
    pub url: String,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

pub fn object_key_for_sha256(sha256: &str) -> String {
    let first2 = &sha256[..2];
    format!("objects/sha256/{first2}/{sha256}")
}

pub fn manifest_key(problem_id: &str, generation: i64) -> String {
    format!("snapshots/{problem_id}/{generation}/manifest.json")
}
