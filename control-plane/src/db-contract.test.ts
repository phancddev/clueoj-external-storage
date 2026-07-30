import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as db from './db.js';
import type { JobT } from './schemas.js';

const t = (seconds: number) => new Date(Date.UTC(2026, 6, 29, 0, 0, seconds));

function syncRow(id: string, seconds: number) {
  return {
    external_id: id,
    code: `p${id}`,
    owner_organization: null,
    is_manually_managed: false,
    mirror_of: null,
    mirror_root: null,
    quota_bytes: null,
    catalog_state: 'present',
    logical_bytes: 1,
    allocated_bytes: 1,
    archive_bytes: 0,
    auxiliary_bytes: 0,
    file_count: 1,
    local_status: 'present',
    r2_status: 'ready',
    snapshot_generation: 1,
    orphan_bytes: 0,
    referenced_bytes: 0,
    stale: false,
    p_observed_at: t(seconds),
    pu_observed_at: t(seconds),
    updated_at: t(seconds),
  };
}

class SyncPool {
  constructor(private rows: Array<Record<string, unknown>>) {}
  async query(_sql: string, params: unknown[]) {
    const limit = Number(params[params.length - 1]);
    let rows = this.rows;
    if (params.length === 3) {
      const [updatedAt, externalId] = params as [string, string, number];
      const cursorTime = new Date(updatedAt).getTime();
      rows = rows.filter((r) => {
        const rowTime = (r.updated_at as Date).getTime();
        return rowTime > cursorTime || (rowTime === cursorTime && String(r.external_id) > externalId);
      });
    }
    return { rows: rows.slice(0, limit), rowCount: rows.length };
  }
}

const baseJob: JobT = {
  id: 'job-1',
  idempotency_key: 'idem',
  job_type: 'scan',
  problem_id: 'p1',
  target_generation: null,
  state: 'running',
  lease_owner: 'worker-a',
  lease_expires_at: '2026-07-29T00:01:00.000Z',
  fencing_token: 7,
  attempt: 1,
  max_attempts: 3,
  result: null,
  error_code: null,
  error_message: null,
  created_at: '2026-07-29T00:00:00.000Z',
  updated_at: '2026-07-29T00:00:00.000Z',
  completed_at: null,
};

class LeasePool {
  constructor(private state: { owner: string; token: number; running: boolean; unexpired: boolean }) {}
  async query(sql: string, params: unknown[]) {
    if (sql.includes('UPDATE jobs SET state = $2')) {
      const owner = params[5];
      const token = params[6];
      const ok = this.state.running && this.state.unexpired && owner === this.state.owner && token === this.state.token;
      return { rows: ok ? [{ ...baseJob, state: params[1], result: params[2], completed_at: new Date() }] : [], rowCount: ok ? 1 : 0 };
    }
    if (sql.includes('UPDATE jobs SET lease_expires_at')) {
      const ok = this.state.running && this.state.unexpired && params[1] === this.state.owner && params[3] === this.state.token;
      return { rows: [], rowCount: ok ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  }
}

class AcquirePool {
  public calls: string[] = [];
  async query(sql: string) {
    this.calls.push(sql);
    if (sql.includes('UPDATE jobs j SET state = \'failed\'')) return { rows: [], rowCount: 1 };
    expect(sql).toContain('job_fencing_counters');
    expect(sql).toContain('fencing_token = (SELECT fencing_token FROM token)');
    expect(sql).toContain('attempt < max_attempts');
    return { rows: [{ ...baseJob, lease_owner: 'worker-new', fencing_token: 8, attempt: 2 }], rowCount: 1 };
  }
}

class DirtyVersionPool {
  public params: unknown[] = [];
  async query(sql: string, params: unknown[]) {
    if (sql.includes('SELECT 1 FROM jobs')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
    if (sql.includes('UPDATE problems')) {
      this.params = params;
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  }
}

class RevokePool {
  public sql = '';
  async query(sql: string) {
    this.sql += `\n${sql}`;
    return { rows: [{ ...baseJob, state: 'cancelled', fencing_token: 8, completed_at: new Date() }], rowCount: 1 };
  }
}

class OrgSqlPool {
  public sql = '';
  async query(sql: string) {
    this.sql += `\n${sql}`;
    return { rows: [], rowCount: 0 };
  }
}

class AutoSchedulePool {
  public insertedJobs = 0;

  async query(sql: string, params: unknown[]) {
    if (sql.includes('INSERT INTO jobs')) {
      this.insertedJobs++;
      return { rows: [{
        ...baseJob,
        id: String(params[1]) === 'scan' ? 'scan-job' : 'snapshot-job',
        idempotency_key: params[0],
        job_type: params[1],
        problem_id: params[2],
        target_generation: params[3],
        state: 'pending',
        fencing_token: 0,
      }], rowCount: 1 };
    }
    if (sql.includes('UPDATE jobs SET result')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }
}

function problemRow(overrides: Record<string, unknown> = {}) {
  return {
    external_id: 'p1',
    code: 'sum',
    owner_organization: null,
    is_manually_managed: false,
    mirror_of: null,
    mirror_root: null,
    quota_bytes: null,
    catalog_state: 'present',
    dirty: false,
    dirty_generation: null,
    dirty_version: 0,
    observed_at: t(1),
    stale: false,
    ...overrides,
  };
}

class DirtyIdempotencyPool {
  public mutationCount = 0;
  private nextGeneration = 5;
  private idem: Record<string, { request_fingerprint: string; target_id: string; response_problem_id: string | null }> = {};
  private problems: Record<string, Record<string, unknown>> = {};

  async connect() {
    return {
      query: (sql: string, params: unknown[] = []) => this.query(sql, params),
      release: () => {},
    };
  }

  async query(sql: string, params: unknown[] = []) {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO idempotency_keys')) {
      const key = String(params[0]);
      if (this.idem[key]) return { rows: [], rowCount: 0 };
      this.idem[key] = { request_fingerprint: String(params[2]), target_id: String(params[3]), response_problem_id: null };
      return { rows: [{ ...this.idem[key], idempotency_key: key }], rowCount: 1 };
    }
    if (sql.includes('SELECT * FROM idempotency_keys')) {
      const row = this.idem[String(params[0])];
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('SELECT * FROM problems WHERE external_id')) {
      const row = this.problems[String(params[0])];
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO problems')) {
      const id = String(params[0]);
      const existing = this.problems[id];
      const deleted = sql.includes("catalog_state = 'deleted'");
      this.mutationCount++;
      this.problems[id] = problemRow({
        external_id: id,
        code: params[1],
        owner_organization: params[2],
        is_manually_managed: params[3],
        mirror_of: params[4],
        mirror_root: params[5],
        quota_bytes: params[6],
        catalog_state: deleted ? 'deleted' : 'present',
        dirty: !deleted,
        dirty_generation: null,
        dirty_version: deleted ? (existing?.dirty_version ?? 0) : Number(existing?.dirty_version ?? 0) + 1,
        stale: !deleted,
      });
      return { rows: [this.problems[id]], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO problem_generation_counters')) {
      const generation = this.nextGeneration;
      this.nextGeneration++;
      return { rows: [{ generation }], rowCount: 1 };
    }
    if (sql.includes('SET dirty_generation = $2')) {
      const row = this.problems[String(params[0])];
      if (row) row.dirty_generation = params[1];
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('UPDATE idempotency_keys')) {
      const row = this.idem[String(params[0])];
      if (row) row.response_problem_id = String(params[2]);
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  }
}

function sqlBeforeForUpdate(sql: string): string {
  const index = sql.indexOf('FOR UPDATE');
  expect(index).toBeGreaterThan(0);
  return sql.slice(0, index);
}

describe('DB contract hardening', () => {
  it('sync final page still returns a commit cursor', async () => {
    const result = await db.getSyncChanges(new SyncPool([syncRow('1', 1)]) as any, { limit: 100 });
    expect(result.has_more).toBe(false);
    expect(result.changes).toHaveLength(1);
    expect(result.next_cursor).toBeTruthy();
  });

  it('sync cursor paginates without replay or skip', async () => {
    const pool = new SyncPool([syncRow('1', 1), syncRow('2', 1), syncRow('3', 2)]) as any;
    const first = await db.getSyncChanges(pool, { limit: 2 });
    expect(first.has_more).toBe(true);
    expect(first.changes.map((c) => c.external_id)).toEqual(['1', '2']);

    const second = await db.getSyncChanges(pool, { cursor: first.next_cursor ?? undefined, limit: 2 });
    expect(second.has_more).toBe(false);
    expect(second.changes.map((c) => c.external_id)).toEqual(['3']);
    expect(second.next_cursor).toBeTruthy();
  });

  it('stale worker cannot complete after lease is stolen', async () => {
    const stolen = new LeasePool({ owner: 'worker-b', token: 8, running: true, unexpired: true }) as any;
    await expect(db.completeJobWithLease(stolen, baseJob, 'completed', {}, null, null)).resolves.toBeNull();
  });

  it('cancelled job cannot be overwritten by stale completion', async () => {
    const cancelled = new LeasePool({ owner: 'worker-a', token: 7, running: false, unexpired: true }) as any;
    await expect(db.completeJobWithLease(cancelled, baseJob, 'completed', {}, null, null)).resolves.toBeNull();
  });

  it('expired worker cannot renew or complete', async () => {
    const expired = new LeasePool({ owner: 'worker-a', token: 7, running: true, unexpired: false }) as any;
    await expect(db.renewJobLease(expired, baseJob.id, 'worker-a', 7, 60)).resolves.toBe(false);
    await expect(db.completeJobWithLease(expired, baseJob, 'completed', {}, null, null)).resolves.toBeNull();
  });

  it('reacquiring an expired running job assigns a newer fencing token', async () => {
    const pool = new AcquirePool();
    const job = await db.acquireJob(pool as any, 'worker-new', 60);
    expect(job?.fencing_token).toBeGreaterThan(baseJob.fencing_token);
    expect(job?.lease_owner).toBe('worker-new');
    expect(pool.calls[0]).toContain('attempt >= max_attempts');
    expect(pool.calls[0]).toContain('fencing_token = a.fencing_token');
    expect(pool.calls[0]).toContain('WITH locked AS');
    expect(pool.calls[0]).toContain('revoked AS');
    expect(sqlBeforeForUpdate(pool.calls[0])).not.toContain('ROW_NUMBER() OVER');
  });

  it('cancelling a running job revokes its stale Rust fencing token atomically', async () => {
    const pool = new RevokePool();
    const job = await db.cancelJob(pool as any, baseJob.id, 'stop');
    expect(job?.fencing_token).toBeGreaterThan(baseJob.fencing_token);
    expect(pool.sql).toContain('job_fencing_counters');
    expect(pool.sql).toContain('WITH locked AS');
    expect(pool.sql).toContain('fencing_token = b.fencing_token');
    expect(pool.sql).not.toContain('ROW_NUMBER() OVER');
    expect(sqlBeforeForUpdate(pool.sql)).not.toContain('OVER (');
  });

  it('old snapshot final cannot clear a newer dirty mutation', async () => {
    const pool = new DirtyVersionPool();
    await db.clearDirtyAfterSnapshotForJob(pool as any, baseJob, 'p1', 10, 3);
    expect(pool.params).toEqual(['p1', 10, 3]);
  });

  it('missing dirty_version does not clear dirty', async () => {
    const pool = new DirtyVersionPool();
    await db.clearDirtyAfterSnapshotForJob(pool as any, baseJob, 'p1', 10, null);
    expect(pool.params).toEqual([]);
  });

  it('organization accounting and largest problems only include active catalog states', async () => {
    const pool = new OrgSqlPool();
    await db.getOrganizationUsage(pool as any, 'org1');
    await db.listOrganizationUsage(pool as any, { limit: 10 });
    await db.listLargestProblems(pool as any, 10);
    await db.listLargestOrganizations(pool as any, 10);
    expect(pool.sql.match(/catalog_state IN \('present', 'mirror'\)/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('initial catalog dirty/no-READY problem schedules scan then snapshot jobs', async () => {
    const jobs = await db.scheduleAutoSnapshotJobs(new AutoSchedulePool() as any, {
      external_id: 'p1',
      code: 'sum',
      owner_organization: null,
      is_manually_managed: false,
      mirror_of: null,
      mirror_root: null,
      quota_bytes: null,
      catalog_state: 'present',
      dirty: true,
      dirty_generation: 1,
      dirty_version: 1,
      observed_at: '2026-07-29T00:00:00.000Z',
      stale: true,
    }, 'catalog-reconcile');
    expect(jobs).toEqual({ scan_job_id: 'scan-job', snapshot_job_id: 'snapshot-job' });
  });

  it('batch scheduling only selects problems with a present local projection', async () => {
    const pool = new OrgSqlPool();
    await db.scheduleDirtySnapshotBatch(pool as any, 'catalog-reconcile', 100);
    expect(pool.sql).toContain("pu.local_status = 'present'");
  });

  it('dirty idempotency replays same key/body without a second version increment', async () => {
    const pool = new DirtyIdempotencyPool();
    const body = {
      externalId: 'p1',
      code: 'sum',
      ownerOrganization: null,
      isManuallyManaged: false,
      mirrorOf: null,
      mirrorRoot: null,
      quotaBytes: null,
      schemaVersion: 1,
    };
    const first = await db.markProblemDirtyIdempotent(pool as any, 'idem-dirty', 'clueoj', body);
    const second = await db.markProblemDirtyIdempotent(pool as any, 'idem-dirty', 'clueoj', body);
    expect(first.mutated).toBe(true);
    expect(second.mutated).toBe(false);
    expect(first.problem.dirty_version).toBe(1);
    expect(second.problem.dirty_version).toBe(1);
    expect(pool.mutationCount).toBe(1);
  });

  it('dirty idempotency rejects same key with a different body', async () => {
    const pool = new DirtyIdempotencyPool();
    const body = {
      externalId: 'p1',
      code: 'sum',
      ownerOrganization: null,
      isManuallyManaged: false,
      mirrorOf: null,
      mirrorRoot: null,
      quotaBytes: null,
      schemaVersion: 1,
    };
    await db.markProblemDirtyIdempotent(pool as any, 'idem-dirty', 'clueoj', body);
    await expect(db.markProblemDirtyIdempotent(pool as any, 'idem-dirty', 'clueoj', { ...body, code: 'sum2' }))
      .rejects.toBeInstanceOf(db.IdempotencyConflictError);
    expect(pool.mutationCount).toBe(1);
  });

  it('distinct dirty mutations reserve unique generations through the shared counter', async () => {
    const pool = new DirtyIdempotencyPool();
    const body = {
      externalId: 'p1',
      code: 'sum',
      ownerOrganization: null,
      isManuallyManaged: false,
      mirrorOf: null,
      mirrorRoot: null,
      quotaBytes: null,
      schemaVersion: 1,
    };
    const first = await db.markProblemDirtyIdempotent(pool as any, 'idem-dirty-a', 'clueoj', body);
    const second = await db.markProblemDirtyIdempotent(pool as any, 'idem-dirty-b', 'clueoj', { ...body, code: 'sum-updated' });
    expect(first.problem.dirty_generation).toBe(5);
    expect(second.problem.dirty_generation).toBe(6);
    expect(first.problem.dirty_version).toBe(1);
    expect(second.problem.dirty_version).toBe(2);
  });

  it('dirty delete tombstone is not marked dirty for snapshot scheduling', async () => {
    const pool = new DirtyIdempotencyPool();
    const result = await db.markProblemDirtyIdempotent(pool as any, 'idem-delete', 'clueoj', {
      externalId: 'p1',
      code: 'sum',
      ownerOrganization: null,
      isManuallyManaged: false,
      mirrorOf: null,
      mirrorRoot: null,
      quotaBytes: null,
      schemaVersion: 1,
      catalogState: 'deleted',
    });
    expect(result.problem.catalog_state).toBe('deleted');
    expect(result.problem.dirty).toBe(false);
  });

  it('migration provides atomic fencing and generation counters', () => {
    const sql = readFileSync(resolve(__dirname, '../../migrations/003_review_contracts.sql'), 'utf-8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS job_fencing_counters');
    expect(sql).toContain('problem_id  TEXT PRIMARY KEY');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS problem_generation_counters');
    expect(sql).toContain('dirty_version BIGINT');
    const idempotencySql = readFileSync(resolve(__dirname, '../../migrations/004_idempotency_dirty_contract.sql'), 'utf-8');
    expect(idempotencySql).toContain('ADD COLUMN IF NOT EXISTS request_fingerprint');
    expect(idempotencySql).toContain('ADD COLUMN IF NOT EXISTS response_problem_id');
  });
});
