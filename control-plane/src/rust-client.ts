import { request, Agent } from 'undici';
import type { Env } from './env.js';

export interface RustVolume {
  total_bytes: number | string;
  free_bytes: number | string;
  available_bytes: number | string;
  observed_at: string;
  stale: boolean;
}

export interface RustScanResult {
  code: string;
  problem_external_id?: string | null;
  logical_bytes: number;
  allocated_bytes: number;
  archive_bytes: number;
  auxiliary_bytes: number;
  file_count: number;
  files: Array<{
    path: string;
    sha256: string;
    size: number;
    allocated_bytes: number;
    dev: number;
    ino: number;
    nlink: number;
    mode: number;
    duplicate_of?: string | null;
    symlink_target?: string | null;
    is_dir: boolean;
  }>;
  observed_at: string;
}

export interface RustSnapshot {
  id: string;
  problem_id: string;
  generation: number;
  state: string;
  file_count: number;
  total_bytes: number;
  manifest_key: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface RustPresignResult {
  url: string;
  expires_at: string;
}

export interface RustReconcileResult {
  discovered: number;
  missing: number;
  orphans: number;
  mirrors: number;
  orphan_codes: string[];
  missing_codes: string[];
}

export interface RustEvictResult {
  problem_id: string;
  dry_run: boolean;
  freed_bytes: number;
  files_removed: number;
  preserved_init_yml: boolean;
}

export interface RustReadyResult {
  ready: boolean;
  local_status: 'present' | 'missing' | 'partial';
  generation: number | null;
  observed_at: string;
}

export class RustClient {
  private agent: Agent;
  constructor(private env: Env) {
    this.agent = new Agent({ connectTimeout: 5000 });
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.env.rustInternalToken) h['x-internal-token'] = this.env.rustInternalToken;
    return h;
  }

  private async post<T>(path: string, body: unknown, timeoutMs = 30000): Promise<T> {
    const res = await request(`${this.env.rustBaseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      dispatcher: this.agent,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    if (res.statusCode >= 400) {
      const text = await res.body.text();
      throw new RustError(res.statusCode, text);
    }
    return res.body.json() as Promise<T>;
  }

  private async getJson<T>(path: string, timeoutMs = 30000): Promise<T> {
    const res = await request(`${this.env.rustBaseUrl}${path}`, {
      method: 'GET',
      headers: this.headers(),
      dispatcher: this.agent,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    if (res.statusCode >= 400) {
      const text = await res.body.text();
      throw new RustError(res.statusCode, text);
    }
    return res.body.json() as Promise<T>;
  }

  async health(): Promise<boolean> {
    try {
      // Readiness includes PostgreSQL and the configured R2 bucket. The
      // dashboard must not report green while the data path is unusable.
      await this.getJson('/internal/ready', 10000);
      return true;
    } catch {
      return false;
    }
  }

  async getVolumes(): Promise<RustVolume> {
    return this.getJson('/internal/volumes');
  }

  async scan(code: string, problemExternalId?: string): Promise<RustScanResult> {
    return this.post('/internal/scan', { code, problem_external_id: problemExternalId ?? null }, 600000);
  }

  async createSnapshot(problemExternalId: string, generation: number, code: string, fencingToken: number, dirtyVersion: number | string | null): Promise<RustSnapshot> {
    return this.post('/internal/snapshot', {
      problem_external_id: problemExternalId,
      generation,
      code,
      fencing_token: fencingToken,
      dirty_version: dirtyVersion,
    }, 600000);
  }

  async restore(problemExternalId: string, generation: number, dest: string, fencingToken: number): Promise<{ status: string }> {
    return this.post('/internal/restore', { problem_external_id: problemExternalId, generation, dest, fencing_token: fencingToken }, 600000);
  }

  async ready(problemExternalId: string, code: string): Promise<RustReadyResult> {
    return this.getJson(`/internal/ready?problem_external_id=${encodeURIComponent(problemExternalId)}&code=${encodeURIComponent(code)}`, 8000);
  }

  async evict(
    problemExternalId: string,
    code: string,
    dryRun: boolean,
    force: boolean,
    fencingToken: number,
    idleBefore?: string,
  ): Promise<RustEvictResult> {
    return this.post('/internal/evict', {
      problem_external_id: problemExternalId,
      code,
      dry_run: dryRun,
      force,
      fencing_token: fencingToken,
      idle_before: idleBefore ?? null,
    });
  }

  async reconcile(problems: Array<[string, string]>): Promise<RustReconcileResult> {
    return this.post('/internal/reconcile', { problems }, 600000);
  }

  async deleteObject(objectKey: string, fencingToken: number): Promise<{ deleted: boolean }> {
    return this.post('/internal/objects:delete', { object_key: objectKey, fencing_token: fencingToken });
  }

  async presign(problemExternalId: string, ttlSeconds?: number): Promise<RustPresignResult> {
    return this.post('/internal/presign', { problem_external_id: problemExternalId, ttl_seconds: ttlSeconds });
  }

  async getProblemUsage(code: string): Promise<unknown> {
    return this.getJson(`/internal/problems/${encodeURIComponent(code)}/usage`);
  }
}

export class RustError extends Error {
  public readonly code: string | null;
  public readonly retryable: boolean;
  public readonly requestId: string | null;

  constructor(public statusCode: number, body: string) {
    let payload: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      // Non-JSON upstream bodies are intentionally not copied into logs/jobs.
    }
    const code = typeof payload?.code === 'string' ? payload.code : null;
    const message = typeof payload?.message === 'string'
      ? payload.message
      : 'data plane request failed';
    super(`Rust data plane error ${statusCode}${code ? ` ${code}` : ''}: ${message}`);
    this.name = 'RustError';
    this.code = code;
    this.retryable = payload?.retryable === true;
    this.requestId = typeof payload?.request_id === 'string' ? payload.request_id : null;
  }
}
