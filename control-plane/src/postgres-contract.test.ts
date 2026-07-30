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
    ]) {
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
});
