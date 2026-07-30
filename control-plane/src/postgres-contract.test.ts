import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import * as db from './db.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const schema = `storage_test_${randomUUID().replaceAll('-', '')}`;
let admin: Pool;
let pool: Pool;

describe.runIf(enabled)('PostgreSQL concurrency contracts', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
      max: 20,
    });
    for (const name of [
      '001_init.sql',
      '002_phase6.sql',
      '003_review_contracts.sql',
      '004_idempotency_dirty_contract.sql',
      '005_dashboard_users.sql',
      '006_problem_identity_rekey.sql',
      '007_active_job_guards.sql',
      '008_snapshot_retention_gc.sql',
    ]) {
      if (name === '008_snapshot_retention_gc.sql') {
        await pool.query(
          `INSERT INTO problems (external_id, code, catalog_state)
           VALUES ('p-legacy-ready', 'legacy-ready', 'present')`,
        );
        await pool.query(
          `INSERT INTO snapshots
             (problem_id, generation, state, manifest_key, completed_at)
           VALUES
             ('p-legacy-ready', 1, 'ready', 'snapshots/p-legacy-ready/1/manifest.json',
              now() - interval '1 day'),
             ('p-legacy-ready', 2, 'ready', 'snapshots/p-legacy-ready/2/manifest.json',
              now())`,
        );
      }
      await pool.query(readFileSync(resolve(__dirname, `../../migrations/${name}`), 'utf8'));
    }
  }, 30000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it('coalesces concurrent active jobs without weakening idempotency replay', async () => {
    await pool.query(
      `INSERT INTO problems (external_id, code, catalog_state) VALUES ('p-job', 'job-code', 'present')`,
    );
    const jobs = await Promise.all(
      Array.from({ length: 20 }, (_, index) => db.createJob(pool, {
        idempotencyKey: `concurrent-${index}`,
        jobType: 'restore',
        problemId: 'p-job',
        targetGeneration: 1,
        leaseOwner: 'test',
        requestFingerprint: 'same-restore',
      })),
    );
    expect(new Set(jobs.map((job) => job.id)).size).toBe(1);
    const count = await pool.query(
      `SELECT count(*)::integer AS count
       FROM jobs
       WHERE problem_id = 'p-job' AND state IN ('pending', 'running')`,
    );
    expect(count.rows[0].count).toBe(1);

    await pool.query(`UPDATE jobs SET state = 'failed', completed_at = now() WHERE id = $1`, [jobs[0].id]);
    const replay = await db.createJob(pool, {
      idempotencyKey: jobs[0].idempotency_key,
      jobType: 'restore',
      problemId: 'p-job',
      targetGeneration: 1,
      leaseOwner: 'test',
      requestFingerprint: 'same-restore',
    });
    expect(replay.state).toBe('failed');

    const replacement = await db.createJob(pool, {
      idempotencyKey: 'replacement-key',
      jobType: 'restore',
      problemId: 'p-job',
      targetGeneration: 1,
      leaseOwner: 'test',
      requestFingerprint: 'same-restore',
    });
    expect(replacement.state).toBe('pending');
    expect(replacement.id).not.toBe(jobs[0].id);

    await pool.query(
      `INSERT INTO problems (external_id, code, catalog_state) VALUES ('p-other', 'other-code', 'present')`,
    );
    await db.createJob(pool, {
      idempotencyKey: 'conflicting-key',
      jobType: 'restore',
      problemId: 'p-other',
      targetGeneration: 2,
      leaseOwner: 'test',
      requestFingerprint: 'other-request',
    });
    await expect(db.createJob(pool, {
      idempotencyKey: 'conflicting-key',
      jobType: 'restore',
      problemId: 'p-job',
      targetGeneration: 1,
      leaseOwner: 'test',
      requestFingerprint: 'same-restore',
    })).rejects.toBeInstanceOf(db.IdempotencyConflictError);
  });

  it('repairs legacy duplicate READY generations and enforces one authoritative snapshot', async () => {
    const rows = await pool.query(
      `SELECT generation, state, superseded_at IS NOT NULL AS has_superseded_at
       FROM snapshots
       WHERE problem_id = 'p-legacy-ready'
       ORDER BY generation`,
    );
    expect(rows.rows).toEqual([
      { generation: 1, state: 'superseded', has_superseded_at: true },
      { generation: 2, state: 'ready', has_superseded_at: false },
    ]);
    await expect(pool.query(
      `INSERT INTO snapshots (problem_id, generation, state)
       VALUES ('p-legacy-ready', 3, 'ready')`,
    )).rejects.toMatchObject({ code: '23505' });
  });

  it('merges watcher orphan accounting when a catalog problem is renamed', async () => {
    await pool.query(
      `INSERT INTO problems (external_id, code, catalog_state)
       VALUES ('p-rename', 'old-code', 'present'),
              ('orphan:new-code', 'new-code', 'orphan')`,
    );
    await pool.query(
      `INSERT INTO problem_usage
         (problem_id, logical_bytes, allocated_bytes, archive_bytes, auxiliary_bytes,
          file_count, local_status, r2_status, snapshot_generation, observed_at, stale)
       VALUES
         ('p-rename', 1, 1, 1, 0, 1, 'missing', 'ready', 7, now() - interval '1 minute', false),
         ('orphan:new-code', 99, 100, 80, 19, 4, 'orphan', 'none', NULL, now(), false)`,
    );

    const problem = await db.upsertProblem(
      pool, 'p-rename', 'new-code', null, false, null, null,
    );
    expect(problem.code).toBe('new-code');
    const rows = await pool.query(
      `SELECT p.external_id, pu.logical_bytes, pu.r2_status, pu.snapshot_generation
       FROM problems p
       JOIN problem_usage pu ON pu.problem_id = p.external_id
       WHERE p.code = 'new-code'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      external_id: 'p-rename',
      logical_bytes: '99',
      r2_status: 'ready',
      snapshot_generation: 7,
    });
  });

  it('clears missing dirty projections and schedules only locally present problems', async () => {
    await pool.query(
      `INSERT INTO problems
         (external_id, code, catalog_state, dirty, dirty_generation, dirty_version, stale)
       VALUES
         ('p-missing', 'missing-code', 'present', true, 1, 1, true),
         ('p-present', 'present-code', 'present', true, 1, 1, true)`,
    );
    await pool.query(
      `INSERT INTO problem_usage
         (problem_id, local_status, r2_status, observed_at, stale)
       VALUES
         ('p-missing', 'missing', 'none', now(), false),
         ('p-present', 'present', 'none', now(), false)`,
    );

    expect(await db.clearDirtyForMissingLocal(pool)).toBe(1);
    const states = await pool.query(
      `SELECT external_id, dirty, dirty_generation
       FROM problems
       WHERE external_id IN ('p-missing', 'p-present')
       ORDER BY external_id`,
    );
    expect(states.rows).toEqual([
      { external_id: 'p-missing', dirty: false, dirty_generation: null },
      { external_id: 'p-present', dirty: true, dirty_generation: 1 },
    ]);

    const scheduled = await db.scheduleDirtySnapshotBatch(pool, 'catalog-reconcile', 10);
    const scheduledIds = scheduled.map((item) => item.problem_id);
    expect(scheduledIds).toContain('p-present');
    expect(scheduledIds).not.toContain('p-missing');
  });

  it('fences late missing observations after one restore has completed', async () => {
    await pool.query(
      `INSERT INTO problems (external_id, code, catalog_state)
       VALUES ('p-late-restore', 'late-restore', 'present')`,
    );
    const missingObservedAt = '2026-07-31T00:00:00.000Z';
    await pool.query(
      `INSERT INTO problem_usage
         (problem_id, local_status, r2_status, snapshot_generation, observed_at, stale)
       VALUES ('p-late-restore', 'missing', 'ready', 9, $1, false)`,
      [missingObservedAt],
    );
    const fingerprint = db.stableFingerprint({
      action: 'ensure-ready-restore',
      external_id: 'p-late-restore',
      generation: 9,
    });

    const firstWave = await Promise.all(
      Array.from({ length: 50 }, (_, index) => db.createRestoreJobIfMissing(pool, {
        idempotencyKey: `late-first-${index}`,
        problemId: 'p-late-restore',
        targetGeneration: 9,
        leaseOwner: 'stress',
        requestFingerprint: fingerprint,
        missingObservedAt,
      })),
    );
    const firstJobs = firstWave.filter((result) => !result.ready).map((result) => result.job.id);
    expect(new Set(firstJobs).size).toBe(1);

    await pool.query(
      `UPDATE jobs
       SET state = 'completed', completed_at = '2026-07-31T00:00:01.000Z'
       WHERE id = $1`,
      [firstJobs[0]],
    );
    await pool.query(
      `UPDATE problem_usage
       SET local_status = 'present', observed_at = '2026-07-31T00:00:01.000Z'
       WHERE problem_id = 'p-late-restore'`,
    );

    const lateWave = await Promise.all(
      Array.from({ length: 50 }, (_, index) => db.createRestoreJobIfMissing(pool, {
        idempotencyKey: `late-second-${index}`,
        problemId: 'p-late-restore',
        targetGeneration: 9,
        leaseOwner: 'stress',
        requestFingerprint: fingerprint,
        missingObservedAt,
      })),
    );
    expect(lateWave.every((result) => result.ready)).toBe(true);
    const count = await pool.query(
      `SELECT count(*)::integer AS count
       FROM jobs
       WHERE problem_id = 'p-late-restore' AND job_type = 'restore'`,
    );
    expect(count.rows[0].count).toBe(1);

    const newDeletion = await db.createRestoreJobIfMissing(pool, {
      idempotencyKey: 'late-real-deletion',
      problemId: 'p-late-restore',
      targetGeneration: 9,
      leaseOwner: 'stress',
      requestFingerprint: fingerprint,
      missingObservedAt: '2026-07-31T00:00:02.000Z',
    });
    expect(newDeletion.ready).toBe(false);
    const afterDeletion = await pool.query(
      `SELECT count(*)::integer AS count
       FROM jobs
       WHERE problem_id = 'p-late-restore' AND job_type = 'restore'`,
    );
    expect(afterDeletion.rows[0].count).toBe(2);
  });

  it('serializes incompatible jobs and allows only one running local operation per problem', async () => {
    await pool.query(
      `INSERT INTO problems (external_id, code, catalog_state)
       VALUES ('p-operation-wall', 'operation-wall', 'present')`,
    );
    await db.createJob(pool, {
      idempotencyKey: 'operation-scan',
      jobType: 'scan',
      problemId: 'p-operation-wall',
      targetGeneration: null,
      leaseOwner: 'stress',
      requestFingerprint: db.stableFingerprint({ action: 'scan', external_id: 'p-operation-wall' }),
    });
    await db.createJob(pool, {
      idempotencyKey: 'operation-snapshot',
      jobType: 'snapshot',
      problemId: 'p-operation-wall',
      targetGeneration: 1,
      leaseOwner: 'stress',
      requestFingerprint: db.stableFingerprint({
        action: 'snapshot',
        external_id: 'p-operation-wall',
        generation: 1,
      }),
    });
    await expect(db.createJob(pool, {
      idempotencyKey: 'operation-restore',
      jobType: 'restore',
      problemId: 'p-operation-wall',
      targetGeneration: 1,
      leaseOwner: 'stress',
      requestFingerprint: db.stableFingerprint({
        action: 'restore',
        external_id: 'p-operation-wall',
        generation: 1,
      }),
    })).rejects.toBeInstanceOf(db.ProblemOperationConflictError);

    const active = await pool.query(
      `SELECT count(*)::integer AS count
       FROM jobs
       WHERE problem_id = 'p-operation-wall' AND state IN ('pending', 'running')`,
    );
    expect(active.rows[0].count).toBe(2);

    await pool.query(
      `UPDATE jobs
       SET state = 'completed', completed_at = now()
       WHERE problem_id <> 'p-operation-wall'
         AND state IN ('pending', 'running')`,
    );
    const acquired = await Promise.all([
      db.acquireJob(pool, 'worker-a', 60),
      db.acquireJob(pool, 'worker-b', 60),
    ]);
    expect(acquired.filter((job) => job?.problem_id === 'p-operation-wall')).toHaveLength(1);
    const running = await pool.query(
      `SELECT count(*)::integer AS count
       FROM jobs
       WHERE problem_id = 'p-operation-wall' AND state = 'running'`,
    );
    expect(running.rows[0].count).toBe(1);
  });

  it('retains shared objects, sweeps private objects, and prunes metadata only after collection', async () => {
    await pool.query(
      `INSERT INTO problems (external_id, code, catalog_state)
       VALUES ('p-retention', 'retention-code', 'present')`,
    );
    await pool.query(
      `INSERT INTO problem_usage
         (problem_id, local_status, r2_status, snapshot_generation, observed_at, stale)
       VALUES ('p-retention', 'present', 'ready', 2, now(), false)`,
    );
    const snapshots = await pool.query(
      `INSERT INTO snapshots
         (problem_id, generation, state, manifest_key, completed_at, superseded_at)
       VALUES
         ('p-retention', 1, 'superseded', 'snapshots/p-retention/1/manifest.json',
          now() - interval '100 days', now() - interval '100 days'),
         ('p-retention', 2, 'ready', 'snapshots/p-retention/2/manifest.json',
          now(), NULL)
       RETURNING id, generation`,
    );
    const oldId = snapshots.rows.find((row) => row.generation === 1).id;
    const readyId = snapshots.rows.find((row) => row.generation === 2).id;
    const sharedSha = 'a'.repeat(64);
    const privateSha = 'b'.repeat(64);
    const sharedKey = `objects/sha256/aa/${sharedSha}`;
    const privateKey = `objects/sha256/bb/${privateSha}`;
    await pool.query(
      `INSERT INTO snapshot_objects
         (snapshot_id, sha256, rel_path, size_bytes, object_key, uploaded, verified)
       VALUES
         ($1, $3, 'shared-old.zip', 10, $5, true, true),
         ($1, $4, 'private.zip', 20, $6, true, true),
         ($2, $3, 'shared-ready.zip', 10, $5, true, true)`,
      [oldId, readyId, sharedSha, privateSha, sharedKey, privateKey],
    );

    const first = await db.applyRetention(pool);
    expect(first.gc_marks).toBe(2);
    expect(first.snapshots_pruned).toBe(0);
    const marks = await pool.query(
      `SELECT object_key, object_kind, collected
       FROM gc_marks
       WHERE snapshot_id = $1
       ORDER BY object_key`,
      [oldId],
    );
    expect(marks.rows.map((row) => row.object_key)).toEqual([
      privateKey,
      'snapshots/p-retention/1/manifest.json',
    ]);
    expect(marks.rows.some((row) => row.object_key === sharedKey)).toBe(false);
    expect(await db.listGcEligible(pool, 10)).toHaveLength(0);

    await pool.query(
      `UPDATE gc_marks SET eligible_at = now() - interval '1 second'
       WHERE snapshot_id = $1`,
      [oldId],
    );
    const eligible = await db.listGcEligible(pool, 10);
    expect(new Set(eligible.map((item) => item.object_key))).toEqual(new Set([
      privateKey,
      'snapshots/p-retention/1/manifest.json',
    ]));
    await db.markGcCollected(pool, eligible.map((item) => item.id));

    const second = await db.applyRetention(pool);
    expect(second.snapshots_pruned).toBe(1);
    const remaining = await pool.query(
      `SELECT generation, state FROM snapshots
       WHERE problem_id = 'p-retention' ORDER BY generation`,
    );
    expect(remaining.rows).toEqual([{ generation: 2, state: 'ready' }]);
    expect(await pool.query(
      `SELECT 1 FROM gc_marks WHERE object_key = $1`,
      [sharedKey],
    )).toMatchObject({ rowCount: 0 });
  });

  it('coalesces concurrent global GC jobs', async () => {
    const jobs = await Promise.all(
      Array.from({ length: 25 }, (_, index) => db.createJob(pool, {
        idempotencyKey: `gc-wave-${index}`,
        jobType: 'gc_collect',
        problemId: null,
        targetGeneration: null,
        leaseOwner: 'test',
        requestFingerprint: `gc-fingerprint-${index}`,
      })),
    );
    expect(new Set(jobs.map((job) => job.id)).size).toBe(1);
    const count = await pool.query(
      `SELECT count(*)::integer AS count
       FROM jobs
       WHERE job_type = 'gc_collect' AND state IN ('pending', 'running')`,
    );
    expect(count.rows[0].count).toBe(1);
  });

  it('treats superseded generations inside the rollback window as live references', async () => {
    await pool.query(
      `INSERT INTO problems (external_id, code, catalog_state)
       VALUES ('p-rollback', 'rollback-code', 'present')`,
    );
    const snapshots = await pool.query(
      `INSERT INTO snapshots
         (problem_id, generation, state, manifest_key, completed_at, superseded_at)
       VALUES
         ('p-rollback', 1, 'superseded', 'snapshots/p-rollback/1/manifest.json',
          now() - interval '120 days', now() - interval '120 days'),
         ('p-rollback', 2, 'superseded', 'snapshots/p-rollback/2/manifest.json',
          now() - interval '1 day', now() - interval '1 day'),
         ('p-rollback', 3, 'ready', 'snapshots/p-rollback/3/manifest.json',
          now(), NULL)
       RETURNING id, generation`,
    );
    const oldId = snapshots.rows.find((row) => row.generation === 1).id;
    const protectedId = snapshots.rows.find((row) => row.generation === 2).id;
    const sharedSha = 'c'.repeat(64);
    const sharedKey = `objects/sha256/cc/${sharedSha}`;
    await pool.query(
      `INSERT INTO snapshot_objects
         (snapshot_id, sha256, rel_path, size_bytes, object_key, uploaded, verified)
       VALUES
         ($1, $3, 'old-shared.zip', 10, $4, true, true),
         ($2, $3, 'protected-shared.zip', 10, $4, true, true)`,
      [oldId, protectedId, sharedSha, sharedKey],
    );

    await db.applyRetention(pool);
    const mark = await pool.query(
      `SELECT 1 FROM gc_marks WHERE object_key = $1`,
      [sharedKey],
    );
    expect(mark.rowCount).toBe(0);

    await pool.query(
      `UPDATE snapshots SET superseded_at = now() - interval '120 days'
       WHERE id = $1`,
      [protectedId],
    );
    await db.applyRetention(pool);
    const expiredMark = await pool.query(
      `SELECT snapshot_id, eligible_at > now() AS has_safety_window
       FROM gc_marks WHERE object_key = $1`,
      [sharedKey],
    );
    expect(expiredMark.rows).toHaveLength(1);
    expect(expiredMark.rows[0].snapshot_id).toBe(protectedId);
    expect(expiredMark.rows[0].has_safety_window).toBe(true);
  });
});
