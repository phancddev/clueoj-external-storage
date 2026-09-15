import { Pool } from 'pg';
import { logger } from './logger.js';

export interface Env {
  databaseUrl: string;
  rustBaseUrl: string;
  rustInternalToken: string;
  dashboardJwtSecret: string;
  dashboardJwtAudience: string;
  clueojServiceAudience: string;
  clueojServiceSecret: string;
  corsAllowedOrigins: string[];
  trustProxy: boolean;
  workerEnabled: boolean;
  workerConcurrency: number;
  workerLeaseSeconds: number;
  presignTtlSeconds: number;
  port: number;
  logLevel: string;
  dashboardDir: string;
  problemRootContainer: string;
}

export function loadEnv(): Env {
  const required = (key: string): string => {
    const v = process.env[key];
    if (!v) throw new Error(`Missing env ${key}`);
    return v;
  };

  return {
    databaseUrl: required('STORAGE_DATABASE_URL'),
    rustBaseUrl: process.env.STORAGE_RUST_BASE_URL || 'http://storage-rust:8081',
    rustInternalToken: required('STORAGE_RUST_INTERNAL_TOKEN'),
    dashboardJwtSecret: process.env.STORAGE_DASHBOARD_JWT_SECRET || required('STORAGE_JWT_SECRET'),
    dashboardJwtAudience: process.env.STORAGE_DASHBOARD_JWT_AUDIENCE || 'clueoj-storage-dashboard',
    clueojServiceAudience: process.env.STORAGE_CLUEOJ_SERVICE_AUDIENCE || 'clueoj-storage',
    clueojServiceSecret: required('STORAGE_CLUEOJ_SERVICE_SECRET'),
    corsAllowedOrigins: (process.env.STORAGE_CORS_ALLOWED_ORIGINS || 'http://localhost:2907,http://127.0.0.1:2907')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    trustProxy: process.env.STORAGE_TRUST_PROXY === 'true',
    workerEnabled: process.env.STORAGE_WORKER_ENABLED !== 'false',
    workerConcurrency: Math.max(1, parsePositiveInt(process.env.STORAGE_WORKER_CONCURRENCY, 1)),
    workerLeaseSeconds: parsePositiveInt(process.env.STORAGE_WORKER_LEASE_SECONDS, 60),
    presignTtlSeconds: parsePositiveInt(process.env.R2_PRESIGN_TTL_SECONDS, 180),
    port: parsePositiveInt(process.env.STORAGE_PORT, 2907),
    logLevel: process.env.STORAGE_LOG_LEVEL || 'info',
    dashboardDir: process.env.STORAGE_DASHBOARD_DIR || '../dashboard/dist',
    problemRootContainer: process.env.STORAGE_PROBLEM_ROOT_CONTAINER || '/problems',
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createPool(env: Env): Pool {
  const pool = new Pool({
    connectionString: env.databaseUrl,
    max: Math.max(20, parsePositiveInt(process.env.STORAGE_PG_POOL_MAX, 20)),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  // node-postgres emits an `error` event when an idle pooled connection is
  // terminated (for example during a PostgreSQL restart). Without a listener,
  // EventEmitter treats it as uncaught and terminates the control plane.
  // The pool discards that client and reconnects on the next query.
  pool.on('error', (err) => {
    logger.error(
      { error_code: (err as NodeJS.ErrnoException).code, error_name: err.name },
      'PostgreSQL idle client disconnected; connection pool will recover',
    );
  });
  return pool;
}
