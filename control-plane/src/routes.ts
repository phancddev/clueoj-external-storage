import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import type { Env } from './env.js';
import type { RustClient } from './rust-client.js';
import * as db from './db.js';
import { logger } from './logger.js';
import {
  verifyToken, hasScope, extractBearerToken, type StorageJWTPayload,
} from './auth.js';
import {
  isDashboardSessionActive, verifyDashboardCredentials,
} from './dashboard-users.js';
import {
  LoginRequest, LoginResponse, ReconcileRequest, SyncChangesResponse, Paginated,
  Problem, ProblemUsage, OrganizationUsage, Snapshot, Job, Orphan, AuditEvent,
  DownloadRequest, DownloadResponse, HealthResponse, Volume, AcceptedJobResponse,
  DirtyProblemRequest, EnsureReadyResponse,
  ServiceTokenRequest, ServiceTokenResponse,
  ErrorResponse, RestoreDryRunResponse,
} from './schemas.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const openapiSpecYaml = readFileSync(
  join(__dirname, '../../packages/contracts/openapi/openapi.yaml'),
  'utf-8',
);
let openapiSpec: unknown;
try {
  // Parse YAML to JSON for /openapi.json endpoint
  const yaml = await import('yaml');
  openapiSpec = yaml.parse(openapiSpecYaml);
} catch {
  openapiSpec = { error: 'YAML parser not available' };
}

export interface AppContext {
  pool: Pool;
  env: Env;
  rust: RustClient;
}

function genRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function buildRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // ----------------------------------------------------------------------
  // Request ID + logging
  // ----------------------------------------------------------------------
  app.addHook('onRequest', async (req: FastifyRequest) => {
    (req as FastifyRequest & { requestId: string }).requestId = req.headers['x-request-id'] as string || genRequestId();
  });

  // ----------------------------------------------------------------------
  // Auth decorator: populates req.auth or returns 401
  // ----------------------------------------------------------------------
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split('?')[0];
    // Dashboard HTML/assets are public so the login screen can load. Authentication
    // still applies to every API route except the explicitly public endpoints below.
    if (!path.startsWith('/api/v1/')) return;
    // Public API: health + login + contract
    if (path === '/api/v1/system/health' || path === '/api/v1/auth/login' || path === '/api/v1/openapi.json' || path === '/api/v1/openapi.yaml') return;

    const token = extractBearerToken(req);
    if (!token) {
      return reply.code(401).send({ code: 'unauthorized', message: 'Missing bearer token', retryable: false, request_id: genRequestId() });
    }
    try {
      let payload: StorageJWTPayload | null = null;
      try {
        payload = await verifyToken(token, ctx.env.dashboardJwtSecret, ctx.env.dashboardJwtAudience, 'operator');
        if (!await isDashboardSessionActive(ctx.pool, payload)) {
          logger.warn({
            request_id: getRequestId(req),
            path,
            subject: payload.sub,
          }, 'dashboard operator session revoked');
          throw new Error('Dashboard session revoked');
        }
      } catch {
        try {
          payload = await verifyToken(token, ctx.env.clueojServiceSecret, ctx.env.clueojServiceAudience, 'service');
        } catch {
          logger.warn({
            request_id: getRequestId(req),
            path,
          }, 'bearer token rejected');
          throw new Error('Bearer token rejected');
        }
      }
      (req as FastifyRequest & { auth: StorageJWTPayload }).auth = payload;
    } catch {
      return reply.code(401).send({ code: 'invalid_token', message: 'Invalid or expired token', retryable: false, request_id: genRequestId() });
    }
  });

  app.addHook('onError', async (req: FastifyRequest, reply: FastifyReply, err: Error) => {
    const requestId = (req as FastifyRequest & { requestId: string }).requestId;
    logger.error({ err: err.message, stack: err.stack, request_id: requestId, url: req.url }, 'request error');
    if (!reply.sent) {
      reply.code(500).send({ code: 'internal', message: 'Internal server error', retryable: true, request_id: requestId });
    }
  });

  // ----------------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------------
  function getAuth(req: FastifyRequest): StorageJWTPayload {
    return (req as FastifyRequest & { auth: StorageJWTPayload }).auth;
  }
  function getRequestId(req: FastifyRequest): string {
    return (req as FastifyRequest & { requestId: string }).requestId;
  }
  function requireScopes(req: FastifyRequest, reply: FastifyReply, ...scopes: string[]): boolean {
    const auth = getAuth(req);
    if (!scopes.some((s) => hasScope(auth, s))) {
      reply.code(403).send({ code: 'forbidden', message: `Missing required scope: ${scopes.join(' or ')}`, retryable: false, request_id: getRequestId(req) });
      return false;
    }
    return true;
  }

  function accepted(job: { id: string; state: string }) {
    return {
      job_id: job.id,
      state: job.state,
      poll_url: `/api/v1/jobs/${job.id}`,
      events_url: `/api/v1/jobs/${job.id}/events`,
    };
  }

  async function audit(ctx: AppContext, req: FastifyRequest, action: string, opts: {
    targetType?: string | null; targetId?: string | null;
    problemId?: string | null; generation?: number | null; jobId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const auth = getAuth(req);
    await db.insertAuditEvent(ctx.pool, {
      actor: auth.sub, actorRole: auth.role, action,
      targetType: opts.targetType, targetId: opts.targetId,
      problemId: opts.problemId, generation: opts.generation, jobId: opts.jobId,
      metadata: opts.metadata, requestId: getRequestId(req),
    });
  }

  function getIdempotencyKey(req: FastifyRequest, reply?: FastifyReply): string | null {
    const k = req.headers['idempotency-key'] as string | undefined;
    if (!k) {
      if (reply) {
        reply.code(400).send({ code: 'bad_request', message: 'Idempotency-Key header required', retryable: false, request_id: getRequestId(req) });
      }
      return null;
    }
    return k;
  }

  function parseLimit(value: string | undefined, fallback: number, max: number): number {
    const parsed = Number.parseInt(value ?? String(fallback), 10);
    if (!Number.isFinite(parsed) || parsed < 1) return fallback;
    return Math.min(parsed, max);
  }

  function catalogProblemFrom(raw: Record<string, unknown>, pathExternalId?: string) {
    const externalId = String(raw.external_id ?? raw.problem_pk ?? pathExternalId ?? '');
    const code = String(raw.code ?? '');
    if (!externalId || !code) throw new Error('external_id/problem_pk and code are required');
    const normalizeNullable = (value: unknown): string | null => {
      if (value === null || value === undefined || value === '') return null;
      return String(value);
    };
    const ownerRaw = normalizeNullable(raw.owner_organization ?? raw.owner_external_id ?? raw.owner_organization_id);
    const mirrorOf = normalizeNullable(raw.mirror_of ?? raw.mirror_of_external_id);
    const mirrorRoot = normalizeNullable(raw.mirror_root ?? raw.mirror_root_external_id ?? mirrorOf);
    const eventKind = String(raw.event_kind ?? '').toLowerCase();
    const rawCatalogState = String(raw.catalog_state ?? '').toLowerCase();
    const catalogState = eventKind === 'delete' || rawCatalogState === 'deleted' ? 'deleted' : 'present';
    return {
      externalId,
      code,
      ownerOrganization: ownerRaw,
      isManuallyManaged: Boolean(raw.is_manually_managed ?? false),
      mirrorOf,
      mirrorRoot,
      quotaBytes: raw.quota_bytes === null || raw.quota_bytes === undefined ? null : String(raw.quota_bytes),
      schemaVersion: Number(raw.schema_version ?? 1),
      catalogState,
    };
  }

  function sendJobError(reply: FastifyReply, err: unknown, requestId: string) {
    if (err instanceof db.IdempotencyConflictError) {
      return reply.code(409).send({ code: 'idempotency_conflict', message: err.message, retryable: false, request_id: requestId });
    }
    if (err instanceof db.CatalogCodeConflictError) {
      return reply.code(409).send({ code: 'catalog_code_conflict', message: err.message, retryable: false, request_id: requestId });
    }
    if (err instanceof db.OrphanHistoryConflictError) {
      return reply.code(409).send({ code: 'orphan_history_conflict', message: err.message, retryable: false, request_id: requestId });
    }
    return reply.code(502).send({ code: 'rust_error', message: (err as Error).message, retryable: true, request_id: requestId });
  }

  function rejectTerminalEnsureJob(reply: FastifyReply, job: { id: string; state: string }, requestId: string): boolean {
    if (!['completed', 'failed', 'cancelled'].includes(job.state)) return false;
    reply.code(409).send({
      code: 'ensure_ready_job_terminal',
      message: `Previous ensure-ready job ${job.id} is ${job.state}; retry with a new Idempotency-Key`,
      retryable: true,
      request_id: requestId,
    });
    return true;
  }

  // ======================================================================
  // OPENAPI SPEC
  // ======================================================================
  app.get('/api/v1/openapi.json', async (_req, reply) => {
    reply.type('application/json').send(openapiSpec);
  });
  app.get('/api/v1/openapi.yaml', async (_req, reply) => {
    reply.type('application/yaml').send(openapiSpecYaml);
  });

  // ======================================================================
  // SYSTEM
  // ======================================================================
  app.get('/api/v1/system/health', { schema: { response: { 200: HealthResponse, 503: HealthResponse } } }, async (_req, reply) => {
    let dbOk = false;
    let rustOk = false;
    try {
      await ctx.pool.query('SELECT 1');
      dbOk = true;
    } catch { /* db down */ }
    rustOk = await ctx.rust.health();
    const status = dbOk && rustOk ? 'ok' : 'degraded';
    reply.code(dbOk && rustOk ? 200 : 503).send({
      status, version: '0.1.0', database: dbOk, rust_data_plane: rustOk,
    });
  });

  // ======================================================================
  // AUTH
  // ======================================================================
  app.post('/api/v1/auth/login', { schema: { body: LoginRequest, response: { 200: LoginResponse, default: ErrorResponse } } }, async (req, reply) => {
    const { username, password } = req.body as { username: string; password: string };
    const user = await verifyDashboardCredentials(ctx.pool, username, password);
    if (!user) {
      await db.insertAuditEvent(ctx.pool, {
        actor: username || 'unknown', actorRole: null, action: 'auth.denied',
        metadata: { reason: 'invalid_credentials' }, requestId: getRequestId(req),
      }).catch(() => {});
      return reply.code(401).send({ code: 'invalid_credentials', message: 'Invalid username or password', retryable: false, request_id: getRequestId(req) });
    }
    const { signOperatorToken } = await import('./auth.js');
    const token = await signOperatorToken(
      ctx.env.dashboardJwtSecret,
      user.username,
      user.role,
      3600,
      ctx.env.dashboardJwtAudience,
      user.authVersion,
    );
    await db.insertAuditEvent(ctx.pool, {
      actor: user.username, actorRole: user.role, action: 'auth.login',
      metadata: { method: 'local_admin' }, requestId: getRequestId(req),
    });
    reply.send({ token, expires_in: 3600, role: user.role, token_type: 'Bearer' });
  });

  app.post('/api/v1/auth/service-token', { schema: { body: ServiceTokenRequest, response: { 200: ServiceTokenResponse, default: ErrorResponse } } }, async (req, reply) => {
    if (!requireScopes(req, reply, 'admin')) return;
    const key = getIdempotencyKey(req, reply);
    if (!key) return;
    const body = (req.body ?? {}) as { subject?: string; scopes?: string[]; ttl_seconds?: number };
    const allowedServiceScopes = new Set(['read', 'mutate', 'downloads:issue']);
    const canonicalScopes = body.scopes?.length ? body.scopes : ['read', 'mutate', 'downloads:issue'];
    const unknownScopes = canonicalScopes.filter((s) => !allowedServiceScopes.has(s));
    if (unknownScopes.length > 0) {
      return reply.code(400).send({ code: 'invalid_scope', message: `Unsupported service scopes: ${unknownScopes.join(', ')}`, retryable: false, request_id: getRequestId(req) });
    }
    const ttl = Math.min(Math.max(body.ttl_seconds ?? 86400, 60), 2592000);
    const { signServiceToken } = await import('./auth.js');
    const token = await signServiceToken(
      ctx.env.clueojServiceSecret,
      body.subject ?? 'clueoj-service',
      ctx.env.clueojServiceAudience,
      canonicalScopes,
      ttl,
    );
    await audit(ctx, req, 'auth.service_token_issued', { metadata: { subject: body.subject ?? 'clueoj-service', scopes: canonicalScopes, ttl_seconds: ttl } });
    reply.send({ token, expires_in: ttl, token_type: 'Bearer', audience: ctx.env.clueojServiceAudience, scopes: canonicalScopes });
  });

  // ======================================================================
  // STORAGE / VOLUMES
  // ======================================================================
  app.get('/api/v1/storage/volumes', { schema: { response: { 200: Paginated(Volume), default: ErrorResponse } } }, async (req, reply) => {
    if (!requireScopes(req, reply, 'read')) return;
    try {
      const vol = await ctx.rust.getVolumes();
      const volName = 'problem-root';
      const mountPath = ctx.env.problemRootContainer || '/problems';
      await db.upsertVolume(ctx.pool, volName, mountPath, vol.total_bytes, vol.free_bytes, vol.available_bytes);
      reply.send({ items: [{ name: volName, mount_path: mountPath, ...vol }], next_cursor: null, has_more: false });
    } catch (err) {
      const v = await db.getVolume(ctx.pool);
      if (v) reply.send({ items: [v], next_cursor: null, has_more: false });
      else reply.code(503).send({ code: 'rust_unavailable', message: 'Rust data plane unavailable and no cached volume data', retryable: true, request_id: getRequestId(req) });
    }
  });

  // ======================================================================
  // CATALOG / RECONCILE
  // ======================================================================
  app.post('/api/v1/catalog/problems:reconcile', { schema: { body: ReconcileRequest } }, async (req, reply) => {
    if (!requireScopes(req, reply, 'mutate')) return;
    const body = req.body as { problems: Array<Record<string, unknown>> };
    if (!body?.problems || !Array.isArray(body.problems)) {
      return reply.code(400).send({ code: 'bad_request', message: 'problems array required', retryable: false, request_id: getRequestId(req) });
    }
    try {
      for (const p of body.problems) {
        const catalog = catalogProblemFrom(p);
        await db.upsertProblem(
          ctx.pool,
          catalog.externalId,
          catalog.code,
          catalog.ownerOrganization,
          catalog.isManuallyManaged,
          catalog.mirrorOf,
          catalog.mirrorRoot,
          catalog.quotaBytes,
          catalog.schemaVersion,
        );
      }
      const catalogProblems = body.problems.map((p) => catalogProblemFrom(p));
      const missing = await db.markMissingOutsideCatalog(ctx.pool, catalogProblems.map((p) => p.externalId));
      const problemsTuple = catalogProblems.map((p) => [p.externalId, p.code] as [string, string]);
      const result = await ctx.rust.reconcile(problemsTuple);
      await db.clearDirtyForMissingLocal(ctx.pool);
      for (const catalog of catalogProblems) {
        if (catalog.catalogState !== 'present') continue;
        const usage = await db.getProblemUsage(ctx.pool, catalog.externalId);
        if (!usage || usage.local_status !== 'present') continue;
        const problem = await db.getProblem(ctx.pool, catalog.externalId);
        if (!problem) continue;
        const dirty = problem.dirty
          ? problem
          : await db.markDirtyIfNoReady(ctx.pool, problem.external_id) ?? problem;
        await db.scheduleAutoSnapshotJobs(ctx.pool, dirty, 'catalog-reconcile');
      }
      const normalized = {
        discovered: result.discovered ?? 0,
        present: body.problems.length,
        missing: result.missing ?? missing,
        orphan: result.orphans ?? 0,
        mirror: result.mirrors ?? 0,
      };
      await audit(ctx, req, 'catalog.reconcile', { metadata: { ...normalized, count: body.problems.length } });
      reply.send(normalized);
    } catch (err) {
      reply.code(502).send({ code: 'rust_error', message: (err as Error).message, retryable: true, request_id: getRequestId(req) });
    }
  });

  app.post('/api/v1/catalog/snapshots:schedule', async (req, reply) => {
    if (!requireScopes(req, reply, 'mutate')) return;
    const key = getIdempotencyKey(req, reply);
    if (!key) return;
    const q = (req.body ?? {}) as { limit?: number };
    const scheduled = await db.scheduleDirtySnapshotBatch(ctx.pool, getAuth(req).sub, Math.min(Math.max(q.limit ?? 100, 1), 500));
    await audit(ctx, req, 'catalog.snapshots_schedule', { metadata: { scheduled: scheduled.length } });
    reply.send({ items: scheduled, count: scheduled.length });
  });

  // ======================================================================
  // SYNC / CHANGES
  // ======================================================================
  app.get('/api/v1/sync/changes', { schema: { response: { 200: SyncChangesResponse, default: ErrorResponse } } }, async (req, reply) => {
    if (!requireScopes(req, reply, 'read')) return;
    const cursor = (req.query as { cursor?: string }).cursor;
    const limit = parseLimit((req.query as { limit?: string }).limit, 100, 500);
    const result = await db.getSyncChanges(ctx.pool, { cursor, limit });
    reply.send(result);
  });

  // ======================================================================
  // PROBLEMS
  // ======================================================================
  app.get('/api/v1/problems', { schema: { response: { 200: Paginated(Problem), default: ErrorResponse } } }, async (req, reply) => {
    if (!requireScopes(req, reply, 'read')) return;
    const q = req.query as Record<string, string | undefined>;
    const result = await db.listProblems(ctx.pool, {
      search: q.search, ownerOrg: q.owner_organization, catalogState: q.catalog_state,
      sort: q.sort, order: q.order as 'asc' | 'desc' | undefined,
      cursor: q.cursor, limit: parseLimit(q.limit, 50, 200),
    });
    reply.send(result);
  });

  app.get('/api/v1/problems/:externalId', { schema: { response: { 200: Problem, default: ErrorResponse } } }, async (req, reply) => {
    if (!requireScopes(req, reply, 'read')) return;
    const { externalId } = req.params as { externalId: string };
    const problem = await db.getProblem(ctx.pool, externalId);
    if (!problem) return reply.code(404).send({ code: 'not_found', message: 'Problem not found', retryable: false, request_id: getRequestId(req) });
    reply.send(problem);
  });

  app.get('/api/v1/problems/:externalId/usage', { schema: { response: { 200: ProblemUsage, default: ErrorResponse } } }, async (req, reply) => {
    if (!requireScopes(req, reply, 'read')) return;
    const { externalId } = req.params as { externalId: string };
    const usage = await db.getProblemUsage(ctx.pool, externalId);
    if (!usage) return reply.code(404).send({ code: 'not_found', message: 'Usage not found', retryable: false, request_id: getRequestId(req) });
    reply.send(usage);
  });

  // Mutation actions on problems
  app.post('/api/v1/problems/:externalId/dirty', { schema: { body: DirtyProblemRequest, response: { 200: Problem, default: ErrorResponse } } }, async (req, reply) => {
    if (!requireScopes(req, reply, 'mutate')) return;
    const key = getIdempotencyKey(req, reply);
    if (!key) return;
    const { externalId } = req.params as { externalId: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const catalog = catalogProblemFrom(body, externalId);
    if (catalog.externalId !== externalId) {
      return reply.code(400).send({ code: 'bad_request', message: 'Path externalId must match body external_id/problem_pk', retryable: false, request_id: getRequestId(req) });
    }
    try {
      const result = await db.markProblemDirtyIdempotent(ctx.pool, key, getAuth(req).sub, catalog);
      const jobs = result.problem.dirty
        ? await db.scheduleAutoSnapshotJobs(ctx.pool, result.problem, getAuth(req).sub)
        : null;
      await audit(ctx, req, result.problem.catalog_state === 'deleted' ? 'problem.deleted' : 'problem.dirty', {
        problemId: externalId,
        metadata: { idempotency_key: key, mutated: result.mutated, scheduled_jobs: jobs },
      });
      reply.send(result.problem);
    } catch (err) {
      return sendJobError(reply, err, getRequestId(req));
    }
  });

  app.post('/api/v1/problems/:externalId/ensure-ready', { schema: { response: { 200: EnsureReadyResponse, 202: EnsureReadyResponse, default: ErrorResponse } } }, async (req, reply) => {
    if (!requireScopes(req, reply, 'mutate')) return;
    const key = getIdempotencyKey(req, reply);
    if (!key) return;
    const { externalId } = req.params as { externalId: string };
    const problem = await db.getProblem(ctx.pool, externalId);
    if (!problem) return reply.code(404).send({ code: 'not_found', message: 'Problem not found', retryable: false, request_id: getRequestId(req) });
    let actual;
    try {
      actual = await ctx.rust.ready(externalId, problem.code);
    } catch (err) {
      return reply.code(502).send({ code: 'ready_check_failed', message: (err as Error).message, retryable: true, request_id: getRequestId(req) });
    }
    if (actual.ready && actual.local_status === 'present' && !problem.dirty) {
      return reply.send({ status: 'ready', ready: true });
    }
    if (actual.local_status === 'present' && problem.dirty) {
      const generation = problem.dirty_generation ?? await db.allocateGeneration(ctx.pool, externalId);
      const job = await db.createJob(ctx.pool, {
        idempotencyKey: key,
        jobType: 'snapshot',
        problemId: externalId,
        targetGeneration: generation,
        leaseOwner: getAuth(req).sub,
        requestFingerprint: db.stableFingerprint({ action: 'ensure-ready-snapshot', external_id: externalId, generation, dirty_version: problem.dirty_version }),
      });
      if (rejectTerminalEnsureJob(reply, job, getRequestId(req))) return;
      await db.setJobPayload(ctx.pool, job.id, { dirty_version: problem.dirty_version });
      await audit(ctx, req, 'problem.ensure_ready_snapshot', { problemId: externalId, generation, jobId: job.id });
      return reply.code(202).send({ status: 'snapshotting', ready: false, ...accepted(job) });
    }
    if (actual.local_status !== 'missing') {
      return reply.code(409).send({
        code: 'local_integrity_mismatch',
        message: 'Local problem data does not match a verified READY snapshot; refusing destructive restore',
        retryable: true,
        request_id: getRequestId(req),
      });
    }
    const snapshot = await db.getLatestReadySnapshot(ctx.pool, externalId);
    if (!snapshot) {
      return reply.code(409).send({ code: 'not_ready', message: 'No local folder and no READY snapshot available', retryable: true, request_id: getRequestId(req) });
    }
    const job = await db.createJob(ctx.pool, {
      idempotencyKey: key,
      jobType: 'restore',
      problemId: externalId,
      targetGeneration: snapshot.generation,
      leaseOwner: getAuth(req).sub,
      requestFingerprint: db.stableFingerprint({ action: 'ensure-ready-restore', external_id: externalId, generation: snapshot.generation }),
    });
    if (rejectTerminalEnsureJob(reply, job, getRequestId(req))) return;
    await audit(ctx, req, 'problem.ensure_ready', { problemId: externalId, generation: snapshot.generation, jobId: job.id });
    reply.code(202).send({ status: 'restoring', ready: false, ...accepted(job) });
  });

  app.post('/api/v1/problems/:externalId/scan', { schema: { response: { 202: AcceptedJobResponse, default: ErrorResponse } } }, async (req, reply) => {
    if (!requireScopes(req, reply, 'mutate')) return;
    const { externalId } = req.params as { externalId: string };
    const problem = await db.getProblem(ctx.pool, externalId);
    if (!problem) return reply.code(404).send({ code: 'not_found', message: 'Problem not found', retryable: false, request_id: getRequestId(req) });
    try {
      const idempotencyKey = getIdempotencyKey(req, reply);
      if (!idempotencyKey) return;
      const job = await db.createJob(ctx.pool, {
        idempotencyKey, jobType: 'scan', problemId: externalId, targetGeneration: null, leaseOwner: getAuth(req).sub,
        requestFingerprint: db.stableFingerprint({ action: 'scan', external_id: externalId }),
      });
      await audit(ctx, req, 'problem.scan', { problemId: externalId, jobId: job.id });
      reply.code(202).send(accepted(job));
    } catch (err) {
      sendJobError(reply, err, getRequestId(req));
    }
  });

  app.post('/api/v1/problems/:externalId/snapshot', { schema: { response: { 202: AcceptedJobResponse, default: ErrorResponse } } }, async (req, reply) => {
    if (!requireScopes(req, reply, 'mutate')) return;
    const { externalId } = req.params as { externalId: string };
    const body = (req.body as { generation?: number }) || {};
    const problem = await db.getProblem(ctx.pool, externalId);
    if (!problem) return reply.code(404).send({ code: 'not_found', message: 'Problem not found', retryable: false, request_id: getRequestId(req) });
    try {
      const idempotencyKey = getIdempotencyKey(req, reply);
      if (!idempotencyKey) return;
      const generation = body.generation ?? problem.dirty_generation ?? await db.allocateGeneration(ctx.pool, externalId);
      const job = await db.createJob(ctx.pool, {
        idempotencyKey, jobType: 'snapshot', problemId: externalId, targetGeneration: generation, leaseOwner: getAuth(req).sub,
        requestFingerprint: db.stableFingerprint({ action: 'snapshot', external_id: externalId, generation, dirty_version: problem.dirty_version }),
      });
      await db.setJobPayload(ctx.pool, job.id, { dirty_version: problem.dirty_version });
      await audit(ctx, req, 'problem.snapshot', { problemId: externalId, generation, jobId: job.id });
      reply.code(202).send(accepted(job));
    } catch (err) {
      sendJobError(reply, err, getRequestId(req));
    }
  });

  app.post('/api/v1/problems/:externalId/restore', { schema: { response: { 200: RestoreDryRunResponse, 202: AcceptedJobResponse, default: ErrorResponse } } }, async (req, reply) => {
    if (!requireScopes(req, reply, 'mutate')) return;
    const { externalId } = req.params as { externalId: string };
    const body = (req.body as { generation?: number; dry_run?: boolean }) || {};
    const problem = await db.getProblem(ctx.pool, externalId);
    if (!problem) return reply.code(404).send({ code: 'not_found', message: 'Problem not found', retryable: false, request_id: getRequestId(req) });
    if (body.dry_run) {
      await audit(ctx, req, 'problem.restore', { problemId: externalId, generation: body.generation ?? null, metadata: { dry_run: true } });
      return reply.send({ dry_run: true, message: 'Restore would download objects and rebuild folder' });
    }
    try {
      const idempotencyKey = getIdempotencyKey(req, reply);
      if (!idempotencyKey) return;
      const job = await db.createJob(ctx.pool, {
        idempotencyKey, jobType: 'restore', problemId: externalId, targetGeneration: body.generation ?? null, leaseOwner: getAuth(req).sub,
        requestFingerprint: db.stableFingerprint({ action: 'restore', external_id: externalId, generation: body.generation ?? null }),
      });
      await audit(ctx, req, 'problem.restore', { problemId: externalId, generation: body.generation ?? null, jobId: job.id });
      reply.code(202).send(accepted(job));
    } catch (err) {
      sendJobError(reply, err, getRequestId(req));
    }
  });

  app.post('/api/v1/problems/:externalId/evict', { schema: { response: { 202: AcceptedJobResponse, default: ErrorResponse } } }, async (req, reply) => {
    if (!requireScopes(req, reply, 'mutate')) return;
    const { externalId } = req.params as { externalId: string };
    const body = (req.body as { dry_run?: boolean; force?: boolean }) || {};
    const problem = await db.getProblem(ctx.pool, externalId);
    if (!problem) return reply.code(404).send({ code: 'not_found', message: 'Problem not found', retryable: false, request_id: getRequestId(req) });
    try {
      const idempotencyKey = getIdempotencyKey(req, reply);
      if (!idempotencyKey) return;
      const job = await db.createJob(ctx.pool, {
        idempotencyKey, jobType: 'evict', problemId: externalId, targetGeneration: null, leaseOwner: getAuth(req).sub,
        requestFingerprint: db.stableFingerprint({ action: 'evict', external_id: externalId, dry_run: body.dry_run ?? true, force: body.force ?? false }),
      });
      await db.setJobPayload(ctx.pool, job.id, { dry_run: body.dry_run ?? true, force: body.force ?? false });
      await audit(ctx, req, 'problem.evict', { problemId: externalId, jobId: job.id, metadata: { dry_run: body.dry_run ?? true } });
      reply.code(202).send(accepted(job));
    } catch (err) {
      sendJobError(reply, err, getRequestId(req));
    }
  });

  // ======================================================================
  // ORGANIZATIONS
  // ======================================================================
  app.get('/api/v1/organizations', { schema: { response: { 200: Paginated(OrganizationUsage), default: ErrorResponse } } }, async (req, reply) => {
    if (!requireScopes(req, reply, 'read')) return;
    const q = req.query as Record<string, string | undefined>;
    const result = await db.listOrganizationUsage(ctx.pool, { cursor: q.cursor, limit: parseLimit(q.limit, 50, 200) });
    reply.send(result);
  });

  app.get('/api/v1/organizations/:externalId/usage', { schema: { response: { 200: OrganizationUsage, default: ErrorResponse } } }, async (req, reply) => {
    if (!requireScopes(req, reply, 'read')) return;
    const { externalId } = req.params as { externalId: string };
    const usage = await db.getOrganizationUsage(ctx.pool, externalId);
    if (!usage) return reply.code(404).send({ code: 'not_found', message: 'Organization not found', retryable: false, request_id: getRequestId(req) });
    reply.send(usage);
  });

  app.put('/api/v1/organizations/:externalId/settings', async (req, reply) => {
    if (!requireScopes(req, reply, 'admin')) return;
    const key = getIdempotencyKey(req, reply);
    if (!key) return;
    const { externalId } = req.params as { externalId: string };
    const body = (req.body ?? {}) as { storage_quota_bytes?: number | string | null; problem_count_quota?: number | null };
    const result = await db.upsertOrganizationSettings(
      ctx.pool,
      externalId,
      body.storage_quota_bytes ?? null,
      body.problem_count_quota ?? null,
    );
    await audit(ctx, req, 'organization.settings.update', { targetType: 'organization', targetId: externalId, metadata: result });
    reply.send(result);
  });

  // ======================================================================
  // DASHBOARD READ MODELS
  // ======================================================================
  app.get('/api/v1/dashboard/summary', async (req, reply) => {
    if (!requireScopes(req, reply, 'read')) return;
    reply.send(await db.getDashboardSummary(ctx.pool));
  });

  app.get('/api/v1/dashboard/status-distribution', async (req, reply) => {
    if (!requireScopes(req, reply, 'read')) return;
    reply.send(await db.getStatusDistributions(ctx.pool));
  });

  app.get('/api/v1/dashboard/largest-problems', async (req, reply) => {
    if (!requireScopes(req, reply, 'read')) return;
    const q = req.query as { limit?: string };
    reply.send({ items: await db.listLargestProblems(ctx.pool, parseLimit(q.limit, 20, 100)), next_cursor: null, has_more: false });
  });

  app.get('/api/v1/dashboard/largest-organizations', async (req, reply) => {
    if (!requireScopes(req, reply, 'read')) return;
    const q = req.query as { limit?: string };
    reply.send({ items: await db.listLargestOrganizations(ctx.pool, parseLimit(q.limit, 20, 100)), next_cursor: null, has_more: false });
  });

  app.get('/api/v1/dashboard/volume-timeseries', async (req, reply) => {
    if (!requireScopes(req, reply, 'read')) return;
    const q = req.query as { name?: string; limit?: string };
    reply.send({ items: await db.listVolumeTimeseries(ctx.pool, { name: q.name, limit: parseLimit(q.limit, 100, 1000) }), next_cursor: null, has_more: false });
  });

  // ======================================================================
  // SNAPSHOTS
  // ======================================================================
  app.get('/api/v1/snapshots', { schema: { response: { 200: Paginated(Snapshot), default: ErrorResponse } } }, async (req, reply) => {
    if (!requireScopes(req, reply, 'read')) return;
    const q = req.query as Record<string, string | undefined>;
    const result = await db.listSnapshots(ctx.pool, q.problem_id ?? null, { cursor: q.cursor, limit: parseLimit(q.limit, 50, 200) });
    reply.send(result);
  });

  app.get('/api/v1/snapshots/:id', { schema: { response: { 200: Snapshot, default: ErrorResponse } } }, async (req, reply) => {
    if (!requireScopes(req, reply, 'read')) return;
    const { id } = req.params as { id: string };
    const snap = await db.getSnapshot(ctx.pool, id);
    if (!snap) return reply.code(404).send({ code: 'not_found', message: 'Snapshot not found', retryable: false, request_id: getRequestId(req) });
    reply.send(snap);
  });

  // ======================================================================
  // JOBS
  // ======================================================================
  app.get('/api/v1/jobs', { schema: { response: { 200: Paginated(Job), default: ErrorResponse } } }, async (req, reply) => {
    if (!requireScopes(req, reply, 'read')) return;
    const q = req.query as Record<string, string | undefined>;
    const result = await db.listJobs(ctx.pool, {
      state: q.state, problemId: q.problem_id, cursor: q.cursor, limit: parseLimit(q.limit, 50, 200),
    });
    reply.send(result);
  });

  app.get('/api/v1/jobs/:id', { schema: { response: { 200: Job, default: ErrorResponse } } }, async (req, reply) => {
    if (!requireScopes(req, reply, 'read')) return;
    const { id } = req.params as { id: string };
    const job = await db.getJob(ctx.pool, id);
    if (!job) return reply.code(404).send({ code: 'not_found', message: 'Job not found', retryable: false, request_id: getRequestId(req) });
    reply.send(job);
  });

  app.get('/api/v1/jobs/:id/events', async (req, reply) => {
    if (!requireScopes(req, reply, 'read')) return;
    const { id } = req.params as { id: string };
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    const send = (event: string, data: unknown, id?: string) => {
      if (id) reply.raw.write(`id: ${id}\n`);
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    let interval: NodeJS.Timeout;
    let heartbeat: NodeJS.Timeout;
    let closed = false;
    const tick = async () => {
      const job = await db.getJob(ctx.pool, id).catch(() => null);
      if (!job) {
        send('error', { code: 'not_found' });
        clearInterval(interval);
        clearInterval(heartbeat);
        closed = true;
        reply.raw.end();
        return;
      }
      send('job', job, job.updated_at);
      if (['completed', 'failed', 'cancelled'].includes(job.state)) {
        clearInterval(interval);
        clearInterval(heartbeat);
        closed = true;
        reply.raw.end();
      }
    };
    await tick();
    if (closed) return;
    interval = setInterval(() => void tick(), 1000);
    heartbeat = setInterval(() => send('heartbeat', { now: new Date().toISOString() }), 15000);
    req.raw.on('close', () => {
      clearInterval(interval);
      clearInterval(heartbeat);
    });
  });

  app.post('/api/v1/jobs/:id/retry', async (req, reply) => {
    if (!requireScopes(req, reply, 'mutate')) return;
    const { id } = req.params as { id: string };
    const job = await db.retryJob(ctx.pool, id);
    if (!job) return reply.code(409).send({ code: 'not_retryable', message: 'Job cannot be retried (max attempts reached or not in failed/cancelled state)', retryable: false, request_id: getRequestId(req) });
    await audit(ctx, req, 'job.retry', { jobId: id, metadata: { attempt: job.attempt } });
    reply.send(job);
  });

  app.post('/api/v1/jobs/:id/cancel', async (req, reply) => {
    if (!requireScopes(req, reply, 'mutate')) return;
    const { id } = req.params as { id: string };
    const body = (req.body as { reason?: string }) || {};
    const job = await db.cancelJob(ctx.pool, id, body.reason ?? null);
    if (!job) return reply.code(409).send({ code: 'not_cancellable', message: 'Job is not in a cancellable state', retryable: false, request_id: getRequestId(req) });
    await audit(ctx, req, 'job.cancel', { jobId: id, metadata: { reason: body.reason } });
    reply.send(job);
  });

  // ======================================================================
  // ORPHANS
  // ======================================================================
  app.get('/api/v1/orphans', { schema: { response: { 200: Paginated(Orphan), default: ErrorResponse } } }, async (req, reply) => {
    if (!requireScopes(req, reply, 'read')) return;
    const q = req.query as Record<string, string | undefined>;
    const result = await db.listOrphans(ctx.pool, { cursor: q.cursor, limit: parseLimit(q.limit, 50, 200) });
    reply.send(result);
  });

  // ======================================================================
  // AUDIT EVENTS
  // ======================================================================
  app.get('/api/v1/audit-events', { schema: { response: { 200: Paginated(AuditEvent), default: ErrorResponse } } }, async (req, reply) => {
    if (!requireScopes(req, reply, 'read', 'audit')) return;
    const q = req.query as Record<string, string | undefined>;
    const result = await db.listAuditEvents(ctx.pool, {
      actor: q.actor, action: q.action, problemId: q.problem_id,
      cursor: q.cursor, limit: parseLimit(q.limit, 50, 200),
    });
    reply.send(result);
  });

  // ======================================================================
  // DOWNLOADS (direct R2 presign - NO byte proxying)
  // ======================================================================
  app.post('/api/v1/downloads', { schema: { body: DownloadRequest, response: { 200: DownloadResponse, default: ErrorResponse } } }, async (req, reply) => {
    if (!requireScopes(req, reply, 'downloads:issue')) return;
    const body = req.body as { problem_external_id: string; ttl_seconds?: number };
    if (!body?.problem_external_id) {
      return reply.code(400).send({ code: 'bad_request', message: 'problem_external_id required', retryable: false, request_id: getRequestId(req) });
    }
    const ttl = Math.min(body.ttl_seconds ?? ctx.env.presignTtlSeconds, 300);
    try {
      const result = await ctx.rust.presign(body.problem_external_id, ttl);
      await audit(ctx, req, 'download.url_issued', {
        problemId: body.problem_external_id,
        metadata: { ttl_seconds: ttl, expires_at: result.expires_at },
      });
      reply.send({ method: 'GET', ...result });
    } catch (err) {
      await audit(ctx, req, 'download.url_failed', {
        problemId: body.problem_external_id,
        metadata: { error: (err as Error).message },
      }).catch(() => {});
      reply.code(502).send({ code: 'presign_failed', message: (err as Error).message, retryable: true, request_id: getRequestId(req) });
    }
  });

  // ======================================================================
  // PHASE 6: Backfill, Incident commands, Retention, GC
  // ======================================================================

  // GET /api/v1/backfill - list backfill state
  app.get('/api/v1/backfill', async (req, reply) => {
    if (!requireScopes(req, reply, 'read')) return;
    const result = await ctx.pool.query(
      'SELECT * FROM backfill_state ORDER BY id',
    );
    reply.send(result.rows);
  });

  // POST /api/v1/backfill/:capability/start - start or resume backfill
  app.post('/api/v1/backfill/:capability/start', { schema: { response: { 202: AcceptedJobResponse, default: ErrorResponse } } }, async (req, reply) => {
    if (!requireScopes(req, reply, 'admin')) return;
    const key = getIdempotencyKey(req, reply);
    if (!key) return;
    const capability = (req.params as { capability: string }).capability;
    const valid = ['accounting', 'atomic_writes', 'r2_snapshot', 'direct_download', 'ensure_ready', 'eviction'];
    if (!valid.includes(capability)) {
      return reply.code(400).send({ code: 'bad_request', message: `Invalid capability: ${capability}`, retryable: false, request_id: getRequestId(req) });
    }
    const result = await ctx.pool.query(
      `INSERT INTO backfill_state (capability, status, started_at)
       VALUES ($1, 'running', now())
       ON CONFLICT (capability) DO UPDATE
       SET status = 'running', started_at = COALESCE(backfill_state.started_at, now())
       WHERE backfill_state.status IN ('pending', 'paused', 'completed', 'failed')
       RETURNING *`,
      [capability],
    );
    if (result.rows.length === 0) {
      return reply.code(409).send({ code: 'already_running', message: 'Backfill is already running', retryable: false, request_id: getRequestId(req) });
    }
    const job = await db.createJob(ctx.pool, {
      idempotencyKey: key,
      jobType: 'backfill',
      problemId: null,
      targetGeneration: null,
      leaseOwner: getAuth(req).sub,
      requestFingerprint: db.stableFingerprint({ action: 'backfill', capability }),
    });
    await db.setJobPayload(ctx.pool, job.id, { capability, limit: 25 });
    await audit(ctx, req, 'backfill.start', { metadata: { capability } });
    reply.code(202).send(accepted(job));
  });

  // POST /api/v1/backfill/:capability/pause
  app.post('/api/v1/backfill/:capability/pause', async (req, reply) => {
    if (!requireScopes(req, reply, 'admin')) return;
    const key = getIdempotencyKey(req, reply);
    if (!key) return;
    const capability = (req.params as { capability: string }).capability;
    const result = await ctx.pool.query(
      `UPDATE backfill_state SET status = 'paused' WHERE capability = $1`,
      [capability],
    );
    if ((result.rowCount ?? 0) === 0) {
      return reply.code(404).send({ code: 'not_found', message: 'Backfill not found', retryable: false, request_id: getRequestId(req) });
    }
    await audit(ctx, req, 'backfill.pause', { metadata: { capability } });
    reply.send({ status: 'paused', capability });
  });

  // GET /api/v1/backfill/:capability/progress
  app.get('/api/v1/backfill/:capability/progress', async (req, reply) => {
    if (!requireScopes(req, reply, 'read')) return;
    const capability = (req.params as { capability: string }).capability;
    const result = await ctx.pool.query(
      'SELECT * FROM backfill_state WHERE capability = $1',
      [capability],
    );
    if (result.rows.length === 0) {
      return reply.code(404).send({ code: 'not_found', message: 'Backfill not found', retryable: false, request_id: getRequestId(req) });
    }
    reply.send(result.rows[0]);
  });

  // GET /api/v1/incident-commands - list incident command history
  app.get('/api/v1/incident-commands', async (req, reply) => {
    if (!requireScopes(req, reply, 'admin')) return;
    const q = req.query as { command?: string; limit?: string; cursor?: string };
    const limit = parseLimit(q.limit, 50, 200);
    const cursor = q.cursor;
    const params: unknown[] = [limit];
    let where = '';
    if (q.command) {
      where = 'WHERE command = $' + (params.length + 1);
      params.push(q.command);
    }
    if (cursor) {
      where += (where ? ' AND' : 'WHERE') + ` created_at < $${params.length + 1}`;
      params.push(cursor);
    }
    const result = await ctx.pool.query(
      `SELECT * FROM incident_commands ${where} ORDER BY created_at DESC LIMIT $1`,
      params,
    );
    const hasMore = result.rows.length === limit;
    const nextCursor = hasMore ? result.rows[result.rows.length - 1]?.created_at?.toISOString() : null;
    reply.send({ items: result.rows, next_cursor: nextCursor, has_more: hasMore });
  });

  // POST /api/v1/incident-commands - execute incident command (all support dry_run)
  app.post('/api/v1/incident-commands', async (req, reply) => {
    if (!requireScopes(req, reply, 'admin')) return;
    const key = getIdempotencyKey(req, reply);
    if (!key) return;
    const body = req.body as { command: string; args?: Record<string, unknown>; dry_run?: boolean };
    const validCommands = [
      'list_stuck_jobs', 'pause_queue', 'resume_queue', 'pin_generation',
      'verify_generation', 'restore_problem', 'force_reconcile',
      'rotate_credentials', 'export_audit', 'gc_collect',
    ];
    if (!validCommands.includes(body.command)) {
      return reply.code(400).send({ code: 'bad_request', message: `Invalid command: ${body.command}`, retryable: false, request_id: getRequestId(req) });
    }
    const dryRun = body.dry_run ?? false;
    let resultData: Record<string, unknown> = { dry_run: dryRun };

    if (!dryRun) {
      switch (body.command) {
        case 'list_stuck_jobs': {
          const r = await ctx.pool.query(
            `SELECT * FROM jobs WHERE state = 'running' AND lease_expires_at < now() ORDER BY updated_at DESC`,
          );
          resultData = { stuck_jobs: r.rows };
          break;
        }
        case 'pause_queue': {
          await ctx.pool.query(`UPDATE queue_state SET paused = true, reason = $1, updated_at = now() WHERE name = 'default'`, [String(body.args?.reason ?? 'incident command')]);
          resultData = { action: 'paused' };
          break;
        }
        case 'resume_queue': {
          await ctx.pool.query(`UPDATE queue_state SET paused = false, reason = NULL, updated_at = now() WHERE name = 'default'`);
          resultData = { action: 'resumed' };
          break;
        }
        case 'gc_collect': {
          const job = await db.createJob(ctx.pool, {
            idempotencyKey: key,
            jobType: 'gc_collect',
            problemId: null,
            targetGeneration: null,
            leaseOwner: getAuth(req).sub,
            requestFingerprint: db.stableFingerprint({ action: 'gc_collect', limit: Number(body.args?.limit ?? 100) }),
          });
          await db.setJobPayload(ctx.pool, job.id, { limit: Number(body.args?.limit ?? 100) });
          resultData = accepted(job);
          break;
        }
        default: {
          return reply.code(501).send({
            code: 'not_implemented',
            message: `Incident command ${body.command} requires explicit data-plane or infrastructure support and was not executed`,
            retryable: false,
            request_id: getRequestId(req),
          });
        }
      }
    } else {
      if (body.command === 'list_stuck_jobs') {
        const r = await ctx.pool.query(
          `SELECT * FROM jobs WHERE state = 'running' AND lease_expires_at < now() ORDER BY updated_at DESC`,
        );
        resultData = { dry_run: true, stuck_jobs: r.rows };
      }
    }

    await ctx.pool.query(
      `INSERT INTO incident_commands (command, actor, args, dry_run, result)
       VALUES ($1, $2, $3, $4, $5)`,
      [body.command, (req as FastifyRequest & { auth: StorageJWTPayload }).auth.sub,
       JSON.stringify(body.args ?? {}), dryRun, JSON.stringify(resultData)],
    );
    await audit(ctx, req, 'incident.command', { metadata: { command: body.command, dry_run: dryRun } });
    reply.send(resultData);
  });

  // GET /api/v1/retention - list retention config
  app.get('/api/v1/retention', async (req, reply) => {
    if (!requireScopes(req, reply, 'read')) return;
    const result = await ctx.pool.query('SELECT * FROM retention_config ORDER BY id');
    reply.send(result.rows);
  });

  // PUT /api/v1/retention/:entityType - update retention days
  app.put('/api/v1/retention/:entityType', async (req, reply) => {
    if (!requireScopes(req, reply, 'admin')) return;
    const key = getIdempotencyKey(req, reply);
    if (!key) return;
    const entityType = (req.params as { entityType: string }).entityType;
    const body = req.body as { retention_days: number };
    if (!body?.retention_days || body.retention_days < 1) {
      return reply.code(400).send({ code: 'bad_request', message: 'retention_days must be >= 1', retryable: false, request_id: getRequestId(req) });
    }
    const result = await ctx.pool.query(
      `UPDATE retention_config SET retention_days = $1 WHERE entity_type = $2 RETURNING *`,
      [body.retention_days, entityType],
    );
    if (result.rows.length === 0) {
      return reply.code(404).send({ code: 'not_found', message: 'Retention config not found', retryable: false, request_id: getRequestId(req) });
    }
    await audit(ctx, req, 'settings.update', { metadata: { entity_type: entityType, retention_days: body.retention_days } });
    reply.send(result.rows[0]);
  });

  app.post('/api/v1/retention:apply', async (req, reply) => {
    if (!requireScopes(req, reply, 'admin')) return;
    const key = getIdempotencyKey(req, reply);
    if (!key) return;
    const result = await db.applyRetention(ctx.pool);
    await audit(ctx, req, 'retention.apply', { metadata: result });
    reply.send(result);
  });

  // GET /api/v1/gc/eligible - list GC-eligible objects
  app.get('/api/v1/gc/eligible', async (req, reply) => {
    if (!requireScopes(req, reply, 'read')) return;
    const q = req.query as { limit?: string };
    const limit = parseLimit(q.limit, 100, 500);
    const items = await db.listGcEligible(ctx.pool, limit);
    reply.send({ items, next_cursor: null, has_more: false });
  });
}
