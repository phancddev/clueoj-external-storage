use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use crate::error::AppResult;
use crate::models::{ProblemUsage, ScanResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogProblem {
    pub external_id: String,
    pub code: String,
    pub catalog_state: String,
}

pub fn allocate_counter_value(current_next: i64, max_observed_generation: i64) -> (i64, i64) {
    let generation = current_next.max(max_observed_generation + 1).max(1);
    (generation, generation + 1)
}

pub const ACQUIRE_DIRTY_SNAPSHOT_JOB_SQL: &str = r#"WITH target AS (
             SELECT p.external_id
             FROM problems p
             WHERE p.code = $1 AND p.catalog_state IN ('present', 'mirror')
           ),
           generation_seed AS (
             SELECT target.external_id,
                    GREATEST(
                      COALESCE(pu.snapshot_generation, 0),
                      COALESCE((SELECT MAX(generation) FROM snapshots WHERE problem_id = target.external_id), 0)
                    ) AS max_generation
             FROM target
             LEFT JOIN problem_usage pu ON pu.problem_id = target.external_id
           ),
           generation_alloc AS (
             INSERT INTO problem_generation_counters (problem_id, next_generation)
             SELECT external_id, GREATEST(max_generation + 2, 2) FROM generation_seed
             ON CONFLICT (problem_id) DO UPDATE
             SET next_generation = GREATEST(
                 problem_generation_counters.next_generation,
                 EXCLUDED.next_generation - 1
               ) + 1
	             RETURNING (next_generation - 1)::BIGINT AS generation
           ),
           max_seen AS (
             SELECT target.external_id,
                    COALESCE((SELECT MAX(fencing_token) FROM jobs WHERE problem_id = target.external_id), 0) AS max_token
             FROM target
           ),
           token AS (
             INSERT INTO job_fencing_counters (problem_id, next_token)
             SELECT external_id, GREATEST(max_token + 2, 2) FROM max_seen
             ON CONFLICT (problem_id) DO UPDATE
             SET next_token = GREATEST(
                 job_fencing_counters.next_token,
                 (SELECT max_token + 1 FROM max_seen)
               ) + 1
             RETURNING next_token - 1 AS fencing_token
           ),
           dirty AS (
             UPDATE problems p
             SET dirty = true,
                 dirty_version = p.dirty_version + 1,
                 dirty_generation = generation_alloc.generation,
                 stale = true,
                 observed_at = now()
             FROM max_seen, generation_alloc
             WHERE p.external_id = max_seen.external_id
             RETURNING p.dirty_version
           )
           SELECT max_seen.external_id, generation_alloc.generation, token.fencing_token, dirty.dirty_version
           FROM max_seen, generation_alloc, token, dirty"#;

pub async fn connect(url: &str) -> AppResult<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(url)
        .await?;
    tracing::info!("connected to storage database");
    Ok(pool)
}

#[allow(clippy::too_many_arguments)]
pub async fn upsert_problem_usage(
    pool: &PgPool,
    problem_id: &str,
    _code: &str,
    logical_bytes: u64,
    allocated_bytes: u64,
    archive_bytes: u64,
    auxiliary_bytes: u64,
    file_count: i64,
    local_status: &str,
) -> AppResult<()> {
    sqlx::query(
        r#"
        INSERT INTO problem_usage
            (problem_id, logical_bytes, allocated_bytes, archive_bytes,
             auxiliary_bytes, file_count, local_status, r2_status, snapshot_generation,
             orphan_bytes, referenced_bytes, observed_at, stale)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'none', NULL, 0, 0, NOW(), false)
        ON CONFLICT (problem_id) DO UPDATE SET
            logical_bytes = EXCLUDED.logical_bytes,
            allocated_bytes = EXCLUDED.allocated_bytes,
            archive_bytes = EXCLUDED.archive_bytes,
            auxiliary_bytes = EXCLUDED.auxiliary_bytes,
            file_count = EXCLUDED.file_count,
            local_status = EXCLUDED.local_status,
            observed_at = EXCLUDED.observed_at,
            stale = false
        "#,
    )
    .bind(problem_id)
    .bind(logical_bytes as i64)
    .bind(allocated_bytes as i64)
    .bind(archive_bytes as i64)
    .bind(auxiliary_bytes as i64)
    .bind(file_count)
    .bind(local_status)
    .execute(pool)
    .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn upsert_problem(
    pool: &PgPool,
    external_id: &str,
    code: &str,
    owner_organization: Option<&str>,
    is_manually_managed: bool,
    mirror_of: Option<&str>,
    mirror_root: Option<&str>,
    catalog_state: &str,
) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(code)
        .execute(&mut *tx)
        .await?;

    if catalog_state == "orphan" {
        // A catalog writer may have claimed this code after the watcher read its
        // catalog snapshot. In that case the authoritative row always wins.
        sqlx::query(
            r#"
            INSERT INTO problems
                (external_id, code, owner_organization, is_manually_managed,
                 mirror_of, mirror_root, catalog_state, observed_at, stale)
            VALUES ($1, $2, $3, $4, $5, $6, 'orphan', NOW(), false)
            ON CONFLICT DO NOTHING
            "#,
        )
        .bind(external_id)
        .bind(code)
        .bind(owner_organization)
        .bind(is_manually_managed)
        .bind(mirror_of)
        .bind(mirror_root)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query(
            r#"
            INSERT INTO problems
                (external_id, code, owner_organization, is_manually_managed,
                 mirror_of, mirror_root, catalog_state, observed_at, stale)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), false)
            ON CONFLICT (external_id) DO UPDATE SET
                code = EXCLUDED.code,
                owner_organization = EXCLUDED.owner_organization,
                is_manually_managed = EXCLUDED.is_manually_managed,
                mirror_of = EXCLUDED.mirror_of,
                mirror_root = EXCLUDED.mirror_root,
                catalog_state = EXCLUDED.catalog_state,
                observed_at = EXCLUDED.observed_at,
                stale = false
            "#,
        )
        .bind(external_id)
        .bind(code)
        .bind(owner_organization)
        .bind(is_manually_managed)
        .bind(mirror_of)
        .bind(mirror_root)
        .bind(catalog_state)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn upsert_discovered_usage(
    pool: &PgPool,
    code: &str,
    logical_bytes: u64,
    allocated_bytes: u64,
    archive_bytes: u64,
    auxiliary_bytes: u64,
    file_count: i64,
) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(code)
        .execute(&mut *tx)
        .await?;

    let orphan_id = format!("orphan:{code}");
    sqlx::query(
        r#"
        INSERT INTO problems
            (external_id, code, owner_organization, is_manually_managed,
             mirror_of, mirror_root, catalog_state, observed_at, stale)
        VALUES ($1, $2, NULL, false, NULL, NULL, 'orphan', NOW(), false)
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(&orphan_id)
    .bind(code)
    .execute(&mut *tx)
    .await?;

    let owner = sqlx::query_as::<_, CatalogProblemRow>(
        "SELECT external_id, code, catalog_state FROM problems WHERE code = $1 FOR UPDATE",
    )
    .bind(code)
    .fetch_one(&mut *tx)
    .await?;
    let local_status = if owner.catalog_state == "orphan" {
        "orphan"
    } else {
        "present"
    };
    sqlx::query(
        r#"
        INSERT INTO problem_usage
            (problem_id, logical_bytes, allocated_bytes, archive_bytes,
             auxiliary_bytes, file_count, local_status, r2_status, snapshot_generation,
             orphan_bytes, referenced_bytes, observed_at, stale)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'none', NULL, 0, 0, NOW(), false)
        ON CONFLICT (problem_id) DO UPDATE SET
            logical_bytes = EXCLUDED.logical_bytes,
            allocated_bytes = EXCLUDED.allocated_bytes,
            archive_bytes = EXCLUDED.archive_bytes,
            auxiliary_bytes = EXCLUDED.auxiliary_bytes,
            file_count = EXCLUDED.file_count,
            local_status = EXCLUDED.local_status,
            observed_at = EXCLUDED.observed_at,
            stale = false
        "#,
    )
    .bind(&owner.external_id)
    .bind(logical_bytes as i64)
    .bind(allocated_bytes as i64)
    .bind(archive_bytes as i64)
    .bind(auxiliary_bytes as i64)
    .bind(file_count)
    .bind(local_status)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn mark_stale(pool: &PgPool, code: &str) -> AppResult<()> {
    sqlx::query(
        r#"UPDATE problem_usage SET stale = true WHERE problem_id IN
           (SELECT external_id FROM problems WHERE code = $1)"#,
    )
    .bind(code)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn mark_local_missing_by_code(pool: &PgPool, code: &str) -> AppResult<()> {
    sqlx::query(
        r#"UPDATE problem_usage
           SET local_status = 'missing', observed_at = now(), stale = false
           WHERE problem_id IN (
             SELECT external_id FROM problems
             WHERE code = $1 AND catalog_state IN ('present', 'mirror')
           )"#,
    )
    .bind(code)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn mark_local_verified(
    pool: &PgPool,
    problem_id: &str,
    generation: i64,
) -> AppResult<()> {
    sqlx::query(
        r#"UPDATE problem_usage
           SET local_status = 'present',
               snapshot_generation = GREATEST(COALESCE(snapshot_generation, 0), $2),
               observed_at = now(),
               stale = false
           WHERE problem_id = $1"#,
    )
    .bind(problem_id)
    .bind(generation)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn ready_snapshot_matches_scan(
    pool: &PgPool,
    problem_id: &str,
    scan: &ScanResult,
) -> AppResult<Option<i64>> {
    let snapshot = sqlx::query_as::<_, ReadySnapshotRow>(
        r#"SELECT s.id, s.generation::BIGINT AS generation
           FROM snapshots s
           JOIN problems p ON p.external_id = s.problem_id
           WHERE s.problem_id = $1
             AND s.state = 'ready'
             AND p.dirty = false
           ORDER BY s.generation DESC
           LIMIT 1"#,
    )
    .bind(problem_id)
    .fetch_optional(pool)
    .await?;
    let Some(snapshot) = snapshot else {
        return Ok(None);
    };
    let expected = sqlx::query_as::<_, SnapshotObjectIdentityRow>(
        r#"SELECT rel_path, sha256, size_bytes
           FROM snapshot_objects
           WHERE snapshot_id = $1
           ORDER BY rel_path ASC"#,
    )
    .bind(snapshot.id)
    .fetch_all(pool)
    .await?;
    let expected: Vec<(String, String, i64)> = expected
        .into_iter()
        .map(|row| (row.rel_path, row.sha256, row.size_bytes))
        .collect();
    let matches = scan_matches_snapshot_objects(scan, &expected);
    Ok(matches.then_some(snapshot.generation))
}

pub fn scan_matches_snapshot_objects(
    scan: &ScanResult,
    expected: &[(String, String, i64)],
) -> bool {
    if expected.len() != scan.files.len() {
        return false;
    }
    let mut actual: Vec<(&str, &str, i64)> = scan
        .files
        .iter()
        .map(|file| (file.path.as_str(), file.sha256.as_str(), file.size as i64))
        .collect();
    actual.sort_unstable_by(|a, b| a.0.cmp(b.0));
    let mut expected: Vec<(&str, &str, i64)> = expected
        .iter()
        .map(|item| (item.0.as_str(), item.1.as_str(), item.2))
        .collect();
    expected.sort_unstable_by(|a, b| a.0.cmp(b.0));
    expected
        .iter()
        .zip(actual.iter())
        .all(|(expected, actual)| {
            expected.0 == actual.0 && expected.1 == actual.1 && expected.2 == actual.2
        })
}

pub async fn ready_snapshot_matches_scan_by_code(
    pool: &PgPool,
    code: &str,
    scan: &ScanResult,
) -> AppResult<Option<(String, i64)>> {
    let problem_id: Option<String> = sqlx::query_scalar(
        r#"SELECT external_id
           FROM problems
           WHERE code = $1 AND catalog_state IN ('present', 'mirror')"#,
    )
    .bind(code)
    .fetch_optional(pool)
    .await?;
    let Some(problem_id) = problem_id else {
        return Ok(None);
    };
    Ok(ready_snapshot_matches_scan(pool, &problem_id, scan)
        .await?
        .map(|generation| (problem_id, generation)))
}

pub async fn list_catalog_problems(pool: &PgPool) -> AppResult<Vec<CatalogProblem>> {
    let rows = sqlx::query_as::<_, CatalogProblemRow>(
        r#"SELECT external_id, code, catalog_state FROM problems
           WHERE catalog_state IN ('present', 'mirror')"#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| CatalogProblem {
            external_id: r.external_id,
            code: r.code,
            catalog_state: r.catalog_state,
        })
        .collect())
}

pub async fn remove_orphan_projection_for_code(pool: &PgPool, code: &str) -> AppResult<()> {
    let orphan_id = format!("orphan:{code}");
    sqlx::query("DELETE FROM problem_usage WHERE problem_id = $1")
        .bind(&orphan_id)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM problems WHERE external_id = $1 AND catalog_state = 'orphan'")
        .bind(&orphan_id)
        .execute(pool)
        .await?;
    Ok(())
}

#[derive(sqlx::FromRow)]
struct CatalogProblemRow {
    external_id: String,
    code: String,
    catalog_state: String,
}

#[derive(sqlx::FromRow)]
struct ReadySnapshotRow {
    id: uuid::Uuid,
    generation: i64,
}

#[derive(sqlx::FromRow)]
struct SnapshotObjectIdentityRow {
    rel_path: String,
    sha256: String,
    size_bytes: i64,
}

pub async fn get_problem_usage_by_code(
    pool: &PgPool,
    code: &str,
) -> AppResult<Option<ProblemUsage>> {
    let row = sqlx::query_as::<_, ProblemUsageRow>(
        r#"SELECT pu.problem_id, p.code, pu.logical_bytes, pu.allocated_bytes,
                  pu.archive_bytes, pu.auxiliary_bytes, pu.file_count, pu.local_status,
                  pu.r2_status, pu.snapshot_generation::BIGINT AS snapshot_generation, pu.orphan_bytes,
                  pu.referenced_bytes, pu.observed_at, pu.stale
           FROM problem_usage pu JOIN problems p ON p.external_id = pu.problem_id
           WHERE p.code = $1"#,
    )
    .bind(code)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| r.into()))
}

pub async fn get_problem_snapshot_target_by_code(
    pool: &PgPool,
    code: &str,
) -> AppResult<Option<(String, i64, i64)>> {
    let row = sqlx::query_as::<_, SnapshotTargetRow>(
        r#"SELECT p.external_id,
                  (COALESCE(pu.snapshot_generation, 0) + 1)::BIGINT AS generation,
                  COALESCE((SELECT MAX(fencing_token) FROM jobs WHERE problem_id = p.external_id), 0) + 1 AS fencing_token
           FROM problems p
           LEFT JOIN problem_usage pu ON pu.problem_id = p.external_id
           WHERE p.code = $1"#,
    )
    .bind(code)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| (r.external_id, r.generation, r.fencing_token)))
}

pub async fn acquire_dirty_snapshot_job_by_code(
    pool: &PgPool,
    code: &str,
    lease_owner: &str,
    lease_seconds: i64,
) -> AppResult<Option<(uuid::Uuid, String, i64, i64, i64)>> {
    let mut tx = pool.begin().await?;
    let row = sqlx::query_as::<_, DirtySnapshotTargetRow>(ACQUIRE_DIRTY_SNAPSHOT_JOB_SQL)
        .bind(code)
        .fetch_optional(&mut *tx)
        .await?;

    let Some(row) = row else {
        tx.commit().await?;
        return Ok(None);
    };
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 2907))")
        .bind(&row.external_id)
        .execute(&mut *tx)
        .await?;

    let job_id = uuid::Uuid::new_v4();
    let idem = format!(
        "rust-dirty:{}:{}",
        row.external_id,
        chrono::Utc::now().timestamp_millis()
    );
    sqlx::query(
        r#"INSERT INTO jobs
             (id, idempotency_key, job_type, problem_id, target_generation, state,
              lease_owner, lease_expires_at, fencing_token, attempt, max_attempts)
           VALUES ($1, $2, 'snapshot', $3, $4, 'running',
                   $5, now() + ($6::text || ' seconds')::interval, $7, 1, 3)"#,
    )
    .bind(job_id)
    .bind(idem)
    .bind(&row.external_id)
    .bind(row.generation)
    .bind(lease_owner)
    .bind(lease_seconds)
    .bind(row.fencing_token)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Some((
        job_id,
        row.external_id,
        row.generation,
        row.fencing_token,
        row.dirty_version,
    )))
}

pub async fn complete_job(
    pool: &PgPool,
    job_id: uuid::Uuid,
    lease_owner: &str,
    fencing_token: i64,
    result: serde_json::Value,
) -> AppResult<()> {
    let updated = sqlx::query(
        r#"UPDATE jobs SET state = 'completed', result = $2, completed_at = now()
           WHERE id = $1 AND state = 'running' AND lease_owner = $3
             AND fencing_token = $4 AND lease_expires_at >= now()"#,
    )
    .bind(job_id)
    .bind(result)
    .bind(lease_owner)
    .bind(fencing_token)
    .execute(pool)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(crate::error::AppError::FencingMismatch {
            expected: fencing_token,
            got: -1,
        });
    }
    Ok(())
}

pub async fn fail_job(
    pool: &PgPool,
    job_id: uuid::Uuid,
    lease_owner: &str,
    fencing_token: i64,
    error_code: &str,
    error_message: &str,
) -> AppResult<()> {
    sqlx::query(
        r#"UPDATE jobs SET state = CASE WHEN attempt < max_attempts THEN 'pending' ELSE 'failed' END,
                  lease_owner = NULL,
                  lease_expires_at = NULL,
                  error_code = $2,
                  error_message = $3,
                  completed_at = CASE WHEN attempt >= max_attempts THEN now() ELSE NULL END
           WHERE id = $1 AND state = 'running' AND lease_owner = $4 AND fencing_token = $5"#,
    )
    .bind(job_id)
    .bind(error_code)
    .bind(error_message)
    .bind(lease_owner)
    .bind(fencing_token)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn renew_job_lease(
    pool: &PgPool,
    job_id: uuid::Uuid,
    lease_owner: &str,
    fencing_token: i64,
    lease_seconds: i64,
) -> AppResult<bool> {
    let updated = sqlx::query(
        r#"UPDATE jobs SET lease_expires_at = now() + ($4::text || ' seconds')::interval
           WHERE id = $1 AND state = 'running' AND lease_owner = $2
             AND fencing_token = $3 AND lease_expires_at >= now()"#,
    )
    .bind(job_id)
    .bind(lease_owner)
    .bind(fencing_token)
    .bind(lease_seconds)
    .execute(pool)
    .await?;
    Ok(updated.rows_affected() == 1)
}

pub async fn assert_job_lease(
    pool: &PgPool,
    job_id: uuid::Uuid,
    lease_owner: &str,
    fencing_token: i64,
) -> AppResult<()> {
    let ok: Option<i32> = sqlx::query_scalar(
        r#"SELECT 1 FROM jobs
           WHERE id = $1 AND state = 'running' AND lease_owner = $2
             AND fencing_token = $3 AND lease_expires_at >= now()"#,
    )
    .bind(job_id)
    .bind(lease_owner)
    .bind(fencing_token)
    .fetch_optional(pool)
    .await?;
    if ok.is_none() {
        return Err(crate::error::AppError::FencingMismatch {
            expected: fencing_token,
            got: -1,
        });
    }
    Ok(())
}

#[derive(sqlx::FromRow)]
struct SnapshotTargetRow {
    external_id: String,
    generation: i64,
    fencing_token: i64,
}

#[derive(sqlx::FromRow)]
struct DirtySnapshotTargetRow {
    external_id: String,
    generation: i64,
    fencing_token: i64,
    dirty_version: i64,
}

pub async fn list_all_problem_usage(pool: &PgPool) -> AppResult<Vec<ProblemUsage>> {
    let rows = sqlx::query_as::<_, ProblemUsageRow>(
        r#"SELECT pu.problem_id, p.code, pu.logical_bytes, pu.allocated_bytes,
                  pu.archive_bytes, pu.auxiliary_bytes, pu.file_count, pu.local_status,
                  pu.r2_status, pu.snapshot_generation::BIGINT AS snapshot_generation, pu.orphan_bytes,
                  pu.referenced_bytes, pu.observed_at, pu.stale
           FROM problem_usage pu JOIN problems p ON p.external_id = pu.problem_id
           ORDER BY p.code"#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|r| r.into()).collect())
}

#[derive(sqlx::FromRow)]
struct ProblemUsageRow {
    problem_id: String,
    code: String,
    logical_bytes: i64,
    allocated_bytes: i64,
    archive_bytes: i64,
    auxiliary_bytes: i64,
    file_count: i32,
    local_status: String,
    r2_status: String,
    snapshot_generation: Option<i64>,
    orphan_bytes: i64,
    referenced_bytes: i64,
    observed_at: chrono::DateTime<chrono::Utc>,
    stale: bool,
}

impl From<ProblemUsageRow> for ProblemUsage {
    fn from(r: ProblemUsageRow) -> Self {
        Self {
            problem_id: r.problem_id,
            code: r.code,
            logical_bytes: r.logical_bytes as u64,
            allocated_bytes: r.allocated_bytes as u64,
            archive_bytes: r.archive_bytes as u64,
            auxiliary_bytes: r.auxiliary_bytes as u64,
            file_count: r.file_count as i64,
            local_status: r.local_status,
            r2_status: r.r2_status,
            snapshot_generation: r.snapshot_generation,
            orphan_bytes: r.orphan_bytes as u64,
            referenced_bytes: r.referenced_bytes as u64,
            observed_at: r.observed_at,
            stale: r.stale,
        }
    }
}
