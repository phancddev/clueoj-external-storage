use clap::Parser;
use std::path::PathBuf;

#[derive(Parser, Debug, Clone)]
#[command(name = "rust-data-plane", about = "ClueOJ external storage data plane")]
pub struct Config {
    #[arg(long, env = "STORAGE_PROBLEM_ROOT", default_value = "/problems")]
    pub problem_root: PathBuf,

    #[arg(long, env = "STORAGE_DATABASE_URL")]
    pub database_url: String,

    #[arg(long, env = "STORAGE_BIND", default_value = "0.0.0.0:8081")]
    pub bind: String,

    #[arg(long, env = "R2_ENDPOINT")]
    pub r2_endpoint: Option<String>,

    #[arg(long, env = "R2_BUCKET_NAME", default_value = "clueoj-problems")]
    pub r2_bucket: String,

    #[arg(long, env = "R2_REGION", default_value = "auto")]
    pub r2_region: String,

    #[arg(long, env = "R2_ACCESS_KEY_ID")]
    pub r2_access_key: Option<String>,

    #[arg(long, env = "R2_SECRET_ACCESS_KEY")]
    pub r2_secret_key: Option<String>,

    #[arg(long, env = "STORAGE_OBJECT_STORE", default_value = "r2")]
    pub object_store: String,

    #[arg(long, env = "STORAGE_ALLOW_INSECURE_DEV", default_value_t = false)]
    pub allow_insecure_dev: bool,

    #[arg(long, env = "STORAGE_MAX_CONCURRENT_UPLOADS", default_value_t = 2)]
    pub max_concurrent_uploads: usize,

    #[arg(long, env = "STORAGE_MULTIPART_THRESHOLD_BYTES", default_value_t = 128 * 1024 * 1024)]
    pub multipart_threshold_bytes: u64,

    #[arg(long, env = "STORAGE_MULTIPART_PART_BYTES", default_value_t = 64 * 1024 * 1024)]
    pub multipart_part_bytes: u64,

    #[arg(long, env = "R2_PRESIGN_TTL_SECONDS", default_value_t = 180)]
    pub r2_presign_ttl: u64,

    #[arg(long, env = "STORAGE_INTERNAL_SERVICE_TOKEN", default_value = "")]
    pub internal_token: String,

    #[arg(long, env = "STORAGE_EVICTION_ENABLED", default_value_t = false)]
    pub eviction_enabled: bool,

    #[arg(long, env = "STORAGE_RECONCILE_INTERVAL_SECONDS", default_value_t = 60)]
    pub reconcile_interval: u64,
}

impl Config {
    pub fn presign_ttl(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.r2_presign_ttl.min(300))
    }

    pub fn validate_fail_closed(&self) -> anyhow::Result<()> {
        if self.internal_token.is_empty() && !self.allow_insecure_dev {
            anyhow::bail!(
                "STORAGE_INTERNAL_SERVICE_TOKEN is required unless STORAGE_ALLOW_INSECURE_DEV=true"
            );
        }
        if self.object_store.eq_ignore_ascii_case("inmemory") && !self.allow_insecure_dev {
            anyhow::bail!("STORAGE_OBJECT_STORE=inmemory requires STORAGE_ALLOW_INSECURE_DEV=true");
        }
        Ok(())
    }
}
