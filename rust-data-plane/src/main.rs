use std::sync::Arc;

use clap::Parser;
use rust_data_plane::api;
use rust_data_plane::config::Config;
use rust_data_plane::{db, r2, reconcile, watcher};
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config::parse();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .or_else(|_| EnvFilter::try_new("info"))
                .unwrap(),
        )
        .json()
        .init();

    tracing::info!(bind = %config.bind, "starting rust data plane");
    config.validate_fail_closed()?;

    let pool = db::connect(&config.database_url).await?;
    let problem_root: Arc<std::path::Path> = Arc::from(config.problem_root.as_path());

    let store = r2::build_store_from_config(
        &config.object_store,
        config.r2_endpoint.clone(),
        config.r2_region.clone(),
        config.r2_access_key.clone(),
        config.r2_secret_key.clone(),
        config.r2_bucket.clone(),
        config.presign_ttl(),
        config.multipart_threshold_bytes,
        config.multipart_part_bytes,
    )?;

    let state = api::AppState {
        db: pool.clone(),
        problem_root: problem_root.clone(),
        store: store.clone(),
        internal_token: config.internal_token.clone(),
        eviction_enabled: config.eviction_enabled,
        max_concurrent_uploads: config.max_concurrent_uploads.max(1),
    };

    let app = api::router(state);
    let listener = TcpListener::bind(&config.bind).await?;
    tracing::info!("listening on {}", config.bind);

    watcher::spawn_watcher(problem_root.clone(), pool.clone(), store.clone());
    tokio::spawn(reconcile::full_reconcile(
        problem_root.clone(),
        pool.clone(),
        std::time::Duration::from_secs(config.reconcile_interval),
    ));

    axum::serve(listener, app).await?;
    Ok(())
}
