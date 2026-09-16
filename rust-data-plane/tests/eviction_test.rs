use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use rust_data_plane::error::AppError;
use rust_data_plane::r2::InMemoryStore;
use rust_data_plane::scanner;
use rust_data_plane::snapshot::SnapshotManager;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::Executor;

#[tokio::test]
async fn guarded_eviction_and_restore_round_trip() {
    let Ok(database_url) = std::env::var("TEST_DATABASE_URL") else {
        return;
    };

    let admin = PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .expect("connect test postgres");
    let schema = format!("rust_evict_{}", uuid::Uuid::new_v4().simple());
    admin
        .execute(format!(r#"CREATE SCHEMA "{schema}""#).as_str())
        .await
        .expect("create test schema");

    let options = PgConnectOptions::from_str(&database_url)
        .expect("parse test postgres URL")
        .options([("search_path", format!("{schema},public"))]);
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await
        .expect("connect isolated test schema");
    for migration in [
        include_str!("../../migrations/001_init.sql"),
        include_str!("../../migrations/002_phase6.sql"),
        include_str!("../../migrations/003_review_contracts.sql"),
        include_str!("../../migrations/004_idempotency_dirty_contract.sql"),
        include_str!("../../migrations/005_dashboard_users.sql"),
        include_str!("../../migrations/006_problem_identity_rekey.sql"),
        include_str!("../../migrations/007_active_job_guards.sql"),
        include_str!("../../migrations/008_snapshot_retention_gc.sql"),
        include_str!("../../migrations/009_passive_local_eviction.sql"),
    ] {
        sqlx::raw_sql(migration)
            .execute(&pool)
            .await
            .expect("apply migration");
    }

    let root = tempfile::tempdir().expect("problem root");
    let problem_dir = root.path().join("sum");
    std::fs::create_dir_all(&problem_dir).expect("create problem folder");
    std::fs::write(problem_dir.join("init.yml"), "archive: tests.zip\n").expect("write init.yml");
    std::fs::write(problem_dir.join("tests.zip"), b"snapshot bytes").expect("write tests");

    sqlx::query(
        r#"INSERT INTO problems (external_id, code, catalog_state, dirty)
           VALUES ('p-evict', 'sum', 'present', false)"#,
    )
    .execute(&pool)
    .await
    .expect("insert problem");
    sqlx::query(
        r#"INSERT INTO problem_usage
             (problem_id, local_status, r2_status, last_accessed_at, stale)
           VALUES ('p-evict', 'present', 'none', now(), false)"#,
    )
    .execute(&pool)
    .await
    .expect("insert usage");
    sqlx::query(
        r#"INSERT INTO jobs
             (idempotency_key, job_type, problem_id, state, fencing_token, request_fingerprint)
           VALUES ('snapshot-job', 'snapshot', 'p-evict', 'running', 1, 'snapshot')"#,
    )
    .execute(&pool)
    .await
    .expect("insert snapshot job");

    let scan = scanner::scan_problem_folder(root.path(), "sum").expect("scan problem");
    let store = Arc::new(InMemoryStore::new(Duration::from_secs(180)));
    let manager = SnapshotManager::new(pool.clone(), store);
    let (snap, run_upload) = manager
        .claim_snapshot("p-evict", 1, 1)
        .await
        .expect("claim snapshot");
    assert!(run_upload);
    manager
        .run_snapshot_upload(snap.id, "p-evict", 1, 1, Some(0), root.path(), &scan, snap.created_at)
        .await
        .expect("create READY snapshot");
    sqlx::query(
        r#"UPDATE jobs SET state = 'completed', completed_at = now()
           WHERE idempotency_key = 'snapshot-job'"#,
    )
    .execute(&pool)
    .await
    .expect("complete snapshot job");
    sqlx::query(
        r#"INSERT INTO jobs
             (idempotency_key, job_type, problem_id, state, fencing_token, request_fingerprint)
           VALUES ('recent-evict-job', 'evict', 'p-evict', 'running', 2, 'recent-evict')"#,
    )
    .execute(&pool)
    .await
    .expect("insert recent eviction job");

    let cutoff = chrono::Utc::now() - chrono::Duration::hours(24);
    let recent = manager
        .evict_local("p-evict", root.path(), "sum", false, true, 2, Some(cutoff))
        .await;
    assert!(matches!(recent, Err(AppError::EvictionRecentlyAccessed)));
    assert!(problem_dir.exists());
    sqlx::query(
        r#"UPDATE jobs SET state = 'failed', completed_at = now()
           WHERE idempotency_key = 'recent-evict-job'"#,
    )
    .execute(&pool)
    .await
    .expect("fail fenced eviction job");

    sqlx::query(
        r#"UPDATE problem_usage
           SET last_accessed_at = now() - interval '25 hours'
           WHERE problem_id = 'p-evict'"#,
    )
    .execute(&pool)
    .await
    .expect("age access fence");
    sqlx::query(
        r#"INSERT INTO jobs
             (idempotency_key, job_type, problem_id, state, fencing_token, request_fingerprint)
           VALUES ('idle-evict-job', 'evict', 'p-evict', 'running', 3, 'idle-evict')"#,
    )
    .execute(&pool)
    .await
    .expect("insert idle eviction job");
    let evicted = manager
        .evict_local("p-evict", root.path(), "sum", false, true, 3, Some(cutoff))
        .await
        .expect("evict inactive local copy");
    assert!(!problem_dir.exists());
    assert_eq!(evicted.files_removed, 2);
    assert!(!evicted.preserved_init_yml);
    sqlx::query(
        r#"UPDATE jobs SET state = 'completed', completed_at = now()
           WHERE idempotency_key = 'idle-evict-job'"#,
    )
    .execute(&pool)
    .await
    .expect("complete idle eviction job");

    sqlx::query(
        r#"INSERT INTO jobs
             (idempotency_key, job_type, problem_id, target_generation, state,
              fencing_token, request_fingerprint)
           VALUES ('restore-job', 'restore', 'p-evict', 1, 'running', 4, 'restore')"#,
    )
    .execute(&pool)
    .await
    .expect("insert restore job");
    manager
        .restore_snapshot("p-evict", 1, 4, &problem_dir)
        .await
        .expect("restore evicted snapshot");
    assert_eq!(
        std::fs::read(problem_dir.join("tests.zip")).expect("read restored tests"),
        b"snapshot bytes",
    );
    let restored_access_is_fresh: bool = sqlx::query_scalar(
        r#"SELECT last_accessed_at > now() - interval '1 minute'
           FROM problem_usage WHERE problem_id = 'p-evict'"#,
    )
    .fetch_one(&pool)
    .await
    .expect("read restored access fence");
    assert!(restored_access_is_fresh);

    pool.close().await;
    admin
        .execute(format!(r#"DROP SCHEMA "{schema}" CASCADE"#).as_str())
        .await
        .expect("drop test schema");
    admin.close().await;
}
