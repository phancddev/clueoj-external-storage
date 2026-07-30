import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { RustClient } from './rust-client.js';
import type { Env } from './env.js';

let server: ReturnType<typeof createServer> | null = null;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server?.close((err) => err ? reject(err) : resolve()));
  server = null;
});

function envFor(baseUrl: string): Env {
  return {
    databaseUrl: 'postgres://test',
    rustBaseUrl: baseUrl,
    rustInternalToken: 'internal',
    dashboardJwtSecret: 'dashboard',
    dashboardJwtAudience: 'clueoj-storage-dashboard',
    clueojServiceAudience: 'clueoj-storage',
    clueojServiceSecret: 'service',
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
}

describe('RustClient contract', () => {
  it('uses Rust readiness so object-store failures degrade public health', async () => {
    let requestedPath = '';
    server = createServer((req, res) => {
      requestedPath = req.url || '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ready' }));
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('unexpected server address');

    const client = new RustClient(envFor(`http://127.0.0.1:${address.port}`));

    await expect(client.health()).resolves.toBe(true);
    expect(requestedPath).toBe('/internal/ready');
  });

  it('sends dirty_version in snapshot body without losing bigint precision', async () => {
    let captured: unknown;
    server = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        captured = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'snap',
          problem_id: 'p1',
          generation: 12,
          state: 'ready',
          file_count: 0,
          total_bytes: 0,
          manifest_key: 'm',
          error_code: null,
          error_message: null,
          created_at: '2026-07-29T00:00:00.000Z',
          completed_at: '2026-07-29T00:00:01.000Z',
        }));
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('unexpected server address');

    const client = new RustClient(envFor(`http://127.0.0.1:${address.port}`));
    await client.createSnapshot('p1', 12, 'sum', 9, '9223372036854775807');

    expect(captured).toMatchObject({
      problem_external_id: 'p1',
      generation: 12,
      code: 'sum',
      fencing_token: 9,
      dirty_version: '9223372036854775807',
    });
  });

  it('requests per-problem readiness with the Rust client contract fields', async () => {
    let requestedPath = '';
    server = createServer((req, res) => {
      requestedPath = req.url || '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ready: false,
        local_status: 'missing',
        generation: 17,
        observed_at: '2026-07-30T00:00:00.000Z',
      }));
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('unexpected server address');

    const client = new RustClient(envFor(`http://127.0.0.1:${address.port}`));
    await expect(client.ready('p 1', 'sum/a')).resolves.toMatchObject({
      ready: false,
      local_status: 'missing',
      generation: 17,
      observed_at: '2026-07-30T00:00:00.000Z',
    });
    expect(requestedPath).toBe('/internal/ready?problem_external_id=p%201&code=sum%2Fa');
  });
});
