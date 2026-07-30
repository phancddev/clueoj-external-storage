import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import staticPlugin from '@fastify/static';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, createPool } from './env.js';
import { RustClient } from './rust-client.js';
import { buildRoutes, type AppContext } from './routes.js';
import { logger } from './logger.js';
import { JobWorker } from './worker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const env = loadEnv();
  const pool = createPool(env);
  const rust = new RustClient(env);
  const ctx: AppContext = { pool, env, rust };

  const app = Fastify({
    logger: false,
    genReqId: () => `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    trustProxy: env.trustProxy,
    ajv: {
      customOptions: {
        coerceTypes: false,
      },
    },
  });

  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && !env.corsAllowedOrigins.includes(origin)) {
      return reply.code(403).send({
        code: 'cors_origin_denied',
        message: 'CORS origin not allowed',
        retryable: false,
        request_id: req.id,
      });
    }
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || env.corsAllowedOrigins.includes(origin)) cb(null, true);
      else cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
  });
  await app.register(cookie, {});

  const loginAttempts = new Map<string, { count: number; resetAt: number }>();
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.split('?')[0] !== '/api/v1/auth/login') return;
    const ip = req.ip;
    const now = Date.now();
    const bucket = loginAttempts.get(ip) ?? { count: 0, resetAt: now + 60_000 };
    if (bucket.resetAt < now) {
      bucket.count = 0;
      bucket.resetAt = now + 60_000;
    }
    bucket.count += 1;
    loginAttempts.set(ip, bucket);
    if (bucket.count > 10) {
      return reply.code(429).send({ code: 'rate_limited', message: 'Too many login attempts', retryable: true, request_id: req.id });
    }
  });

  // Serve dashboard static files (SPA fallback)
  const dashboardPath = resolve(__dirname, env.dashboardDir);
  try {
    await app.register(staticPlugin, {
      root: dashboardPath,
      prefix: '/',
      wildcard: false,
    });
    app.setNotFoundHandler(async (req, reply) => {
      const path = req.url.split('?')[0];
      if (path.startsWith('/api/')) {
        return reply.code(404).type('application/json').send({
          code: 'not_found',
          message: 'API endpoint not found',
          retryable: false,
          request_id: req.id,
        });
      }
      try {
        const index = readFileSync(resolve(dashboardPath, 'index.html'));
        reply.type('text/html').send(index);
      } catch {
        reply.code(404).send({ code: 'not_found', message: 'Not found' });
      }
    });
  } catch {
    logger.warn({ dashboardPath }, 'Dashboard dist not found, serving API only');
  }

  await buildRoutes(app, ctx);
  const worker = env.workerEnabled ? new JobWorker(ctx) : null;
  worker?.start();

  // Graceful shutdown
  const shutdown = async (sig: string) => {
    logger.info({ sig }, 'Shutting down');
    await worker?.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: '0.0.0.0', port: env.port });
  logger.info({ port: env.port }, 'Storage control plane listening');
}

main().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'Fatal startup error');
  process.exit(1);
});
