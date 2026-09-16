import type { Pool, PoolClient } from 'pg';
import type {
  ProblemT, ProblemUsageT, OrganizationUsageT, SnapshotT, JobT, AuditEventT, OrphanT, SyncChangeT,
  ProblemFilesResponseT,
} from './schemas.js';

type Page<T> = { items: T[]; next_cursor: string | null; has_more: boolean };
export class JobLeaseLostError extends Error {
  constructor(jobId: string) {
    super(`Job lease lost for ${jobId}`);
    this.name = 'JobLeaseLostError';
  }
}
export class IdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency-Key already used with a different request');
    this.name = 'IdempotencyConflictError';
  }
}
export class ProblemOperationConflictError extends Error {
  constructor(problemId: string) {
    super(`Another local storage operation is already active for problem ${problemId}`);
    this.name = 'ProblemOperationConflictError';
  }
}
export class CatalogCodeConflictError extends Error {
  constructor(code: string, externalId: string) {
    super(`Problem code ${code} is already owned by catalog problem ${externalId}`);
    this.name = 'CatalogCodeConflictError';
  }
}
export class OrphanHistoryConflictError extends Error {
  constructor(code: string) {
    super(`Orphan ${code} has immutable history and cannot be merged automatically`);
    this.name = 'OrphanHistoryConflictError';
  }
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor<T>(cursor: string, fallback: T): T {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')) as T;
  } catch {
    return fallback;
  }
}

function int8(v: unknown): number | string {
  const s = String(v ?? '0');
  const n = BigInt(s);
  return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : s;
}

// ===========================================================================
// Problems
// ===========================================================================

export async function upsertProblem(
  pool: Pool, externalId: string, code: string, ownerOrg: string | null,
  isManuallyManaged: boolean, mirrorOf: string | null, mirrorRoot: string | null,
  quotaBytes: number | string | null = null, schemaVersion = 1,
): Promise<ProblemT> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(lock_key, 0))
       FROM unnest(ARRAY[$1::text, $2::text]) AS locks(lock_key)
       ORDER BY lock_key`,
      [`code:${code}`, `problem:${externalId}`],
    );
    const existingCode = await client.query(
      `SELECT external_id, catalog_state
       FROM problems
       WHERE code = $1
       FOR UPDATE`,
      [code],
    );
    const codeOwner = existingCode.rows[0] as { external_id: string; catalog_state: string } | undefined;
    if (codeOwner && codeOwner.external_id !== externalId) {
      const expectedOrphanId = `orphan:${code}`;
      if (codeOwner.catalog_state !== 'orphan' || codeOwner.external_id !== expectedOrphanId) {
        throw new CatalogCodeConflictError(code, codeOwner.external_id);
      }
      const existingTarget = await client.query(
        `SELECT external_id FROM problems WHERE external_id = $1 FOR UPDATE`,
        [externalId],
      );
      if (existingTarget.rows[0]) {
        const orphanHistory = await client.query(
          `SELECT EXISTS (
             SELECT 1 FROM snapshots WHERE problem_id = $1
             UNION ALL
             SELECT 1 FROM jobs WHERE problem_id = $1
           ) AS has_history`,
          [expectedOrphanId],
        );
        if (orphanHistory.rows[0]?.has_history === true) {
          throw new OrphanHistoryConflictError(code);
        }
        // A normal code rename can leave both the authoritative problem row
        // (under its previous code) and a watcher-created orphan row (under
        // the new code). Merge the local accounting projection before
        // removing the orphan so the UNIQUE(code) update below is safe.
        await client.query(
          `INSERT INTO problem_usage
             (problem_id, logical_bytes, allocated_bytes, archive_bytes,
              auxiliary_bytes, file_count, local_status, r2_status,
              snapshot_generation, orphan_bytes, referenced_bytes, observed_at, stale)
           SELECT $2, logical_bytes, allocated_bytes, archive_bytes,
                  auxiliary_bytes, file_count, 'present', 'none',
                  NULL, orphan_bytes, referenced_bytes, observed_at, stale
           FROM problem_usage
           WHERE problem_id = $1
           ON CONFLICT (problem_id) DO UPDATE SET
             logical_bytes = EXCLUDED.logical_bytes,
             allocated_bytes = EXCLUDED.allocated_bytes,
             archive_bytes = EXCLUDED.archive_bytes,
             auxiliary_bytes = EXCLUDED.auxiliary_bytes,
             file_count = EXCLUDED.file_count,
             local_status = EXCLUDED.local_status,
             orphan_bytes = EXCLUDED.orphan_bytes,
             observed_at = GREATEST(problem_usage.observed_at, EXCLUDED.observed_at),
             stale = EXCLUDED.stale`,
          [expectedOrphanId, externalId],
        );
        await client.query(
          `DELETE FROM problems
           WHERE external_id = $1 AND code = $2 AND catalog_state = 'orphan'`,
          [expectedOrphanId, code],
        );
      } else {
        await client.query(
          `UPDATE problems
           SET external_id = $2
           WHERE external_id = $1 AND code = $3 AND catalog_state = 'orphan'`,
          [expectedOrphanId, externalId, code],
        );
      }
    }
    const { rows } = await client.query(
      `INSERT INTO problems (external_id, code, owner_organization, is_manually_managed, mirror_of, mirror_root, quota_bytes, schema_version, catalog_state, observed_at, stale)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'present', now(), false)
       ON CONFLICT (external_id) DO UPDATE SET
         code = EXCLUDED.code,
         owner_organization = EXCLUDED.owner_organization,
         is_manually_managed = EXCLUDED.is_manually_managed,
         mirror_of = EXCLUDED.mirror_of,
         mirror_root = EXCLUDED.mirror_root,
         quota_bytes = EXCLUDED.quota_bytes,
         schema_version = EXCLUDED.schema_version,
         catalog_state = EXCLUDED.catalog_state,
         observed_at = now(),
         stale = false
       RETURNING *`,
      [externalId, code, ownerOrg, isManuallyManaged, mirrorOf, mirrorRoot, quotaBytes, schemaVersion],
    );
    await client.query('COMMIT');
    return rowToProblem(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function markMissingOutsideCatalog(pool: Pool, externalIds: string[]): Promise<number> {
  if (externalIds.length === 0) return 0;
  const { rowCount } = await pool.query(
    `UPDATE problems
     SET catalog_state = 'missing', observed_at = now(), stale = false
     WHERE catalog_state <> 'orphan' AND NOT (external_id = ANY($1::text[]))`,
    [externalIds],
  );
  return rowCount ?? 0;
}

export async function clearDirtyForMissingLocal(pool: Pool): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE problems p
     SET dirty = false,
         dirty_generation = NULL,
         stale = false,
         observed_at = now()
     FROM problem_usage pu
     WHERE pu.problem_id = p.external_id
       AND pu.local_status = 'missing'
       AND p.dirty = true
       AND p.catalog_state IN ('present', 'mirror')
       AND NOT EXISTS (
         SELECT 1 FROM snapshots s
         WHERE s.problem_id = p.external_id AND s.state = 'ready'
       )`,
  );
  return rowCount ?? 0;
}

export async function markProblemDirty(pool: Pool, externalId: string): Promise<ProblemT | null> {
  const { rows } = await pool.query(
    `UPDATE problems SET dirty = true, stale = true, observed_at = now()
     WHERE external_id = $1 RETURNING *`,
    [externalId],
  );
  return rows[0] ? rowToProblem(rows[0]) : null;
}

export async function markDirtyIfNoReady(pool: Pool, externalId: string): Promise<ProblemT | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE problems p
       SET dirty = true,
           dirty_version = p.dirty_version + 1,
           dirty_generation = NULL,
           stale = true,
           observed_at = now()
       WHERE p.external_id = $1
         AND p.dirty = false
         AND p.catalog_state IN ('present', 'mirror')
         AND NOT EXISTS (SELECT 1 FROM snapshots s WHERE s.problem_id = p.external_id AND s.state = 'ready')
       RETURNING p.*`,
      [externalId],
    );
    if (!rows[0]) {
      await client.query('COMMIT');
      return null;
    }
    const generation = await allocateGenerationOnClient(client, externalId);
    const updated = await client.query(
      `UPDATE problems
       SET dirty_generation = $2
       WHERE external_id = $1 AND dirty = true
       RETURNING *`,
      [externalId, generation],
    );
    await client.query('COMMIT');
    return rowToProblem(updated.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function scheduleAutoSnapshotJobs(pool: Pool, problem: ProblemT, actor: string): Promise<{ scan_job_id: string; snapshot_job_id: string } | null> {
  if (!problem.dirty) return null;
  const generation = problem.dirty_generation ?? await allocateGeneration(pool, problem.external_id);
  const dirtyVersion = problem.dirty_version;
  // createJob replays an existing idempotency key verbatim, so a failed
  // earlier attempt would otherwise be "scheduled" forever without ever
  // running again. Scope the key by how many attempts already finished so
  // each reschedule round enqueues a fresh job pair.
  const { rows } = await pool.query(
    `SELECT count(*)::int AS finished FROM jobs
     WHERE problem_id = $1 AND job_type = 'snapshot' AND state IN ('failed', 'cancelled', 'completed')`,
    [problem.external_id],
  );
  const round = (rows[0]?.finished ?? 0) + 1;
  const scan = await createJob(pool, {
    idempotencyKey: `auto-scan:${problem.external_id}:${dirtyVersion}:${round}`,
    jobType: 'scan',
    problemId: problem.external_id,
    targetGeneration: null,
    leaseOwner: actor,
    requestFingerprint: stableFingerprint({ action: 'auto-scan', external_id: problem.external_id, dirty_version: dirtyVersion, round }),
  });
  const snapshot = await createJob(pool, {
    idempotencyKey: `auto-snapshot:${problem.external_id}:${dirtyVersion}:${round}`,
    jobType: 'snapshot',
    problemId: problem.external_id,
    targetGeneration: generation,
    leaseOwner: actor,
    requestFingerprint: stableFingerprint({ action: 'auto-snapshot', external_id: problem.external_id, generation, dirty_version: dirtyVersion, round }),
  });
  await setJobPayload(pool, snapshot.id, { dirty_version: dirtyVersion, auto_push: true });
  return { scan_job_id: scan.id, snapshot_job_id: snapshot.id };
}

export async function scheduleDirtySnapshotBatch(pool: Pool, actor: string, limit: number): Promise<Array<{ problem_id: string; scan_job_id: string; snapshot_job_id: string }>> {
  const { rows } = await pool.query(
    `SELECT p.* FROM problems p
     JOIN problem_usage pu ON pu.problem_id = p.external_id
     WHERE p.catalog_state IN ('present', 'mirror')
       AND pu.local_status = 'present'
       AND (
         p.dirty = true
         OR NOT EXISTS (SELECT 1 FROM snapshots s WHERE s.problem_id = p.external_id AND s.state = 'ready')
       )
     ORDER BY p.observed_at ASC, p.external_id ASC
     LIMIT $1`,
    [limit],
  );
  const scheduled = [];
  let skipped = 0;
  for (const row of rows) {
    const problem = rowToProblem(row);
    try {
      const dirty = problem.dirty ? problem : await markDirtyIfNoReady(pool, problem.external_id) ?? problem;
      const jobs = await scheduleAutoSnapshotJobs(pool, dirty, actor);
      if (jobs) scheduled.push({ problem_id: problem.external_id, ...jobs });
    } catch (err) {
      // The watcher or an ensure-ready call already owns an active operation
      // for this problem; skip it and let that flow finish the snapshot.
      if (err instanceof ProblemOperationConflictError) {
        skipped++;
        continue;
      }
      throw err;
    }
  }
  return scheduled;
}

export async function markProblemDirtyIdempotent(
  pool: Pool,
  idempotencyKey: string,
  actor: string,
  problem: {
    externalId: string;
    code: string;
    ownerOrganization: string | null;
    isManuallyManaged: boolean;
    mirrorOf: string | null;
    mirrorRoot: string | null;
    quotaBytes: number | string | null;
    schemaVersion: number;
    catalogState?: string;
  },
): Promise<{ problem: ProblemT; mutated: boolean }> {
  const catalogState = problem.catalogState === 'deleted' ? 'deleted' : 'present';
  const fingerprint = stableFingerprint({
    external_id: problem.externalId,
    code: problem.code,
    owner_organization: problem.ownerOrganization,
    is_manually_managed: problem.isManuallyManaged,
    mirror_of: problem.mirrorOf,
    mirror_root: problem.mirrorRoot,
    quota_bytes: problem.quotaBytes,
    schema_version: problem.schemaVersion,
    catalog_state: catalogState,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize watcher orphan discovery and catalog claims for the same folder.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [problem.code]);
    const existingCode = await client.query(
      `SELECT external_id, catalog_state
       FROM problems
       WHERE code = $1
       FOR UPDATE`,
      [problem.code],
    );
    const codeOwner = existingCode.rows[0] as { external_id: string; catalog_state: string } | undefined;
    if (codeOwner && codeOwner.external_id !== problem.externalId) {
      const expectedOrphanId = `orphan:${problem.code}`;
      if (codeOwner.catalog_state !== 'orphan' || codeOwner.external_id !== expectedOrphanId) {
        throw new CatalogCodeConflictError(problem.code, codeOwner.external_id);
      }
      // Migration 006 makes every dependent FK cascade this identity change.
      // This preserves the watcher scan instead of deleting and recreating it.
      await client.query(
        `UPDATE problems
         SET external_id = $2
         WHERE external_id = $1 AND code = $3 AND catalog_state = 'orphan'`,
        [expectedOrphanId, problem.externalId, problem.code],
      );
    }
    const inserted = await client.query(
      `INSERT INTO idempotency_keys (idempotency_key, scope, actor, request_fingerprint, target_type, target_id)
       VALUES ($1, 'problem.dirty', $2, $3, 'problem', $4)
       ON CONFLICT (idempotency_key, scope) DO NOTHING
       RETURNING *`,
      [idempotencyKey, actor, fingerprint, problem.externalId],
    );
    if (!inserted.rows[0]) {
      const existing = await client.query(
        `SELECT * FROM idempotency_keys
         WHERE idempotency_key = $1 AND scope = 'problem.dirty'
         FOR UPDATE`,
        [idempotencyKey],
      );
      const row = existing.rows[0];
      if (!row || row.request_fingerprint !== fingerprint || row.target_id !== problem.externalId) {
        throw new IdempotencyConflictError();
      }
      const replay = await client.query('SELECT * FROM problems WHERE external_id = $1', [row.response_problem_id ?? problem.externalId]);
      if (!replay.rows[0]) throw new IdempotencyConflictError();
      await client.query('COMMIT');
      return { problem: rowToProblem(replay.rows[0]), mutated: false };
    }

    const mutationSql = catalogState === 'deleted'
      ? `INSERT INTO problems (external_id, code, owner_organization, is_manually_managed, mirror_of, mirror_root, quota_bytes, schema_version, catalog_state, dirty, dirty_generation, dirty_version, stale, observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'deleted', false, NULL, 0, false, now())
         ON CONFLICT (external_id) DO UPDATE SET
           code = EXCLUDED.code,
           owner_organization = EXCLUDED.owner_organization,
           is_manually_managed = EXCLUDED.is_manually_managed,
           mirror_of = EXCLUDED.mirror_of,
           mirror_root = EXCLUDED.mirror_root,
           quota_bytes = EXCLUDED.quota_bytes,
           schema_version = EXCLUDED.schema_version,
           catalog_state = 'deleted',
           dirty = false,
           dirty_generation = NULL,
           stale = false,
           observed_at = now()
         RETURNING *`
      : `INSERT INTO problems (external_id, code, owner_organization, is_manually_managed, mirror_of, mirror_root, quota_bytes, schema_version, catalog_state, dirty, dirty_generation, dirty_version, stale, observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'present', true, NULL, 1, true, now())
         ON CONFLICT (external_id) DO UPDATE SET
           code = EXCLUDED.code,
           owner_organization = EXCLUDED.owner_organization,
           is_manually_managed = EXCLUDED.is_manually_managed,
           mirror_of = EXCLUDED.mirror_of,
           mirror_root = EXCLUDED.mirror_root,
           quota_bytes = EXCLUDED.quota_bytes,
           schema_version = EXCLUDED.schema_version,
           catalog_state = 'present',
           dirty = true,
           dirty_version = problems.dirty_version + 1,
           dirty_generation = NULL,
           stale = true,
           observed_at = now()
         RETURNING *`;
    const { rows } = await client.query(
      mutationSql,
      [
        problem.externalId, problem.code, problem.ownerOrganization, problem.isManuallyManaged,
        problem.mirrorOf, problem.mirrorRoot, problem.quotaBytes, problem.schemaVersion,
      ],
    );
    let problemRow = rows[0];
    if (catalogState !== 'deleted') {
      const generation = await allocateGenerationOnClient(client, problem.externalId);
      const updated = await client.query(
        `UPDATE problems
         SET dirty_generation = $2
         WHERE external_id = $1 AND dirty = true
         RETURNING *`,
        [problem.externalId, generation],
      );
      problemRow = updated.rows[0];
    }
    await client.query(
      `UPDATE idempotency_keys
       SET response_problem_id = $3
       WHERE idempotency_key = $1 AND scope = 'problem.dirty' AND request_fingerprint = $2`,
      [idempotencyKey, fingerprint, problem.externalId],
    );
    await client.query('COMMIT');
    return { problem: rowToProblem(problemRow), mutated: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getProblem(pool: Pool, externalId: string): Promise<ProblemT | null> {
  const { rows } = await pool.query('SELECT * FROM problems WHERE external_id = $1', [externalId]);
  return rows[0] ? rowToProblem(rows[0]) : null;
}

export async function getProblemByCode(pool: Pool, code: string): Promise<ProblemT | null> {
  const { rows } = await pool.query('SELECT * FROM problems WHERE code = $1', [code]);
  return rows[0] ? rowToProblem(rows[0]) : null;
}

export async function listProblems(
  pool: Pool, opts: {
    search?: string; ownerOrg?: string; catalogState?: string;
    sort?: string; order?: 'asc' | 'desc'; cursor?: string; limit: number;
  },
): Promise<Page<ProblemT>> {
  const sortField = mapSortColumn(opts.sort || 'external_id', ['external_id', 'code', 'owner_organization', 'observed_at']);
  const sortCol = `p.${sortField}`;
  const order = opts.order === 'desc' ? 'DESC' : 'ASC';
  const limit = Math.min(opts.limit, 200);
  const params: unknown[] = [];
  let where = 'WHERE 1=1';
  let paramIdx = 1;

  if (opts.search) {
    where += ` AND (p.code ILIKE $${paramIdx} OR p.external_id::text ILIKE $${paramIdx})`;
    params.push(`%${opts.search}%`);
    paramIdx++;
  }
  if (opts.ownerOrg) {
    where += ` AND p.owner_organization = $${paramIdx}`;
    params.push(opts.ownerOrg);
    paramIdx++;
  }
  if (opts.catalogState) {
    where += ` AND p.catalog_state = $${paramIdx}`;
    params.push(opts.catalogState);
    paramIdx++;
  }

  let cursorCond = '';
  if (opts.cursor) {
    const c = decodeCursor<{ value: string; id: string }>(opts.cursor, { value: '', id: '' });
    const cmp = order === 'ASC' ? '>' : '<';
    cursorCond = ` AND (${sortCol}, p.external_id) ${cmp} ($${paramIdx}, $${paramIdx + 1})`;
    params.push(c.value, c.id);
    paramIdx += 2;
  }

  const sql = `SELECT p.*, pu.logical_bytes
    FROM problems p
    LEFT JOIN problem_usage pu ON pu.problem_id = p.external_id
    ${where} ${cursorCond}
    ORDER BY ${sortCol} ${order}, p.external_id ${order} LIMIT $${paramIdx}`;
  params.push(limit + 1);
  const { rows } = await pool.query(sql, params);

  const has_more = rows.length > limit;
  const items = rows.slice(0, limit).map(rowToProblem);
  let next_cursor: string | null = null;
  if (has_more && items.length > 0) {
    const last = rows[limit - 1];
    next_cursor = encodeCursor({ value: String(last[sortField] ?? ''), id: String(last.external_id) });
  }
  return { items, next_cursor, has_more };
}

function mapSortColumn(col: string, allowed: string[]): string {
  return allowed.includes(col) ? col : 'external_id';
}

function rowToProblem(r: Record<string, unknown>): ProblemT {
  return {
    external_id: String(r.external_id),
    code: String(r.code),
    ...(r.logical_bytes === null || r.logical_bytes === undefined ? {} : { logical_bytes: int8(r.logical_bytes) }),
    owner_organization: r.owner_organization as string | null,
    is_manually_managed: r.is_manually_managed as boolean,
    mirror_of: r.mirror_of as string | null,
    mirror_root: r.mirror_root as string | null,
    quota_bytes: r.quota_bytes === null || r.quota_bytes === undefined ? null : int8(r.quota_bytes),
    catalog_state: r.catalog_state as ProblemT['catalog_state'],
    dirty: Boolean(r.dirty ?? false),
    dirty_generation: r.dirty_generation === null || r.dirty_generation === undefined ? null : Number(r.dirty_generation),
    dirty_version: int8(r.dirty_version ?? 0),
    observed_at: toRfc3339(r.observed_at),
    stale: r.stale as boolean,
  };
}

// ===========================================================================
// Problem Usage
// ===========================================================================

export async function getProblemUsage(pool: Pool, externalId: string): Promise<ProblemUsageT | null> {
  const { rows } = await pool.query('SELECT * FROM problem_usage WHERE problem_id = $1', [externalId]);
  return rows[0] ? rowToProblemUsage(rows[0]) : null;
}

export async function getLatestReadySnapshot(pool: Pool, externalId: string): Promise<SnapshotT | null> {
  const { rows } = await pool.query(
    `SELECT * FROM snapshots
     WHERE problem_id = $1 AND state = 'ready'
     ORDER BY generation DESC, completed_at DESC NULLS LAST
     LIMIT 1`,
    [externalId],
  );
  return rows[0] ? rowToSnapshot(rows[0]) : null;
}

export async function listProblemFiles(
  pool: Pool, externalId: string, opts: { cursor?: string; limit: number },
): Promise<ProblemFilesResponseT> {
  const limit = Math.min(opts.limit, 500);
  const snap = await getLatestReadySnapshot(pool, externalId);
  if (!snap) {
    return {
      problem_id: externalId, generation: null, snapshot_id: null, snapshot_state: null,
      snapshot_completed_at: null, total_bytes: null, file_count: null,
      items: [], next_cursor: null, has_more: false,
    };
  }
  const params: unknown[] = [snap.id];
  let cursorCond = '';
  if (opts.cursor) {
    const c = decodeCursor<{ rel_path: string }>(opts.cursor, { rel_path: '' });
    params.push(c.rel_path);
    cursorCond = ` AND rel_path > $${params.length}`;
  }
  params.push(limit + 1);
  const { rows } = await pool.query(
    `SELECT * FROM snapshot_objects WHERE snapshot_id = $1${cursorCond} ORDER BY rel_path ASC LIMIT $${params.length}`,
    params,
  );
  const has_more = rows.length > limit;
  const items = rows.slice(0, limit).map((r: Record<string, unknown>) => ({
    snapshot_id: String(r.snapshot_id),
    rel_path: String(r.rel_path),
    sha256: String(r.sha256),
    size_bytes: int8(r.size_bytes),
    object_key: String(r.object_key),
    uploaded: Boolean(r.uploaded),
    verified: Boolean(r.verified),
  }));
  const next_cursor = has_more && items.length > 0
    ? encodeCursor({ rel_path: rows[limit - 1].rel_path })
    : null;
  return {
    problem_id: externalId,
    generation: snap.generation,
    snapshot_id: snap.id,
    snapshot_state: snap.state,
    snapshot_completed_at: snap.completed_at,
    total_bytes: snap.total_bytes,
    file_count: snap.file_count,
    items, next_cursor, has_more,
  };
}

export async function upsertProblemUsage(pool: Pool, externalId: string, usage: {
  logical_bytes?: number | string;
  allocated_bytes?: number | string;
  archive_bytes?: number | string;
  auxiliary_bytes?: number | string;
  file_count?: number;
  local_status?: string;
  r2_status?: string;
  snapshot_generation?: number | null;
  orphan_bytes?: number | string;
  referenced_bytes?: number | string;
  last_accessed_at?: string | null;
  observed_at?: string;
}): Promise<ProblemUsageT> {
  const { rows } = await pool.query(
    `INSERT INTO problem_usage (
       problem_id, logical_bytes, allocated_bytes, archive_bytes, auxiliary_bytes,
       file_count, local_status, r2_status, snapshot_generation, orphan_bytes,
       referenced_bytes, last_accessed_at, observed_at, stale
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, COALESCE($13::timestamptz, now()), false)
     ON CONFLICT (problem_id) DO UPDATE SET
       logical_bytes = EXCLUDED.logical_bytes,
       allocated_bytes = EXCLUDED.allocated_bytes,
       archive_bytes = EXCLUDED.archive_bytes,
       auxiliary_bytes = EXCLUDED.auxiliary_bytes,
       file_count = EXCLUDED.file_count,
       local_status = EXCLUDED.local_status,
       r2_status = EXCLUDED.r2_status,
       snapshot_generation = EXCLUDED.snapshot_generation,
       orphan_bytes = EXCLUDED.orphan_bytes,
       referenced_bytes = EXCLUDED.referenced_bytes,
       last_accessed_at = COALESCE(EXCLUDED.last_accessed_at, problem_usage.last_accessed_at),
       observed_at = EXCLUDED.observed_at,
       stale = false
     RETURNING *`,
    [
      externalId,
      usage.logical_bytes ?? 0,
      usage.allocated_bytes ?? 0,
      usage.archive_bytes ?? 0,
      usage.auxiliary_bytes ?? 0,
      usage.file_count ?? 0,
      usage.local_status ?? 'present',
      usage.r2_status ?? 'none',
      usage.snapshot_generation ?? null,
      usage.orphan_bytes ?? 0,
      usage.referenced_bytes ?? 0,
      usage.last_accessed_at ?? null,
      usage.observed_at ?? null,
    ],
  );
  return rowToProblemUsage(rows[0]);
}

export async function upsertProblemUsageForJob(pool: Pool, job: JobT, externalId: string, usage: Parameters<typeof upsertProblemUsage>[2]): Promise<ProblemUsageT> {
  await assertJobLease(pool, job);
  const result = await upsertProblemUsage(pool, externalId, usage);
  await assertJobLease(pool, job);
  return result;
}

export async function markLocalPresentForJob(pool: Pool, job: JobT, externalId: string, generation: number | null): Promise<void> {
  await assertJobLease(pool, job);
  await pool.query(
    `INSERT INTO problem_usage (
       problem_id, local_status, snapshot_generation, last_accessed_at, observed_at, stale
     )
     VALUES ($1, 'present', $2, now(), now(), false)
     ON CONFLICT (problem_id) DO UPDATE SET
       local_status = 'present',
       snapshot_generation = COALESCE($2, problem_usage.snapshot_generation),
       last_accessed_at = now(),
       observed_at = now(),
       stale = false`,
    [externalId, generation],
  );
  await assertJobLease(pool, job);
}

export async function clearDirtyAfterSnapshotForJob(pool: Pool, job: JobT, externalId: string, generation: number, dirtyVersion: number | string | null): Promise<void> {
  await assertJobLease(pool, job);
  if (dirtyVersion === null) return;
  await pool.query(
    `UPDATE problems
     SET dirty = false, dirty_generation = NULL, stale = false, observed_at = now()
     WHERE external_id = $1 AND dirty = true AND dirty_generation IS NOT NULL AND dirty_generation <= $2
       AND dirty_version = $3::bigint`,
    [externalId, generation, dirtyVersion],
  );
  await assertJobLease(pool, job);
}

export async function listProblemUsage(
  pool: Pool, opts: { cursor?: string; limit: number },
): Promise<Page<ProblemUsageT>> {
  const limit = Math.min(opts.limit, 200);
  const params: unknown[] = [];
  let cursorCond = '';
  let paramIdx = 1;
  if (opts.cursor) {
    const lastId = decodeCursor<string>(opts.cursor, '');
    cursorCond = ` WHERE problem_id > $${paramIdx}`;
    params.push(lastId);
    paramIdx++;
  }
  const sql = `SELECT * FROM problem_usage ${cursorCond} ORDER BY problem_id ASC LIMIT $${paramIdx}`;
  params.push(limit + 1);
  const { rows } = await pool.query(sql, params);
  const has_more = rows.length > limit;
  const items = rows.slice(0, limit).map(rowToProblemUsage);
  let next_cursor: string | null = null;
  if (has_more && items.length > 0) {
    next_cursor = encodeCursor(items[items.length - 1].problem_id);
  }
  return { items, next_cursor, has_more };
}

function rowToProblemUsage(r: Record<string, unknown>): ProblemUsageT {
  return {
    problem_id: String(r.problem_id),
    logical_bytes: int8(r.logical_bytes),
    allocated_bytes: int8(r.allocated_bytes),
    archive_bytes: int8(r.archive_bytes),
    auxiliary_bytes: int8(r.auxiliary_bytes),
    file_count: Number(r.file_count),
    local_status: r.local_status as ProblemUsageT['local_status'],
    r2_status: r.r2_status as ProblemUsageT['r2_status'],
    snapshot_generation: r.snapshot_generation !== null ? Number(r.snapshot_generation) : null,
    orphan_bytes: int8(r.orphan_bytes),
    referenced_bytes: int8(r.referenced_bytes),
    quota_bytes: r.quota_bytes === null || r.quota_bytes === undefined ? null : int8(r.quota_bytes),
    last_accessed_at: r.last_accessed_at === null || r.last_accessed_at === undefined
      ? null
      : toRfc3339(r.last_accessed_at),
    observed_at: toRfc3339(r.observed_at),
    stale: r.stale as boolean,
  };
}

// ===========================================================================
// Organization Usage (aggregated from problem_usage + problems)
// ===========================================================================

export async function getOrganizationUsage(pool: Pool, orgId: string): Promise<OrganizationUsageT | null> {
  const { rows } = await pool.query(
    `SELECT
       owner_organization AS organization_id,
       COUNT(*)::int AS problem_count,
       COALESCE(SUM(pu.logical_bytes), 0)::bigint AS logical_bytes,
       COALESCE(SUM(pu.allocated_bytes), 0)::bigint AS allocated_bytes,
       COALESCE(SUM(pu.archive_bytes), 0)::bigint AS archive_bytes,
       COALESCE(SUM(pu.auxiliary_bytes), 0)::bigint AS auxiliary_bytes,
       COALESCE(SUM(pu.referenced_bytes), 0)::bigint AS referenced_bytes,
       COALESCE(os.storage_quota_bytes, MAX(p.quota_bytes)) AS quota_bytes,
       os.problem_count_quota AS problem_count_quota,
       COALESCE(MAX(pu.observed_at), now()) AS observed_at,
       COALESCE(BOOL_OR(pu.stale), true) AS stale
     FROM problems p
     LEFT JOIN problem_usage pu ON pu.problem_id = p.external_id
     LEFT JOIN organization_settings os ON os.organization_id = p.owner_organization
     WHERE p.owner_organization = $1
       AND p.catalog_state IN ('present', 'mirror')
     GROUP BY p.owner_organization, os.storage_quota_bytes, os.problem_count_quota`,
    [orgId],
  );
  return rows[0] ? rowToOrgUsage(rows[0]) : null;
}

export async function listOrganizationUsage(
  pool: Pool, opts: { cursor?: string; limit: number },
): Promise<Page<OrganizationUsageT>> {
  const limit = Math.min(opts.limit, 200);
  const params: unknown[] = [];
  let cursorCond = '';
  let paramIdx = 1;
  if (opts.cursor) {
    const lastOrg = decodeCursor<string>(opts.cursor, '');
    cursorCond = ` WHERE owner_organization > $${paramIdx}`;
    params.push(lastOrg);
    paramIdx++;
  }
  const sql = `
    SELECT
      p.owner_organization AS organization_id,
      COUNT(*)::int AS problem_count,
      COALESCE(SUM(pu.logical_bytes), 0)::bigint AS logical_bytes,
      COALESCE(SUM(pu.allocated_bytes), 0)::bigint AS allocated_bytes,
      COALESCE(SUM(pu.archive_bytes), 0)::bigint AS archive_bytes,
      COALESCE(SUM(pu.auxiliary_bytes), 0)::bigint AS auxiliary_bytes,
      COALESCE(SUM(pu.referenced_bytes), 0)::bigint AS referenced_bytes,
      COALESCE(os.storage_quota_bytes, MAX(p.quota_bytes)) AS quota_bytes,
      os.problem_count_quota AS problem_count_quota,
      COALESCE(MAX(pu.observed_at), now()) AS observed_at,
      COALESCE(BOOL_OR(pu.stale), true) AS stale
    FROM problems p
    LEFT JOIN problem_usage pu ON pu.problem_id = p.external_id
    LEFT JOIN organization_settings os ON os.organization_id = p.owner_organization
    WHERE p.owner_organization IS NOT NULL AND p.catalog_state IN ('present', 'mirror') ${cursorCond ? cursorCond.replace('WHERE', 'AND') : ''}
    GROUP BY p.owner_organization, os.storage_quota_bytes, os.problem_count_quota
    ORDER BY p.owner_organization ASC
    LIMIT $${paramIdx}`;
  params.push(limit + 1);
  const { rows } = await pool.query(sql, params);
  const has_more = rows.length > limit;
  const items = rows.slice(0, limit).map(rowToOrgUsage);
  let next_cursor: string | null = null;
  if (has_more && items.length > 0) {
    next_cursor = encodeCursor(items[items.length - 1].organization_id);
  }
  return { items, next_cursor, has_more };
}

function rowToOrgUsage(r: Record<string, unknown>): OrganizationUsageT {
  return {
    organization_id: String(r.organization_id),
    problem_count: Number(r.problem_count),
    logical_bytes: int8(r.logical_bytes),
    allocated_bytes: int8(r.allocated_bytes),
    archive_bytes: int8(r.archive_bytes),
    auxiliary_bytes: int8(r.auxiliary_bytes),
    referenced_bytes: int8(r.referenced_bytes),
    quota_bytes: r.quota_bytes === null || r.quota_bytes === undefined ? null : int8(r.quota_bytes),
    problem_count_quota: r.problem_count_quota === null || r.problem_count_quota === undefined ? null : Number(r.problem_count_quota),
    observed_at: toRfc3339(r.observed_at),
    stale: r.stale as boolean,
  };
}

export async function upsertOrganizationSettings(
  pool: Pool,
  organizationId: string,
  storageQuotaBytes: number | string | null,
  problemCountQuota: number | null,
): Promise<Record<string, unknown>> {
  const { rows } = await pool.query(
    `INSERT INTO organization_settings (organization_id, storage_quota_bytes, problem_count_quota, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (organization_id) DO UPDATE SET
       storage_quota_bytes = EXCLUDED.storage_quota_bytes,
       problem_count_quota = EXCLUDED.problem_count_quota,
       updated_at = now()
     RETURNING *`,
    [organizationId, storageQuotaBytes, problemCountQuota],
  );
  return rows[0] as Record<string, unknown>;
}

// ===========================================================================
// Snapshots
// ===========================================================================

export async function listSnapshots(
  pool: Pool, problemId: string | null, opts: { cursor?: string; limit: number },
): Promise<Page<SnapshotT>> {
  const limit = Math.min(opts.limit, 200);
  const params: unknown[] = [];
  let where = 'WHERE 1=1';
  let paramIdx = 1;
  if (problemId) {
    where += ` AND problem_id = $${paramIdx}`;
    params.push(problemId);
    paramIdx++;
  }
  let cursorCond = '';
  if (opts.cursor) {
    const c = decodeCursor<{ created_at: string; id: string }>(opts.cursor, { created_at: new Date(0).toISOString(), id: '' });
    cursorCond = ` AND (created_at, id) < ($${paramIdx}::timestamptz, $${paramIdx + 1}::uuid)`;
    params.push(c.created_at, c.id);
    paramIdx += 2;
  }
  const sql = `SELECT * FROM snapshots ${where} ${cursorCond} ORDER BY created_at DESC, id DESC LIMIT $${paramIdx}`;
  params.push(limit + 1);
  const { rows } = await pool.query(sql, params);
  const has_more = rows.length > limit;
  const items = rows.slice(0, limit).map(rowToSnapshot);
  let next_cursor: string | null = null;
  if (has_more && items.length > 0) {
    next_cursor = encodeCursor({ created_at: toRfc3339(rows[limit - 1].created_at), id: String(rows[limit - 1].id) });
  }
  return { items, next_cursor, has_more };
}

export async function getSnapshot(pool: Pool, id: string): Promise<SnapshotT | null> {
  const { rows } = await pool.query('SELECT * FROM snapshots WHERE id = $1', [id]);
  return rows[0] ? rowToSnapshot(rows[0]) : null;
}

export async function getSnapshotByGeneration(pool: Pool, problemId: string, generation: number): Promise<SnapshotT | null> {
  const { rows } = await pool.query(
    'SELECT * FROM snapshots WHERE problem_id = $1 AND generation = $2',
    [problemId, generation],
  );
  return rows[0] ? rowToSnapshot(rows[0]) : null;
}

// Snapshots whose uploader died (process restart mid-upload) would otherwise
// sit in a non-terminal state forever; the data plane only takes over rows
// stale for 30 minutes, so sweep anything non-terminal after 6 hours.
export async function failStalledSnapshots(pool: Pool): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE snapshots
     SET state = 'error',
         error_code = 'stalled',
         error_message = 'snapshot stalled in a non-terminal state (no live uploader)',
         completed_at = now()
     WHERE state IN ('discovered', 'hashing', 'uploading', 'verifying')
       AND created_at < now() - interval '6 hours'`,
  );
  return rowCount ?? 0;
}

function rowToSnapshot(r: Record<string, unknown>): SnapshotT {
  return {
    id: String(r.id),
    problem_id: String(r.problem_id),
    generation: Number(r.generation),
    state: r.state as SnapshotT['state'],
    file_count: Number(r.file_count),
    total_bytes: int8(r.total_bytes),
    manifest_key: r.manifest_key as string | null,
    error_code: r.error_code as string | null,
    error_message: r.error_message as string | null,
    created_at: toRfc3339(r.created_at),
    completed_at: r.completed_at ? toRfc3339(r.completed_at) : null,
  };
}

// ===========================================================================
// Jobs
// ===========================================================================

type JobQueryable = Pick<Pool | PoolClient, 'query'>;

const localProblemJobTypes = ['scan', 'snapshot', 'restore', 'evict'];

function isActiveProblemOperationConstraint(err: unknown): boolean {
  const pg = err as { code?: string; constraint?: string };
  return pg?.code === '23505' && (
    pg?.constraint === 'idx_jobs_one_active_problem_job_type'
    || pg?.constraint === 'idx_jobs_one_running_problem_operation'
  );
}

function isActiveGcConstraint(err: unknown): boolean {
  const pg = err as { code?: string; constraint?: string };
  return pg?.code === '23505' && pg?.constraint === 'idx_jobs_one_active_gc_collect';
}

export async function createJob(
  pool: JobQueryable, opts: {
    idempotencyKey: string; jobType: string; problemId: string | null;
    targetGeneration: number | null; leaseOwner: string; requestFingerprint?: string;
  },
): Promise<JobT> {
  const fingerprint = opts.requestFingerprint ?? stableFingerprint({
    job_type: opts.jobType,
    problem_id: opts.problemId,
    target_generation: opts.targetGeneration,
  });
  let rows: Record<string, unknown>[];
  try {
    ({ rows } = await pool.query(
    `WITH lock AS (
       SELECT pg_advisory_xact_lock(hashtextextended(
         CASE
           WHEN $3::text IS NOT NULL
             AND $2::text = ANY(ARRAY['scan','snapshot','restore','evict']::text[])
             THEN 'problem-operation:' || $3::text
           ELSE $2::text || ':' || COALESCE($3::text, '') || ':' || COALESCE($4::text, '')
         END,
         0
       ))
     ),
     key_row AS MATERIALIZED (
       SELECT j.*
       FROM jobs j, lock
       WHERE j.idempotency_key = $1 AND j.job_type = $2
       FOR UPDATE OF j
     ),
     replay AS (
       UPDATE jobs
       SET updated_at = now()
       WHERE id = (
         SELECT id FROM key_row
         WHERE problem_id IS NOT DISTINCT FROM $3
           AND target_generation IS NOT DISTINCT FROM $4::integer
           AND request_fingerprint = $5
       )
       RETURNING *
     ),
     key_conflict AS (
       SELECT 1 FROM key_row
       WHERE NOT (
         problem_id IS NOT DISTINCT FROM $3
         AND target_generation IS NOT DISTINCT FROM $4::integer
         AND request_fingerprint = $5
       )
     ),
     active AS (
       UPDATE jobs
       SET updated_at = now()
       WHERE id = (
         SELECT id FROM jobs, lock
         WHERE job_type = $2
           AND problem_id IS NOT DISTINCT FROM $3
           AND target_generation IS NOT DISTINCT FROM $4::integer
           AND (
             request_fingerprint = $5
             OR $2 = ANY(ARRAY['scan','snapshot','restore','gc_collect'])
           )
           AND state IN ('pending', 'running')
           AND NOT EXISTS (SELECT 1 FROM replay)
           AND NOT EXISTS (SELECT 1 FROM key_conflict)
         ORDER BY created_at ASC
         LIMIT 1
       )
       RETURNING *
     ),
     incompatible AS (
       SELECT 1
       FROM jobs, lock
       WHERE $3::text IS NOT NULL
         AND jobs.problem_id = $3::text
         AND jobs.job_type = ANY(ARRAY['scan','snapshot','restore','evict']::text[])
         AND jobs.state IN ('pending', 'running')
         AND NOT (
           ($2::text = 'scan' AND jobs.job_type = 'snapshot')
           OR ($2::text = 'snapshot' AND jobs.job_type = 'scan')
         )
         AND NOT EXISTS (SELECT 1 FROM active)
         AND NOT EXISTS (SELECT 1 FROM replay)
       LIMIT 1
     ),
     inserted AS (
       INSERT INTO jobs (idempotency_key, job_type, problem_id, target_generation, state, lease_owner, lease_expires_at, fencing_token, attempt, max_attempts, request_fingerprint)
       SELECT $1, $2, $3, $4::integer, 'pending', NULL, NULL, 0, 1, 3, $5
       FROM lock
       WHERE NOT EXISTS (SELECT 1 FROM replay)
         AND NOT EXISTS (SELECT 1 FROM active)
         AND NOT EXISTS (SELECT 1 FROM key_conflict)
         AND NOT EXISTS (SELECT 1 FROM incompatible)
       ON CONFLICT (idempotency_key, job_type) DO UPDATE SET
         updated_at = now()
       WHERE jobs.problem_id IS NOT DISTINCT FROM EXCLUDED.problem_id
         AND jobs.target_generation IS NOT DISTINCT FROM EXCLUDED.target_generation
         AND jobs.request_fingerprint = EXCLUDED.request_fingerprint
       RETURNING *
     )
     SELECT * FROM replay
     UNION ALL
     SELECT * FROM active
     UNION ALL
     SELECT * FROM inserted
     LIMIT 1`,
    [opts.idempotencyKey, opts.jobType, opts.problemId, opts.targetGeneration, fingerprint],
    ));
  } catch (err) {
    if (opts.problemId && isActiveProblemOperationConstraint(err)) {
      throw new ProblemOperationConflictError(opts.problemId);
    }
    if (opts.jobType === 'gc_collect' && isActiveGcConstraint(err)) {
      const active = await pool.query(
        `SELECT * FROM jobs
         WHERE job_type = 'gc_collect'
           AND problem_id IS NULL
           AND state IN ('pending', 'running')
         ORDER BY created_at ASC
         LIMIT 1`,
      );
      if (active.rows[0]) return rowToJob(active.rows[0]);
    }
    throw err;
  }
  if (!rows[0]) {
    const keyConflict = await pool.query(
      `SELECT 1 FROM jobs
       WHERE idempotency_key = $1 AND job_type = $2
       LIMIT 1`,
      [opts.idempotencyKey, opts.jobType],
    );
    if (keyConflict.rows[0]) throw new IdempotencyConflictError();
    if (opts.problemId && localProblemJobTypes.includes(opts.jobType)) {
      const active = await pool.query(
        `SELECT 1 FROM jobs
         WHERE problem_id = $1
           AND job_type = ANY($2::text[])
           AND state IN ('pending', 'running')
         LIMIT 1`,
        [opts.problemId, localProblemJobTypes],
      );
      if (active.rows[0]) throw new ProblemOperationConflictError(opts.problemId);
    }
    throw new Error('Job creation produced no result');
  }
  return rowToJob(rows[0]);
}

export async function cancelPendingLocalJobsForRestore(pool: Pool, externalId: string): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE jobs
     SET state = 'cancelled', completed_at = now(),
         error_code = 'superseded_by_restore', error_message = 'cancelled: local folder missing, restore takes over'
     WHERE problem_id = $1
       AND job_type IN ('scan', 'snapshot')
       AND state = 'pending'`,
    [externalId],
  );
  return rowCount ?? 0;
}

export async function createRestoreJobIfMissing(
  pool: Pool,
  opts: {
    idempotencyKey: string;
    problemId: string;
    targetGeneration: number;
    leaseOwner: string;
    requestFingerprint: string;
    missingObservedAt: string;
  },
): Promise<{ ready: true; job: null } | { ready: false; job: JobT }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended('problem-operation:' || $1, 0)
       )`,
      [opts.problemId],
    );

    const replay = await client.query(
      `SELECT * FROM jobs
       WHERE idempotency_key = $1 AND job_type = 'restore'
       FOR UPDATE`,
      [opts.idempotencyKey],
    );
    if (replay.rows[0]) {
      const replayRow = replay.rows[0];
      const job = rowToJob(replayRow);
      if (
        job.problem_id !== opts.problemId
        || job.target_generation !== opts.targetGeneration
        || String(replayRow.request_fingerprint ?? '') !== opts.requestFingerprint
      ) {
        throw new IdempotencyConflictError();
      }
      await client.query('COMMIT');
      return { ready: false, job };
    }

    const active = await client.query(
      `SELECT * FROM jobs
       WHERE problem_id = $1
         AND job_type = 'restore'
         AND target_generation = $2
         AND state IN ('pending', 'running')
       ORDER BY created_at ASC, id ASC
       LIMIT 1
       FOR UPDATE`,
      [opts.problemId, opts.targetGeneration],
    );
    if (active.rows[0]) {
      await client.query('COMMIT');
      return { ready: false, job: rowToJob(active.rows[0]) };
    }

    // A restore means the local folder is gone, so any pending scan/snapshot
    // for this problem is dead weight (it would fail on the missing folder)
    // and its uniqueness slot would block the restore job below. Cancel it
    // inside the same transaction; the watcher re-schedules a snapshot after
    // the restore completes and the folder is present again.
    await client.query(
      `UPDATE jobs
       SET state = 'cancelled', completed_at = now(),
           error_code = 'superseded_by_restore', error_message = 'cancelled: local folder missing, restore takes over'
       WHERE problem_id = $1
         AND job_type IN ('scan', 'snapshot')
         AND state = 'pending'`,
      [opts.problemId],
    );
    const usage = await client.query(
      `SELECT local_status, observed_at
       FROM problem_usage
       WHERE problem_id = $1
       FOR UPDATE`,
      [opts.problemId],
    );
    if (
      usage.rows[0]?.local_status === 'present'
      && new Date(usage.rows[0].observed_at).getTime() >= new Date(opts.missingObservedAt).getTime()
    ) {
      await client.query('COMMIT');
      return { ready: true, job: null };
    }

    await client.query(
      `INSERT INTO problem_usage (problem_id, local_status, observed_at, stale)
       VALUES ($1, 'missing', $2::timestamptz, false)
       ON CONFLICT (problem_id) DO UPDATE SET
         local_status = 'missing',
         observed_at = GREATEST(problem_usage.observed_at, EXCLUDED.observed_at),
         stale = false`,
      [opts.problemId, opts.missingObservedAt],
    );

    const job = await createJob(client, {
      idempotencyKey: opts.idempotencyKey,
      jobType: 'restore',
      problemId: opts.problemId,
      targetGeneration: opts.targetGeneration,
      leaseOwner: opts.leaseOwner,
      requestFingerprint: opts.requestFingerprint,
    });
    await client.query('COMMIT');
    return { ready: false, job };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function touchProblemAccess(pool: Pool, problemId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // This is the same lock namespace held by the Rust destructive eviction
    // transaction. A concurrent submission either updates the fence first or
    // waits for eviction to finish and then observes/restores the missing copy.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 2907))`,
      [problemId],
    );
    await client.query(
      `UPDATE problem_usage
       SET last_accessed_at = now()
       WHERE problem_id = $1`,
      [problemId],
    );
    await client.query(
      `UPDATE jobs
       SET state = 'cancelled',
           error_code = 'problem_became_active',
           error_message = 'Cancelled because ensure-ready observed new problem activity',
           completed_at = now(),
           lease_owner = NULL,
           lease_expires_at = NULL
       WHERE problem_id = $1
         AND job_type = 'evict'
         AND state = 'pending'`,
      [problemId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function allocateGeneration(pool: Pool, problemId: string): Promise<number> {
  return allocateGenerationOnClient(pool, problemId);
}

async function allocateGenerationOnClient(client: Pick<Pool | PoolClient, 'query'>, problemId: string): Promise<number> {
  const { rows } = await client.query(
    `INSERT INTO problem_generation_counters (problem_id, next_generation)
     VALUES ($1, 2)
     ON CONFLICT (problem_id) DO UPDATE
     SET next_generation = problem_generation_counters.next_generation + 1
     RETURNING next_generation - 1 AS generation`,
    [problemId],
  );
  return Number(rows[0].generation);
}

export type JobLane = 'restore' | 'bulk';

export async function acquireJob(pool: Pool, workerId: string, leaseSeconds: number, lane: JobLane = 'bulk'): Promise<JobT | null> {
  await failExpiredRunningJobs(pool);
  let rows: Record<string, unknown>[];
  try {
    ({ rows } = await pool.query(
    `WITH candidate AS (
       SELECT id FROM jobs
       WHERE attempt < max_attempts
         AND (
           (state = 'pending' AND NOT EXISTS (SELECT 1 FROM queue_state WHERE name = 'default' AND paused))
           OR (state = 'running' AND lease_expires_at < now())
         )
         ${lane === 'restore' ? "AND job_type = 'restore'" : ''}
       ORDER BY ${lane === 'restore' ? 'created_at ASC, id ASC' : "(job_type = 'restore') DESC, created_at ASC, id ASC"}
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     ), token AS (
       INSERT INTO job_fencing_counters (problem_id, next_token)
       SELECT COALESCE(j.problem_id, '__global__'), 2
       FROM jobs j JOIN candidate c ON c.id = j.id
       ON CONFLICT (problem_id) DO UPDATE
       SET next_token = job_fencing_counters.next_token + 1
       RETURNING next_token - 1 AS fencing_token
     )
     UPDATE jobs j
     SET state = 'running',
         lease_owner = $1,
         lease_expires_at = now() + ($2::text || ' seconds')::interval,
         fencing_token = (SELECT fencing_token FROM token),
         attempt = CASE WHEN j.state = 'pending' THEN j.attempt ELSE j.attempt + 1 END,
         error_code = NULL,
         error_message = NULL
     FROM candidate
     WHERE j.id = candidate.id AND j.attempt < j.max_attempts
     RETURNING j.*`,
    [workerId, leaseSeconds],
    ));
  } catch (err) {
    if (isActiveProblemOperationConstraint(err)) return null;
    throw err;
  }
  return rows[0] ? rowToJob(rows[0]) : null;
}

export async function renewJobLease(pool: Pool, id: string, workerId: string, fencingToken: number, leaseSeconds: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE jobs SET lease_expires_at = now() + ($3::text || ' seconds')::interval
     WHERE id = $1 AND lease_owner = $2 AND fencing_token = $4 AND state = 'running'
       AND lease_expires_at >= now()
       AND requested_cancel_at IS NULL`,
    [id, workerId, leaseSeconds, fencingToken],
  );
  return (rowCount ?? 0) > 0;
}

export async function assertJobLease(pool: Pool, job: JobT): Promise<void> {
  const { rows } = await pool.query(
    `SELECT 1 FROM jobs
     WHERE id = $1 AND lease_owner = $2 AND fencing_token = $3
       AND state = 'running' AND lease_expires_at >= now()
       AND requested_cancel_at IS NULL`,
    [job.id, job.lease_owner, job.fencing_token],
  );
  if (rows.length === 0) throw new JobLeaseLostError(job.id);
}

export async function getJob(pool: Pool, id: string): Promise<JobT | null> {
  const { rows } = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
  return rows[0] ? rowToJob(rows[0]) : null;
}

export async function listJobs(
  pool: Pool, opts: {
    state?: string; problemId?: string; cursor?: string; limit: number;
  },
): Promise<Page<JobT>> {
  const limit = Math.min(opts.limit, 200);
  const params: unknown[] = [];
  let where = 'WHERE 1=1';
  let paramIdx = 1;
  if (opts.state) {
    where += ` AND state = $${paramIdx}`;
    params.push(opts.state);
    paramIdx++;
  }
  if (opts.problemId) {
    where += ` AND problem_id = $${paramIdx}`;
    params.push(opts.problemId);
    paramIdx++;
  }
  let cursorCond = '';
  if (opts.cursor) {
    const c = decodeCursor<{ created_at: string; id: string }>(opts.cursor, { created_at: new Date(0).toISOString(), id: '' });
    cursorCond = ` AND (created_at, id) < ($${paramIdx}::timestamptz, $${paramIdx + 1}::uuid)`;
    params.push(c.created_at, c.id);
    paramIdx += 2;
  }
  const sql = `SELECT * FROM jobs ${where} ${cursorCond} ORDER BY created_at DESC, id DESC LIMIT $${paramIdx}`;
  params.push(limit + 1);
  const { rows } = await pool.query(sql, params);
  const has_more = rows.length > limit;
  const items = rows.slice(0, limit).map(rowToJob);
  let next_cursor: string | null = null;
  if (has_more && items.length > 0) {
    next_cursor = encodeCursor({ created_at: toRfc3339(rows[limit - 1].created_at), id: String(rows[limit - 1].id) });
  }
  return { items, next_cursor, has_more };
}

export async function completeJobWithLease(
  pool: Pool, job: JobT, state: 'completed' | 'failed' | 'cancelled', result: unknown | null, errorCode: string | null, errorMessage: string | null,
): Promise<JobT | null> {
  const { rows } = await pool.query(
    `UPDATE jobs SET state = $2, result = $3, error_code = $4, error_message = $5,
       completed_at = now()
     WHERE id = $1
       AND lease_owner = $6
       AND fencing_token = $7
       AND state = 'running'
       AND lease_expires_at >= now()
       AND requested_cancel_at IS NULL
     RETURNING *`,
    [job.id, state, JSON.stringify(result), errorCode, errorMessage, job.lease_owner, job.fencing_token],
  );
  return rows[0] ? rowToJob(rows[0]) : null;
}

export async function updateJobState(
  pool: Pool, id: string, state: string, result: unknown | null, errorCode: string | null, errorMessage: string | null,
): Promise<JobT | null> {
  const { rows } = await pool.query(
    `UPDATE jobs SET state = $2, result = $3, error_code = $4, error_message = $5,
       completed_at = CASE WHEN $2 IN ('completed','failed','cancelled') THEN now() ELSE NULL END
     WHERE id = $1 AND state <> 'running'
     RETURNING *`,
    [id, state, JSON.stringify(result), errorCode, errorMessage],
  );
  return rows[0] ? rowToJob(rows[0]) : null;
}

export async function setJobPayload(pool: Pool, id: string, payload: unknown): Promise<JobT | null> {
  const { rows } = await pool.query(
    `UPDATE jobs SET result = $2 WHERE id = $1 AND state = 'pending' RETURNING *`,
    [id, JSON.stringify(payload)],
  );
  return rows[0] ? rowToJob(rows[0]) : null;
}

export async function failExpiredRunningJobs(pool: Pool): Promise<number> {
  const { rowCount } = await pool.query(
    `WITH locked AS (
       SELECT id, COALESCE(problem_id, '__global__') AS counter_key
       FROM jobs
       WHERE state = 'running' AND lease_expires_at < now() AND attempt >= max_attempts
       FOR UPDATE
     ), revoked AS (
       SELECT id, counter_key,
              ROW_NUMBER() OVER (PARTITION BY counter_key ORDER BY id) AS rn
       FROM locked
     ), grouped AS (
       SELECT counter_key, COUNT(*)::bigint AS cnt FROM revoked GROUP BY counter_key
     ), bumped AS (
       INSERT INTO job_fencing_counters (problem_id, next_token)
       SELECT counter_key, cnt + 1 FROM grouped
       ON CONFLICT (problem_id) DO UPDATE
       SET next_token = job_fencing_counters.next_token + EXCLUDED.next_token - 1
       RETURNING problem_id, next_token
     ), assigned AS (
       SELECT r.id, b.next_token - g.cnt + r.rn - 1 AS fencing_token
       FROM revoked r
       JOIN grouped g ON g.counter_key = r.counter_key
       JOIN bumped b ON b.problem_id = r.counter_key
     )
     UPDATE jobs j SET state = 'failed',
       fencing_token = a.fencing_token,
       error_code = 'lease_expired',
       error_message = 'Worker lease expired before completion',
       completed_at = now()
     FROM assigned a
     WHERE j.id = a.id`,
  );
  return rowCount ?? 0;
}

export async function applyRetention(pool: Pool): Promise<Record<string, number>> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('snapshot-retention:apply', 2907))`,
    );
    const jobs = await client.query(
      `DELETE FROM jobs
       WHERE completed_at < now() - make_interval(days => (
         SELECT retention_days FROM retention_config WHERE entity_type = 'jobs'
       ))`,
    );
    const audits = await client.query(
      `DELETE FROM audit_events
       WHERE created_at < now() - make_interval(days => (
         SELECT retention_days FROM retention_config WHERE entity_type = 'audit_events'
       ))`,
    );

    // Metadata is pruned only after every private object was collected. Shared
    // content may remain because a live snapshot still references it.
    const pruned = await client.query(
      `WITH expired AS (
         SELECT s.*
         FROM snapshots s
         WHERE (
           s.state = 'superseded'
           AND s.superseded_at < now() - make_interval(days => (
             SELECT retention_days FROM retention_config
             WHERE entity_type = 'superseded_snapshots'
           ))
         ) OR (
           s.state = 'error'
           AND s.completed_at < now() - make_interval(days => (
             SELECT retention_days FROM retention_config
             WHERE entity_type = 'error_snapshots'
           ))
         )
       )
       DELETE FROM snapshots target
       USING expired
       WHERE target.id = expired.id
         AND (
           expired.manifest_key IS NULL
           OR EXISTS (
             SELECT 1 FROM gc_marks gm
             WHERE gm.object_key = expired.manifest_key AND gm.collected
           )
           OR EXISTS (
             SELECT 1 FROM snapshots live_manifest
             WHERE live_manifest.id <> expired.id
               AND live_manifest.manifest_key = expired.manifest_key
               AND snapshot_is_gc_protected(
                 live_manifest.state,
                 live_manifest.superseded_at,
                 live_manifest.completed_at
               )
           )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM snapshot_objects old_object
           WHERE old_object.snapshot_id = expired.id
             AND NOT (
               EXISTS (
                 SELECT 1 FROM gc_marks gm
                 WHERE gm.object_key = old_object.object_key AND gm.collected
               )
               OR EXISTS (
                 SELECT 1
                 FROM snapshot_objects live_object
                 JOIN snapshots live_snapshot ON live_snapshot.id = live_object.snapshot_id
                 WHERE live_object.object_key = old_object.object_key
                   AND live_snapshot.id <> expired.id
                   AND snapshot_is_gc_protected(
                     live_snapshot.state,
                     live_snapshot.superseded_at,
                     live_snapshot.completed_at
                   )
               )
             )
         )`,
    );

    const marked = await client.query(
      `WITH expired AS (
         SELECT s.*
         FROM snapshots s
         WHERE (
           s.state = 'superseded'
           AND s.superseded_at < now() - make_interval(days => (
             SELECT retention_days FROM retention_config
             WHERE entity_type = 'superseded_snapshots'
           ))
         ) OR (
           s.state = 'error'
           AND s.completed_at < now() - make_interval(days => (
             SELECT retention_days FROM retention_config
             WHERE entity_type = 'error_snapshots'
           ))
         )
       ), candidates AS (
         SELECT old_object.sha256, old_object.object_key, expired.id AS snapshot_id,
                'content'::text AS object_kind,
                COALESCE(expired.superseded_at, expired.completed_at) AS retention_anchor
         FROM expired
         JOIN snapshot_objects old_object ON old_object.snapshot_id = expired.id
         WHERE NOT EXISTS (
           SELECT 1
           FROM snapshot_objects live_object
           JOIN snapshots live_snapshot ON live_snapshot.id = live_object.snapshot_id
           WHERE live_object.object_key = old_object.object_key
             AND snapshot_is_gc_protected(
               live_snapshot.state,
               live_snapshot.superseded_at,
               live_snapshot.completed_at
             )
         )
         UNION
         SELECT 'manifest:' || expired.id::text, expired.manifest_key, expired.id,
                'manifest'::text,
                COALESCE(expired.superseded_at, expired.completed_at)
         FROM expired
         WHERE expired.manifest_key IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM snapshots live_manifest
             WHERE live_manifest.manifest_key = expired.manifest_key
               AND snapshot_is_gc_protected(
                 live_manifest.state,
                 live_manifest.superseded_at,
                 live_manifest.completed_at
               )
           )
       )
       INSERT INTO gc_marks
         (sha256, object_key, snapshot_id, object_kind, marked_at, eligible_at,
          collected, collected_at, attempts, last_error)
       SELECT DISTINCT ON (object_key)
         sha256, object_key, snapshot_id, object_kind, now(),
         now() + make_interval(days => (
           SELECT retention_days FROM retention_config
           WHERE entity_type = 'content_objects'
         )),
         false, NULL, 0, NULL
       FROM candidates
       ORDER BY object_key, retention_anchor DESC, snapshot_id
       ON CONFLICT (sha256, object_key) DO UPDATE SET
         snapshot_id = EXCLUDED.snapshot_id,
         object_kind = EXCLUDED.object_kind,
         marked_at = EXCLUDED.marked_at,
         eligible_at = EXCLUDED.eligible_at,
         collected = false,
         collected_at = NULL,
         attempts = 0,
         last_error = NULL
       WHERE (gc_marks.collected AND gc_marks.snapshot_id IS NULL)
          OR gc_marks.snapshot_id IS DISTINCT FROM EXCLUDED.snapshot_id`,
    );
    await client.query('COMMIT');
    return {
      jobs: jobs.rowCount ?? 0,
      audit_events: audits.rowCount ?? 0,
      gc_marks: marked.rowCount ?? 0,
      snapshots_pruned: pruned.rowCount ?? 0,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listGcEligible(pool: Pool, limit: number): Promise<Array<{ id: string; sha256: string; object_key: string }>> {
  const { rows } = await pool.query(
    `SELECT gm.id, gm.sha256, gm.object_key
     FROM gc_marks gm
     WHERE gm.eligible_at <= now()
       AND NOT gm.collected
       AND NOT EXISTS (
         SELECT 1 FROM snapshot_objects so
         JOIN snapshots s ON s.id = so.snapshot_id
         WHERE so.object_key = gm.object_key
           AND snapshot_is_gc_protected(s.state, s.superseded_at, s.completed_at)
       )
       AND NOT EXISTS (
         SELECT 1 FROM snapshots s
         WHERE s.manifest_key = gm.object_key
           AND snapshot_is_gc_protected(s.state, s.superseded_at, s.completed_at)
       )
     ORDER BY gm.eligible_at ASC, gm.id ASC
     LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ id: String(r.id), sha256: String(r.sha256), object_key: String(r.object_key) }));
}

export async function markGcCollected(pool: Pool, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const { rowCount } = await pool.query(
    `UPDATE gc_marks SET collected = true, collected_at = now()
     WHERE id = ANY($1::uuid[]) AND NOT collected`,
    [ids],
  );
  return rowCount ?? 0;
}

export async function deferGcMark(pool: Pool, id: string, error: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE gc_marks
     SET eligible_at = now() + make_interval(days => (
           SELECT retention_days FROM retention_config
           WHERE entity_type = 'content_objects'
         )),
         attempts = attempts + 1,
         last_error = $2
     WHERE id = $1 AND NOT collected`,
    [id, error.slice(0, 1000)],
  );
  return (rowCount ?? 0) === 1;
}

export async function recordGcFailure(pool: Pool, id: string, error: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE gc_marks
     SET eligible_at = now() + make_interval(
           secs => LEAST(86400, 60 * power(2, LEAST(attempts, 10))::integer)
         ),
         attempts = attempts + 1,
         last_error = $2
     WHERE id = $1 AND NOT collected`,
    [id, error.slice(0, 1000)],
  );
  return (rowCount ?? 0) === 1;
}

export async function cancelJob(pool: Pool, id: string, reason: string | null): Promise<JobT | null> {
  const { rows } = await pool.query(
    `WITH locked AS (
       SELECT id, COALESCE(problem_id, '__global__') AS counter_key
       FROM jobs
       WHERE id = $1 AND state IN ('pending','running')
       FOR UPDATE
     ), bumped AS (
       INSERT INTO job_fencing_counters (problem_id, next_token)
       SELECT counter_key, 2 FROM locked
       ON CONFLICT (problem_id) DO UPDATE
       SET next_token = job_fencing_counters.next_token + 1
       RETURNING problem_id, next_token - 1 AS fencing_token
     )
     UPDATE jobs j SET state = 'cancelled',
       fencing_token = b.fencing_token,
       requested_cancel_at = now(),
       requested_cancel_reason = $2,
       error_message = $2,
       completed_at = now()
     FROM locked l
     JOIN bumped b ON b.problem_id = l.counter_key
     WHERE j.id = l.id
     RETURNING j.*`,
    [id, reason],
  );
  return rows[0] ? rowToJob(rows[0]) : null;
}

export async function retryJob(pool: Pool, id: string): Promise<JobT | null> {
  const { rows } = await pool.query(
    `UPDATE jobs SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL,
       requested_cancel_at = NULL, requested_cancel_reason = NULL,
       error_code = NULL, error_message = NULL, updated_at = now()
     WHERE id = $1 AND state IN ('failed','cancelled') AND attempt < max_attempts RETURNING *`,
    [id],
  );
  return rows[0] ? rowToJob(rows[0]) : null;
}

function rowToJob(r: Record<string, unknown>): JobT {
  return {
    id: String(r.id),
    idempotency_key: String(r.idempotency_key),
    job_type: r.job_type as JobT['job_type'],
    problem_id: r.problem_id as string | null,
    target_generation: r.target_generation !== null ? Number(r.target_generation) : null,
    state: r.state as JobT['state'],
    lease_owner: r.lease_owner as string | null,
    lease_expires_at: r.lease_expires_at ? toRfc3339(r.lease_expires_at) : null,
    fencing_token: Number(int8(r.fencing_token)),
    attempt: Number(r.attempt),
    max_attempts: Number(r.max_attempts),
    result: r.result as unknown,
    error_code: r.error_code as string | null,
    error_message: r.error_message as string | null,
    created_at: toRfc3339(r.created_at),
    updated_at: toRfc3339(r.updated_at),
    completed_at: r.completed_at ? toRfc3339(r.completed_at) : null,
  };
}

// ===========================================================================
// Audit Events
// ===========================================================================

export async function insertAuditEvent(pool: Pool, opts: {
  actor: string; actorRole: string | null; action: string;
  targetType?: string | null; targetId?: string | null;
  problemId?: string | null; generation?: number | null; jobId?: string | null;
  metadata?: Record<string, unknown>; requestId?: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO audit_events (actor, actor_role, action, target_type, target_id, problem_id, generation, job_id, metadata, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      opts.actor, opts.actorRole, opts.action,
      opts.targetType ?? null, opts.targetId ?? null,
      opts.problemId ?? null, opts.generation ?? null, opts.jobId ?? null,
      JSON.stringify(opts.metadata ?? {}), opts.requestId ?? null,
    ],
  );
}

export async function listAuditEvents(
  pool: Pool, opts: {
    actor?: string; action?: string; problemId?: string;
    from?: string; to?: string;
    cursor?: string; limit: number;
  },
): Promise<Page<AuditEventT>> {
  const limit = Math.min(opts.limit, 200);
  const params: unknown[] = [];
  let where = 'WHERE 1=1';
  let paramIdx = 1;
  if (opts.from) {
    where += ` AND created_at >= $${paramIdx}::timestamptz`;
    params.push(opts.from);
    paramIdx++;
  }
  if (opts.to) {
    where += ` AND created_at <= $${paramIdx}::timestamptz`;
    params.push(opts.to);
    paramIdx++;
  }
  if (opts.actor) {
    where += ` AND actor = $${paramIdx}`;
    params.push(opts.actor);
    paramIdx++;
  }
  if (opts.action) {
    where += ` AND action = $${paramIdx}`;
    params.push(opts.action);
    paramIdx++;
  }
  if (opts.problemId) {
    where += ` AND problem_id = $${paramIdx}`;
    params.push(opts.problemId);
    paramIdx++;
  }
  let cursorCond = '';
  if (opts.cursor) {
    const c = decodeCursor<{ created_at: string; id: string }>(opts.cursor, { created_at: new Date(0).toISOString(), id: '' });
    cursorCond = ` AND (created_at, id) < ($${paramIdx}::timestamptz, $${paramIdx + 1}::uuid)`;
    params.push(c.created_at, c.id);
    paramIdx += 2;
  }
  const sql = `SELECT * FROM audit_events ${where} ${cursorCond} ORDER BY created_at DESC, id DESC LIMIT $${paramIdx}`;
  params.push(limit + 1);
  const { rows } = await pool.query(sql, params);
  const has_more = rows.length > limit;
  const items = rows.slice(0, limit).map(rowToAudit);
  let next_cursor: string | null = null;
  if (has_more && items.length > 0) {
    next_cursor = encodeCursor({ created_at: toRfc3339(rows[limit - 1].created_at), id: String(rows[limit - 1].id) });
  }
  return { items, next_cursor, has_more };
}

function rowToAudit(r: Record<string, unknown>): AuditEventT {
  return {
    id: String(r.id),
    actor: String(r.actor),
    actor_role: r.actor_role as string | null,
    action: String(r.action),
    target_type: r.target_type as string | null,
    target_id: r.target_id as string | null,
    problem_id: r.problem_id as string | null,
    generation: r.generation !== null ? Number(r.generation) : null,
    job_id: r.job_id ? String(r.job_id) : null,
    metadata: r.metadata as Record<string, unknown>,
    request_id: r.request_id as string | null,
    created_at: toRfc3339(r.created_at),
  };
}

// ===========================================================================
// Orphans
// ===========================================================================

export async function listOrphans(
  pool: Pool, opts: { cursor?: string; limit: number },
): Promise<Page<OrphanT>> {
  const limit = Math.min(opts.limit, 200);
  const params: unknown[] = [];
  let cursorCond = '';
  let paramIdx = 1;
  if (opts.cursor) {
    const lastCode = decodeCursor<string>(opts.cursor, '');
    cursorCond = ` AND code > $${paramIdx}`;
    params.push(lastCode);
    paramIdx++;
  }
  const sql = `SELECT p.code, pu.logical_bytes, pu.allocated_bytes, pu.file_count, pu.observed_at
     FROM problems p JOIN problem_usage pu ON pu.problem_id = p.external_id
     WHERE p.catalog_state = 'orphan' ${cursorCond}
     ORDER BY p.code ASC LIMIT $${paramIdx}`;
  params.push(limit + 1);
  const { rows } = await pool.query(sql, params);
  const has_more = rows.length > limit;
  const items = rows.slice(0, limit).map((r) => ({
    code: String(r.code),
    logical_bytes: int8(r.logical_bytes),
    allocated_bytes: int8(r.allocated_bytes),
    file_count: Number(r.file_count),
    observed_at: toRfc3339(r.observed_at),
  }));
  let next_cursor: string | null = null;
  if (has_more && items.length > 0) {
    next_cursor = encodeCursor(items[items.length - 1].code);
  }
  return { items, next_cursor, has_more };
}

// ===========================================================================
// Sync changes (cursor based on observed_at)
// ===========================================================================

export async function getSyncChanges(
  pool: Pool, opts: { cursor?: string; limit: number },
): Promise<{ schema_version: number; changes: SyncChangeT[]; next_cursor: string | null; has_more: boolean }> {
  const limit = Math.min(opts.limit, 500);
  const params: unknown[] = [];
  let cursorCond = '';
  let paramIdx = 1;
  if (opts.cursor) {
    const c = decodeCursor<{ updated_at: string; external_id: string }>(opts.cursor, { updated_at: new Date(0).toISOString(), external_id: '' });
    cursorCond = ` WHERE (GREATEST(p.observed_at, COALESCE(pu.observed_at, p.observed_at)), p.external_id) > ($${paramIdx}::timestamptz, $${paramIdx + 1})`;
    params.push(c.updated_at, c.external_id);
    paramIdx += 2;
  }
  const sql = `
    SELECT p.*, pu.*,
      p.observed_at AS p_observed_at, pu.observed_at AS pu_observed_at,
      GREATEST(p.observed_at, pu.observed_at) AS updated_at
    FROM problems p
    LEFT JOIN problem_usage pu ON pu.problem_id = p.external_id
    ${cursorCond}
    ORDER BY updated_at ASC, p.external_id ASC
    LIMIT $${paramIdx}`;
  params.push(limit + 1);
  const { rows } = await pool.query(sql, params);
  const has_more = rows.length > limit;
  const changes = rows.slice(0, limit).map(rowToSyncChange);
  let next_cursor: string | null = null;
  if (changes.length > 0) {
    const last = rows[Math.min(limit, rows.length) - 1];
    next_cursor = encodeCursor({ updated_at: toRfc3339(last.updated_at), external_id: String(last.external_id) });
  }
  return { schema_version: 1, changes, next_cursor, has_more };
}

function rowToSyncChange(r: Record<string, unknown>): SyncChangeT {
  return {
    external_id: String(r.external_id),
    code: String(r.code),
    owner_organization: r.owner_organization as string | null,
    is_manually_managed: r.is_manually_managed as boolean,
    mirror_of: r.mirror_of as string | null,
    mirror_root: r.mirror_root as string | null,
    catalog_state: String(r.catalog_state),
    event_kind: r.catalog_state === 'missing' || r.catalog_state === 'deleted' ? 'delete' : 'upsert',
    schema_version: 1,
    downloadable: String(r.r2_status ?? 'none').toLowerCase() === 'ready' && r.snapshot_generation !== null && r.snapshot_generation !== undefined,
    quota_bytes: r.quota_bytes === null || r.quota_bytes === undefined ? null : int8(r.quota_bytes),
    logical_bytes: int8(r.logical_bytes ?? 0),
    allocated_bytes: int8(r.allocated_bytes ?? 0),
    archive_bytes: int8(r.archive_bytes ?? 0),
    auxiliary_bytes: int8(r.auxiliary_bytes ?? 0),
    file_count: Number(r.file_count ?? 0),
    local_status: String(r.local_status ?? 'missing'),
    r2_status: String(r.r2_status ?? 'none'),
    snapshot_generation: r.snapshot_generation !== null && r.snapshot_generation !== undefined ? Number(r.snapshot_generation) : null,
    orphan_bytes: int8(r.orphan_bytes ?? 0),
    referenced_bytes: int8(r.referenced_bytes ?? 0),
    last_accessed_at: r.last_accessed_at === null || r.last_accessed_at === undefined
      ? null
      : toRfc3339(r.last_accessed_at),
    observed_at: toRfc3339(r.pu_observed_at ?? r.p_observed_at),
    stale: Boolean(r.stale ?? true),
    updated_at: toRfc3339(r.updated_at ?? r.p_observed_at),
  };
}

// ===========================================================================
// Volumes
// ===========================================================================

export async function getVolume(pool: Pool): Promise<import('./schemas.js').VolumeT | null> {
  const { rows } = await pool.query('SELECT * FROM storage_volumes ORDER BY observed_at DESC LIMIT 1');
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    name: String(r.name),
    mount_path: String(r.mount_path),
    total_bytes: int8(r.total_bytes),
    free_bytes: int8(r.free_bytes),
    available_bytes: int8(r.available_bytes),
    observed_at: toRfc3339(r.observed_at),
    stale: r.stale as boolean,
  };
}

export async function upsertVolume(
  pool: Pool, name: string, mountPath: string, total: number | string, free: number | string, available: number | string,
): Promise<void> {
  await pool.query(
    `INSERT INTO storage_volumes (name, mount_path, total_bytes, free_bytes, available_bytes, observed_at, stale)
     VALUES ($1, $2, $3, $4, $5, now(), false)
     ON CONFLICT (name) DO UPDATE SET
       mount_path = EXCLUDED.mount_path,
       total_bytes = EXCLUDED.total_bytes,
       free_bytes = EXCLUDED.free_bytes,
       available_bytes = EXCLUDED.available_bytes,
       observed_at = now(),
       stale = false`,
    [name, mountPath, total, free, available],
  );
  await pool.query(
    `INSERT INTO storage_volume_observations (name, mount_path, total_bytes, free_bytes, available_bytes, observed_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [name, mountPath, total, free, available],
  );
}

export async function getDashboardSummary(pool: Pool): Promise<Record<string, unknown>> {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int AS catalog_problem_count,
       COUNT(*) FILTER (WHERE p.catalog_state IN ('present', 'mirror'))::int AS active_problem_count,
       COUNT(*) FILTER (WHERE p.dirty)::int AS dirty_problem_count,
       COUNT(*) FILTER (WHERE p.catalog_state = 'orphan')::int AS orphan_count,
       COALESCE(SUM(pu.logical_bytes) FILTER (WHERE p.catalog_state IN ('present', 'mirror')), 0)::bigint AS logical_bytes,
       COALESCE(SUM(pu.allocated_bytes) FILTER (WHERE p.catalog_state IN ('present', 'mirror')), 0)::bigint AS allocated_bytes,
       COALESCE(SUM(pu.archive_bytes) FILTER (WHERE p.catalog_state IN ('present', 'mirror')), 0)::bigint AS archive_bytes,
       COALESCE(SUM(pu.auxiliary_bytes) FILTER (WHERE p.catalog_state IN ('present', 'mirror')), 0)::bigint AS auxiliary_bytes,
       COUNT(*) FILTER (
         WHERE p.catalog_state IN ('present', 'mirror')
           AND pu.local_status = 'present'
       )::int AS local_problem_count,
       COALESCE(SUM(pu.allocated_bytes) FILTER (
         WHERE p.catalog_state IN ('present', 'mirror')
           AND pu.local_status = 'present'
       ), 0)::bigint AS local_allocated_bytes,
       (
         SELECT COUNT(*)::int
         FROM snapshots s
         JOIN problems sp ON sp.external_id = s.problem_id
         WHERE s.state = 'ready'
           AND sp.catalog_state IN ('present', 'mirror')
       ) AS r2_snapshot_problem_count,
       (
         SELECT COALESCE(SUM(s.total_bytes), 0)::bigint
         FROM snapshots s
         JOIN problems sp ON sp.external_id = s.problem_id
         WHERE s.state = 'ready'
           AND sp.catalog_state IN ('present', 'mirror')
       ) AS r2_snapshot_bytes
     FROM problems p
     LEFT JOIN problem_usage pu ON pu.problem_id = p.external_id`,
  );
  const r = rows[0] ?? {};
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k.endsWith('_bytes') ? int8(v) : v]));
}

export async function getStatusDistributions(pool: Pool): Promise<Record<string, unknown>> {
  const local = await pool.query(`SELECT COALESCE(pu.local_status, 'unknown') AS status, COUNT(*)::int AS count FROM problems p LEFT JOIN problem_usage pu ON pu.problem_id = p.external_id GROUP BY status ORDER BY status`);
  const r2 = await pool.query(`SELECT COALESCE(pu.r2_status, 'none') AS status, COUNT(*)::int AS count FROM problems p LEFT JOIN problem_usage pu ON pu.problem_id = p.external_id GROUP BY status ORDER BY status`);
  const catalog = await pool.query(`SELECT catalog_state AS status, COUNT(*)::int AS count FROM problems GROUP BY catalog_state ORDER BY catalog_state`);
  return { local_status: local.rows, r2_status: r2.rows, catalog_state: catalog.rows };
}

export async function listLargestProblems(pool: Pool, limit: number): Promise<ProblemUsageT[]> {
  const { rows } = await pool.query(
    `SELECT pu.* FROM problem_usage pu
     JOIN problems p ON p.external_id = pu.problem_id
     WHERE p.catalog_state IN ('present', 'mirror')
     ORDER BY pu.logical_bytes DESC, pu.problem_id ASC LIMIT $1`,
    [limit],
  );
  return rows.map(rowToProblemUsage);
}

export async function listLargestOrganizations(pool: Pool, limit: number): Promise<OrganizationUsageT[]> {
  const { rows } = await pool.query(
    `SELECT
       p.owner_organization AS organization_id,
       COUNT(*)::int AS problem_count,
       COALESCE(SUM(pu.logical_bytes), 0)::bigint AS logical_bytes,
       COALESCE(SUM(pu.allocated_bytes), 0)::bigint AS allocated_bytes,
       COALESCE(SUM(pu.archive_bytes), 0)::bigint AS archive_bytes,
       COALESCE(SUM(pu.auxiliary_bytes), 0)::bigint AS auxiliary_bytes,
       COALESCE(SUM(pu.referenced_bytes), 0)::bigint AS referenced_bytes,
       COALESCE(os.storage_quota_bytes, MAX(p.quota_bytes)) AS quota_bytes,
       os.problem_count_quota AS problem_count_quota,
       COALESCE(MAX(pu.observed_at), now()) AS observed_at,
       COALESCE(BOOL_OR(pu.stale), true) AS stale
     FROM problems p
     LEFT JOIN problem_usage pu ON pu.problem_id = p.external_id
     LEFT JOIN organization_settings os ON os.organization_id = p.owner_organization
     WHERE p.owner_organization IS NOT NULL AND p.catalog_state IN ('present', 'mirror')
     GROUP BY p.owner_organization, os.storage_quota_bytes, os.problem_count_quota
     ORDER BY logical_bytes DESC, p.owner_organization ASC
     LIMIT $1`,
    [limit],
  );
  return rows.map(rowToOrgUsage);
}

export async function listVolumeTimeseries(pool: Pool, opts: { name?: string; limit: number }): Promise<Array<Record<string, unknown>>> {
  const params: unknown[] = [];
  let where = '';
  if (opts.name) {
    where = 'WHERE name = $1';
    params.push(opts.name);
  }
  params.push(opts.limit);
  const { rows } = await pool.query(
    `SELECT name, mount_path, total_bytes, free_bytes, available_bytes, observed_at
     FROM storage_volume_observations ${where}
     ORDER BY observed_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    name: String(r.name),
    mount_path: String(r.mount_path),
    total_bytes: int8(r.total_bytes),
    free_bytes: int8(r.free_bytes),
    available_bytes: int8(r.available_bytes),
    observed_at: toRfc3339(r.observed_at),
  }));
}

// ===========================================================================
// Helpers
// ===========================================================================

function toRfc3339(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return new Date(v).toISOString();
  return new Date(String(v)).toISOString();
}

export function stableFingerprint(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortJson(v)]),
    );
  }
  return value;
}
