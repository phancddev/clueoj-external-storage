import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildRoutes } from './routes.js';
import { signOperatorToken, signServiceToken } from './auth.js';
import { DUMMY_PASSWORD_HASH, hashPassword } from './password.js';
import { stableFingerprint } from './db.js';
import type { Pool } from 'pg';
import type { RustClient } from './rust-client.js';

const env: Env = {
  databaseUrl: 'postgres://test',
  rustBaseUrl: 'http://rust',
  rustInternalToken: 'internal',
  dashboardJwtSecret: 'dashboard-secret',
  dashboardJwtAudience: 'clueoj-storage-dashboard',
  clueojServiceAudience: 'clueoj-storage',
  clueojServiceSecret: 'service-secret',
  corsAllowedOrigins: ['http://localhost:2907'],
  trustProxy: false,
  workerEnabled: false,
  workerLeaseSeconds: 60,
  presignTtlSeconds: 180,
  port: 2907,
  logLevel: 'silent',
  dashboardDir: '../dashboard/dist',
  problemRootContainer: '/problems',
};

function dashboardUserResult(
  sql: string,
  params: unknown[] = [],
  passwordHash = DUMMY_PASSWORD_HASH,
  authVersion = 1,
) {
  if (!sql.includes('FROM dashboard_users')) return undefined;
  const username = String(params[0] ?? 'admin');
  return {
    rows: [{
      username,
      password_hash: passwordHash,
      role: 'storage-admin',
      enabled: true,
      auth_version: authVersion,
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-01T00:00:00Z'),
      password_changed_at: new Date('2026-01-01T00:00:00Z'),
    }],
    rowCount: 1,
  };
}

class FakePool {
  constructor(
    private passwordHash = DUMMY_PASSWORD_HASH,
    private authVersion = 1,
  ) {}
  async query(sql: string, params: unknown[] = []) {
    const dashboardUser = dashboardUserResult(sql, params, this.passwordHash, this.authVersion);
    if (dashboardUser) return dashboardUser;
    if (sql.includes('SELECT 1')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
    if (sql.includes('INSERT INTO storage_volumes')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }
}

class EnsureReadyPool {
  accessTouches = 0;

  constructor(private mode: 'ready' | 'restore' | 'unavailable' | 'snapshotting' | 'terminal' | 'partial-clean' | 'partial-dirty') {}
  async connect() {
    return {
      query: (sql: string, params: unknown[] = []) => this.query(sql, params),
      release: () => {},
    };
  }
  async query(sql: string, params: unknown[] = []) {
    const dashboardUser = dashboardUserResult(sql, params);
    if (dashboardUser) return dashboardUser;
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (sql.includes('SET last_accessed_at = now()')) {
      this.accessTouches += 1;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('pg_advisory_xact_lock') && !sql.includes('INSERT INTO jobs')) {
      return { rows: [{}], rowCount: 1 };
    }
    if (sql.includes('SELECT * FROM problems WHERE external_id')) {
      return { rows: [{
        external_id: 'p1',
        code: 'sum',
        owner_organization: null,
        is_manually_managed: false,
        mirror_of: null,
        mirror_root: null,
        quota_bytes: null,
        catalog_state: 'present',
        dirty: this.mode === 'snapshotting' || this.mode === 'partial-dirty',
        dirty_generation: 10,
        dirty_version: 3,
        observed_at: new Date(),
        stale: false,
      }], rowCount: 1 };
    }
    if (sql.includes('SELECT * FROM problem_usage')) {
      return { rows: this.mode === 'ready' ? [{
        problem_id: 'p1',
        logical_bytes: 1,
        allocated_bytes: 1,
        archive_bytes: 0,
        auxiliary_bytes: 0,
        file_count: 1,
        local_status: 'present',
        r2_status: 'ready',
        snapshot_generation: 9,
        orphan_bytes: 0,
        referenced_bytes: 0,
        quota_bytes: null,
        observed_at: new Date(),
        stale: false,
      }] : [], rowCount: this.mode === 'ready' ? 1 : 0 };
    }
    if (sql.includes('FROM snapshots')) {
      return { rows: this.mode === 'restore' || this.mode === 'terminal' ? [{
        id: 'snap-1',
        problem_id: 'p1',
        generation: 9,
        state: 'ready',
        file_count: 1,
        total_bytes: 1,
        manifest_key: 'm',
        error_code: null,
        error_message: null,
        created_at: new Date(),
        completed_at: new Date(),
      }] : [], rowCount: this.mode === 'restore' || this.mode === 'terminal' ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO problem_generation_counters')) {
      return { rows: [{ generation: 10 }], rowCount: 1 };
    }
    if (sql.includes('SELECT * FROM jobs') && sql.includes("job_type = 'restore'")) {
      if (this.mode !== 'terminal') return { rows: [], rowCount: 0 };
      return { rows: [{
        id: 'job-restore',
        idempotency_key: 'idem-ensure',
        job_type: 'restore',
        problem_id: 'p1',
        target_generation: 9,
        state: 'failed',
        lease_owner: null,
        lease_expires_at: null,
        fencing_token: 1,
        attempt: 1,
        max_attempts: 3,
        request_fingerprint: stableFingerprint({
          action: 'ensure-ready-restore',
          external_id: 'p1',
          generation: 9,
        }),
        result: null,
        error_code: 'job_failed',
        error_message: 'failed',
        created_at: new Date(),
        updated_at: new Date(),
        completed_at: new Date(),
      }], rowCount: 1 };
    }
    if (sql.includes('SELECT local_status, observed_at') && sql.includes('FROM problem_usage')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('INSERT INTO problem_usage')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO jobs')) {
      return { rows: [{
        id: this.mode === 'snapshotting' ? 'job-snapshot' : 'job-restore',
        idempotency_key: 'idem-ensure',
        job_type: this.mode === 'snapshotting' ? 'snapshot' : 'restore',
        problem_id: 'p1',
        target_generation: this.mode === 'snapshotting' ? 10 : 9,
        state: this.mode === 'terminal' ? 'failed' : 'pending',
        lease_owner: null,
        lease_expires_at: null,
        fencing_token: 1,
        attempt: 1,
        max_attempts: 3,
        result: null,
        error_code: null,
        error_message: null,
        created_at: new Date(),
        updated_at: new Date(),
        completed_at: null,
      }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO audit_events')) return { rows: [], rowCount: 1 };
    if (sql.includes('UPDATE jobs SET result')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }
}

class DirtyEndpointPool {
  public jobs: string[] = [];
  public failNextSnapshotInsert = false;
  public problems: Record<string, Record<string, unknown>> = {};
  private idem: Record<string, { request_fingerprint: string; target_id: string; response_problem_id: string | null }> = {};
  private jobRows: Record<string, Record<string, unknown>> = {};
  private nextGeneration = 5;

  async connect() {
    return {
      query: (sql: string, params: unknown[] = []) => this.query(sql, params),
      release: () => {},
    };
  }

  async query(sql: string, params: unknown[] = []) {
    const dashboardUser = dashboardUserResult(sql, params);
    if (dashboardUser) return dashboardUser;
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
    if (sql.includes('SELECT external_id FROM problems WHERE external_id')) {
      const row = this.problems[String(params[0])];
      return { rows: row ? [{ external_id: row.external_id }] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('SELECT EXISTS') && sql.includes('FROM snapshots')) {
      return { rows: [{ has_history: false }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO problem_usage')) return { rows: [], rowCount: 1 };
    if (sql.includes('DELETE FROM problems')) {
      delete this.problems[String(params[0])];
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('FROM problems') && sql.includes('WHERE code = $1') && sql.includes('FOR UPDATE')) {
      const row = Object.values(this.problems).find((problem) => problem.code === params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('UPDATE problems') && sql.includes('SET external_id = $2')) {
      const oldId = String(params[0]);
      const newId = String(params[1]);
      const row = this.problems[oldId];
      if (row && row.code === params[2] && row.catalog_state === 'orphan') {
        delete this.problems[oldId];
        row.external_id = newId;
        this.problems[newId] = row;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('INSERT INTO problems')) {
      const id = String(params[0]);
      const existing = this.problems[id];
      const deleted = sql.includes("catalog_state = 'deleted'");
      this.problems[id] = {
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
        observed_at: new Date(),
        stale: !deleted,
      };
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
    if (sql.includes('INSERT INTO jobs')) {
      const idempotencyKey = String(params[0]);
      const jobType = String(params[1]);
      if (this.failNextSnapshotInsert && jobType === 'snapshot') {
        this.failNextSnapshotInsert = false;
        throw new Error('connection dropped while scheduling snapshot');
      }
      if (!this.jobRows[idempotencyKey]) {
        this.jobs.push(jobType);
        this.jobRows[idempotencyKey] = {
          id: `${jobType}-job`,
          idempotency_key: params[0],
          job_type: jobType,
          problem_id: params[2],
          target_generation: params[3],
          state: 'pending',
          lease_owner: null,
          lease_expires_at: null,
          fencing_token: 0,
          attempt: 1,
          max_attempts: 3,
          result: null,
          error_code: null,
          error_message: null,
          created_at: new Date(),
          updated_at: new Date(),
          completed_at: null,
        };
      }
      return { rows: [this.jobRows[idempotencyKey]], rowCount: 1 };
    }
    if (sql.includes('UPDATE jobs SET result')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO audit_events')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }
}

const rust = {
  health: async () => true,
  getVolumes: async () => ({
    total_bytes: '9223372036854775807',
    free_bytes: '9223372036854775806',
    available_bytes: '9223372036854775805',
    observed_at: '2026-07-29T00:00:00.000Z',
    stale: false,
  }),
  ready: async (_externalId: string) => ({
    ready: true,
    local_status: 'present',
    generation: null,
    observed_at: '2026-07-29T00:00:00.000Z',
  }),
};

const rustByMode = (mode: 'ready' | 'restore' | 'unavailable' | 'snapshotting' | 'terminal' | 'partial-clean' | 'partial-dirty') => ({
  ...rust,
  ready: async () => ({
    ready: mode === 'ready' || mode === 'snapshotting',
    local_status: mode === 'ready' || mode === 'snapshotting'
      ? 'present'
      : mode === 'partial-clean' || mode === 'partial-dirty'
        ? 'partial'
        : 'missing',
    generation: null,
    observed_at: '2026-07-29T00:00:00.000Z',
  }),
});

describe('runtime route contracts', () => {
  it('authenticates a database-backed dashboard administrator', async () => {
    const passwordHash = await hashPassword('correct horse battery staple');
    const app = Fastify({ logger: false });
    await buildRoutes(app, { pool: new FakePool(passwordHash) as any, env, rust: rust as any });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'Admin', password: 'correct horse battery staple' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ role: 'storage-admin', token_type: 'Bearer' });
  });

  it('rejects an invalid dashboard password without revealing whether the user exists', async () => {
    const passwordHash = await hashPassword('correct horse battery staple');
    const app = Fastify({ logger: false });
    await buildRoutes(app, { pool: new FakePool(passwordHash) as any, env, rust: rust as any });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: 'wrong password' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'invalid_credentials' });
  });

  it('allows dashboard HTML and assets to load before authentication', async () => {
    const app = Fastify({ logger: false });
    app.get('/', async () => 'dashboard');
    await buildRoutes(app, { pool: new FakePool() as any, env, rust: rust as any });

    const res = await app.inject({ method: 'GET', url: '/' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('dashboard');
  });

  it('keeps volume response paginated, snake_case, and bigint-safe', async () => {
    const app = Fastify({ logger: false });
    await buildRoutes(app, { pool: new FakePool() as any, env, rust: rust as any });
    const token = await signOperatorToken(env.dashboardJwtSecret, 'admin', 'viewer', 60, env.dashboardJwtAudience);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/storage/volumes',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [{
        name: 'problem-root',
        mount_path: '/problems',
        total_bytes: '9223372036854775807',
        free_bytes: '9223372036854775806',
        available_bytes: '9223372036854775805',
        observed_at: '2026-07-29T00:00:00.000Z',
        stale: false,
      }],
      next_cursor: null,
      has_more: false,
    });
  });

  it('rejects an operator token after the user auth version changes', async () => {
    const app = Fastify({ logger: false });
    await buildRoutes(app, { pool: new FakePool(DUMMY_PASSWORD_HASH, 2) as any, env, rust: rust as any });
    const oldToken = await signOperatorToken(
      env.dashboardJwtSecret,
      'admin',
      'storage-admin',
      60,
      env.dashboardJwtAudience,
      1,
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/storage/volumes',
      headers: { authorization: `Bearer ${oldToken}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it('accepts ClueOJ service JWT only with service secret, audience, and kind', async () => {
    const app = Fastify({ logger: false });
    await buildRoutes(app, { pool: new FakePool() as any, env, rust: rust as any });
    const serviceToken = await signServiceToken(env.clueojServiceSecret, 'clueoj', env.clueojServiceAudience, ['read'], 60);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/storage/volumes',
      headers: { authorization: `Bearer ${serviceToken}` },
    });
    expect(res.statusCode).toBe(200);

    const wrongKind = await signOperatorToken(env.dashboardJwtSecret, 'admin', 'viewer', 60, env.clueojServiceAudience);
    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/storage/volumes',
      headers: { authorization: `Bearer ${wrongKind}` },
    });
    expect(denied.statusCode).toBe(401);
  });

  it('ensure-ready returns ready only when local is already present', async () => {
    const app = Fastify({ logger: false });
    const pool = new EnsureReadyPool('ready');
    await buildRoutes(app, { pool: pool as unknown as Pool, env, rust: rustByMode('ready') as unknown as RustClient });
    const token = await signOperatorToken(env.dashboardJwtSecret, 'admin', 'operator', 60, env.dashboardJwtAudience);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/problems/p1/ensure-ready',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'idem-ensure' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ready', ready: true });
    expect(pool.accessTouches).toBe(1);
  });

  it('rejects a malformed automatic eviction cutoff before creating a job', async () => {
    const app = Fastify({ logger: false });
    await buildRoutes(app, { pool: new EnsureReadyPool('ready') as any, env, rust: rustByMode('ready') as any });
    const token = await signOperatorToken(env.dashboardJwtSecret, 'admin', 'operator', 60, env.dashboardJwtAudience);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/problems/p1/evict',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'idem-evict-invalid' },
      payload: { dry_run: false, force: true, idle_before: 'not-a-date' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'bad_request', retryable: false });
  });

  it('ensure-ready enqueues restore when local is absent but READY snapshot exists', async () => {
    const app = Fastify({ logger: false });
    await buildRoutes(app, { pool: new EnsureReadyPool('restore') as any, env, rust: rustByMode('restore') as any });
    const token = await signOperatorToken(env.dashboardJwtSecret, 'admin', 'operator', 60, env.dashboardJwtAudience);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/problems/p1/ensure-ready',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'idem-ensure' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'restoring', ready: false, job_id: 'job-restore' });
  });

  it('ensure-ready refuses to claim success without local data or READY snapshot', async () => {
    const app = Fastify({ logger: false });
    await buildRoutes(app, { pool: new EnsureReadyPool('unavailable') as any, env, rust: rustByMode('unavailable') as any });
    const token = await signOperatorToken(env.dashboardJwtSecret, 'admin', 'operator', 60, env.dashboardJwtAudience);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/problems/p1/ensure-ready',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'idem-ensure' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'not_ready' });
  });

  it('ensure-ready serves dirty-but-usable local data immediately; snapshots run in the background', async () => {
    const app = Fastify({ logger: false });
    await buildRoutes(app, { pool: new EnsureReadyPool('snapshotting') as any, env, rust: rustByMode('snapshotting') as any });
    const token = await signOperatorToken(env.dashboardJwtSecret, 'admin', 'operator', 60, env.dashboardJwtAudience);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/problems/p1/ensure-ready',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'idem-ensure' },
    });
    // The judge reads the local folder directly, so a usable folder grades
    // now; the owed snapshot is scheduled by the watcher/reconcile path and
    // must never block submissions behind the snapshot queue.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ready', ready: true });
  });

  it('ensure-ready refuses to snapshot dirty partial data over a complete snapshot', async () => {
    const app = Fastify({ logger: false });
    await buildRoutes(app, { pool: new EnsureReadyPool('partial-dirty') as any, env, rust: rustByMode('partial-dirty') as any });
    const token = await signOperatorToken(env.dashboardJwtSecret, 'admin', 'operator', 60, env.dashboardJwtAudience);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/problems/p1/ensure-ready',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'idem-ensure' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'local_integrity_mismatch', retryable: true });
  });

  it('ensure-ready refuses to overwrite unverified local data', async () => {
    const app = Fastify({ logger: false });
    await buildRoutes(app, { pool: new EnsureReadyPool('partial-clean') as any, env, rust: rustByMode('partial-clean') as any });
    const token = await signOperatorToken(env.dashboardJwtSecret, 'admin', 'operator', 60, env.dashboardJwtAudience);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/problems/p1/ensure-ready',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'idem-ensure' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'local_integrity_mismatch', retryable: true });
  });

  it('ensure-ready exposes terminal job replay so the client can rotate its key', async () => {
    const app = Fastify({ logger: false });
    await buildRoutes(app, { pool: new EnsureReadyPool('terminal') as any, env, rust: rustByMode('terminal') as any });
    const token = await signOperatorToken(env.dashboardJwtSecret, 'admin', 'operator', 60, env.dashboardJwtAudience);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/problems/p1/ensure-ready',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'idem-ensure' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'ensure_ready_job_terminal', retryable: true });
  });

  it('dirty upload schedules scan and snapshot once for the first idempotent mutation', async () => {
    const app = Fastify({ logger: false });
    const pool = new DirtyEndpointPool();
    await buildRoutes(app, { pool: pool as any, env, rust: rust as any });
    const token = await signServiceToken(env.clueojServiceSecret, 'clueoj', env.clueojServiceAudience, ['mutate'], 60);
    const req = {
      method: 'POST' as const,
      url: '/api/v1/problems/p1/dirty',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'idem-dirty' },
      payload: { external_id: 'p1', code: 'sum', schema_version: 1 },
    };

    const first = await app.inject(req);
    const retry = await app.inject(req);

    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ external_id: 'p1', dirty: true, dirty_version: 1, dirty_generation: 5 });
    expect(retry.json()).toMatchObject({ external_id: 'p1', dirty: true, dirty_version: 1, dirty_generation: 5 });
    expect(pool.jobs).toEqual(['scan', 'snapshot']);
  });

  it('dirty upload preserves nullable owner and mirror references as SQL NULL', async () => {
    const app = Fastify({ logger: false });
    const pool = new DirtyEndpointPool();
    await buildRoutes(app, { pool: pool as any, env, rust: rust as any });
    const token = await signServiceToken(env.clueojServiceSecret, 'clueoj', env.clueojServiceAudience, ['mutate'], 60);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/problems/p-null/dirty',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'idem-null-dirty' },
      payload: {
        external_id: 'p-null',
        code: 'sum-null',
        owner_organization: null,
        mirror_of: null,
        mirror_root: null,
        quota_bytes: null,
        schema_version: 1,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(pool.problems['p-null']).toMatchObject({
      owner_organization: null,
      mirror_of: null,
      mirror_root: null,
      quota_bytes: null,
    });
  });

  it('dirty upload atomically claims a watcher-created orphan with the same code', async () => {
    const app = Fastify({ logger: false });
    const pool = new DirtyEndpointPool();
    pool.problems['orphan:claimed-code'] = {
      external_id: 'orphan:claimed-code',
      code: 'claimed-code',
      owner_organization: null,
      is_manually_managed: false,
      mirror_of: null,
      mirror_root: null,
      quota_bytes: null,
      catalog_state: 'orphan',
      dirty: false,
      dirty_generation: null,
      dirty_version: 0,
      observed_at: new Date(),
      stale: false,
    };
    await buildRoutes(app, { pool: pool as any, env, rust: rust as any });
    const token = await signServiceToken(env.clueojServiceSecret, 'clueoj', env.clueojServiceAudience, ['mutate'], 60);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/problems/42/dirty',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'idem-claim-orphan' },
      payload: { external_id: '42', code: 'claimed-code', schema_version: 1 },
    });

    expect(response.statusCode).toBe(200);
    expect(pool.problems['orphan:claimed-code']).toBeUndefined();
    expect(pool.problems['42']).toMatchObject({
      external_id: '42',
      code: 'claimed-code',
      catalog_state: 'present',
      dirty: true,
    });
  });

  it('dirty upload merges an orphan when the authoritative problem already exists under an old code', async () => {
    const app = Fastify({ logger: false });
    const pool = new DirtyEndpointPool();
    pool.problems['42'] = {
      external_id: '42',
      code: 'old-code',
      catalog_state: 'present',
      dirty: false,
      dirty_generation: null,
      dirty_version: 0,
      observed_at: new Date(),
      stale: false,
    };
    pool.problems['orphan:new-code'] = {
      external_id: 'orphan:new-code',
      code: 'new-code',
      catalog_state: 'orphan',
      dirty: false,
      dirty_generation: null,
      dirty_version: 0,
      observed_at: new Date(),
      stale: false,
    };
    await buildRoutes(app, { pool: pool as any, env, rust: rust as any });
    const token = await signServiceToken(env.clueojServiceSecret, 'clueoj', env.clueojServiceAudience, ['mutate'], 60);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/problems/42/dirty',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'idem-rename-orphan' },
      payload: { external_id: '42', code: 'new-code', schema_version: 1 },
    });

    expect(response.statusCode).toBe(200);
    expect(pool.problems['orphan:new-code']).toBeUndefined();
    expect(pool.problems['42']).toMatchObject({ code: 'new-code', catalog_state: 'present' });
  });

  it('dirty retry recovers missing auto-push jobs after post-commit scheduling failure', async () => {
    const app = Fastify({ logger: false });
    const pool = new DirtyEndpointPool();
    pool.failNextSnapshotInsert = true;
    await buildRoutes(app, { pool: pool as any, env, rust: rust as any });
    const token = await signServiceToken(env.clueojServiceSecret, 'clueoj', env.clueojServiceAudience, ['mutate'], 60);
    const req = {
      method: 'POST' as const,
      url: '/api/v1/problems/p1/dirty',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'idem-dirty' },
      payload: { external_id: 'p1', code: 'sum', schema_version: 1 },
    };

    const first = await app.inject(req);
    const retry = await app.inject(req);

    expect(first.statusCode).toBe(502);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ external_id: 'p1', dirty: true, dirty_version: 1, dirty_generation: 5 });
    expect(pool.jobs).toEqual(['scan', 'snapshot']);
  });

  it('dirty endpoint rejects idempotency key reuse with a different body', async () => {
    const app = Fastify({ logger: false });
    const pool = new DirtyEndpointPool();
    await buildRoutes(app, { pool: pool as any, env, rust: rust as any });
    const token = await signServiceToken(env.clueojServiceSecret, 'clueoj', env.clueojServiceAudience, ['mutate'], 60);
    await app.inject({
      method: 'POST',
      url: '/api/v1/problems/p1/dirty',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'idem-dirty' },
      payload: { external_id: 'p1', code: 'sum', schema_version: 1 },
    });
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/v1/problems/p1/dirty',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'idem-dirty' },
      payload: { external_id: 'p1', code: 'sum2', schema_version: 1 },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'idempotency_conflict' });
    expect(pool.jobs).toEqual(['scan', 'snapshot']);
  });

  it('dirty delete tombstone does not resurrect or schedule snapshot jobs', async () => {
    const app = Fastify({ logger: false });
    const pool = new DirtyEndpointPool();
    await buildRoutes(app, { pool: pool as any, env, rust: rust as any });
    const token = await signServiceToken(env.clueojServiceSecret, 'clueoj', env.clueojServiceAudience, ['mutate'], 60);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/problems/p1/dirty',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'idem-delete' },
      payload: { external_id: 'p1', code: 'sum', event_kind: 'delete', catalog_state: 'deleted', schema_version: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ external_id: 'p1', catalog_state: 'deleted', dirty: false });
    expect(pool.jobs).toEqual([]);
  });
});

describe('problem files + audit filter contracts', () => {

  it('problem files returns per-file test data of the latest READY snapshot', async () => {
    const app = Fastify({ logger: false });
    const pool = new FilesAuditPool();
    await buildRoutes(app, { pool: pool as unknown as Pool, env, rust: rustByMode('ready') as unknown as RustClient });
    const token = await signServiceToken(env.clueojServiceSecret, 'clueoj', env.clueojServiceAudience, ['read'], 60);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/problems/p1/files',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ problem_id: 'p1', generation: 3, snapshot_id: 'snap-1', snapshot_state: 'ready', total_bytes: 2048, file_count: 2, has_more: false });
    expect(body.items).toHaveLength(2);
    expect(body.items.map((i: { rel_path: string }) => i.rel_path)).toEqual(['tests/01.in', 'tests/01.out']);
    expect(body.items[0]).toMatchObject({ sha256: 'a'.repeat(64), size_bytes: 1024, object_key: 'objects/sha256/aa/aaaa', uploaded: true, verified: true });
  });

  it('problem files returns an empty manifest when no READY snapshot exists', async () => {
    const app = Fastify({ logger: false });
    const pool = new FilesAuditPool();
    pool.snapshotReady = false;
    await buildRoutes(app, { pool: pool as unknown as Pool, env, rust: rustByMode('ready') as unknown as RustClient });
    const token = await signServiceToken(env.clueojServiceSecret, 'clueoj', env.clueojServiceAudience, ['read'], 60);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/problems/p1/files',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ problem_id: 'p1', generation: null, items: [], has_more: false });
  });

  it('problem files returns 404 for an unknown problem', async () => {
    const app = Fastify({ logger: false });
    const pool = new FilesAuditPool();
    pool.problemExists = false;
    await buildRoutes(app, { pool: pool as unknown as Pool, env, rust: rustByMode('ready') as unknown as RustClient });
    const token = await signServiceToken(env.clueojServiceSecret, 'clueoj', env.clueojServiceAudience, ['read'], 60);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/problems/p1/files',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'not_found' });
  });

  it('audit events accepts from/to range filters and validates timestamps', async () => {
    const app = Fastify({ logger: false });
    const pool = new FilesAuditPool();
    await buildRoutes(app, { pool: pool as unknown as Pool, env, rust: rustByMode('ready') as unknown as RustClient });
    const token = await signServiceToken(env.clueojServiceSecret, 'clueoj', env.clueojServiceAudience, ['read'], 60);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-events?from=2026-01-01T00:00:00Z&to=2026-01-31T23:59:59Z',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const auditQuery = pool.queries.find((q) => q.sql.includes('FROM audit_events'));
    expect(auditQuery).toBeDefined();
    expect(auditQuery!.sql).toContain('created_at >=');
    expect(auditQuery!.sql).toContain('created_at <=');
    expect(auditQuery!.params).toContain('2026-01-01T00:00:00.000Z');
    expect(auditQuery!.params).toContain('2026-01-31T23:59:59.000Z');

    const bad = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-events?from=not-a-date',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'invalid_query' });
  });
});

class FilesAuditPool {
  queries: { sql: string; params: unknown[] }[] = [];
  snapshotReady = true;
  problemExists = true;

  async query(sql: string, params: unknown[] = []) {
    this.queries.push({ sql, params });
    const dashboardUser = dashboardUserResult(sql, params);
    if (dashboardUser) return dashboardUser;
    if (sql.includes('FROM problems') && sql.includes('external_id')) {
      if (!this.problemExists) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          external_id: String(params[0]),
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
          observed_at: new Date(),
          stale: false,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes('FROM snapshots')) {
      if (!this.snapshotReady) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          id: 'snap-1',
          problem_id: String(params[0]),
          generation: 3,
          state: 'ready',
          file_count: 2,
          total_bytes: 2048,
          manifest_key: 'm',
          error_code: null,
          error_message: null,
          created_at: new Date(),
          completed_at: new Date(),
        }],
        rowCount: 1,
      };
    }
    if (sql.includes('FROM snapshot_objects')) {
      return {
        rows: [
          { snapshot_id: 'snap-1', rel_path: 'tests/01.in', sha256: 'a'.repeat(64), size_bytes: 1024, object_key: 'objects/sha256/aa/aaaa', uploaded: true, verified: true },
          { snapshot_id: 'snap-1', rel_path: 'tests/01.out', sha256: 'b'.repeat(64), size_bytes: 1024, object_key: 'objects/sha256/bb/bbbb', uploaded: true, verified: true },
        ],
        rowCount: 2,
      };
    }
    return { rows: [], rowCount: 0 };
  }
}
