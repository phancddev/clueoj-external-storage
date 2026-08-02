/**
 * Generated TypeScript client for ClueOJ External Storage API v1.
 * Generated from openapi.yaml.
 */

export type ByteValue = number | string;

export interface ErrorResponse {
  code: string;
  message: string;
  retryable: boolean;
  request_id: string;
}

export interface HealthResponse {
  status: string;
  version: string;
  database: boolean;
  rust_data_plane: boolean;
}

export interface Volume {
  name: string;
  mount_path: string;
  total_bytes: ByteValue;
  free_bytes: ByteValue;
  available_bytes: ByteValue;
  observed_at: string;
  stale: boolean;
}

export interface Problem {
  external_id: string;
  code: string;
  logical_bytes?: ByteValue;
  owner_organization: string | null;
  is_manually_managed: boolean;
  mirror_of: string | null;
  mirror_root: string | null;
  quota_bytes: ByteValue | null;
  catalog_state: 'present' | 'orphan' | 'missing' | 'mirror' | 'deleted';
  dirty: boolean;
  dirty_generation: number | null;
  dirty_version: ByteValue;
  observed_at: string;
  stale: boolean;
}

export interface ProblemUsage {
  problem_id: string;
  logical_bytes: ByteValue;
  allocated_bytes: ByteValue;
  archive_bytes: ByteValue;
  auxiliary_bytes: ByteValue;
  file_count: number;
  local_status: 'present' | 'missing' | 'partial';
  r2_status: 'none' | 'uploading' | 'ready' | 'error' | 'superseded';
  snapshot_generation: number | null;
  orphan_bytes: ByteValue;
  referenced_bytes: ByteValue;
  quota_bytes: ByteValue | null;
  problem_count_quota: number | null;
  last_accessed_at?: string | null;
  observed_at: string;
  stale: boolean;
}

export interface OrganizationUsage {
  organization_id: string;
  problem_count: number;
  logical_bytes: ByteValue;
  allocated_bytes: ByteValue;
  archive_bytes: ByteValue;
  auxiliary_bytes: ByteValue;
  referenced_bytes: ByteValue;
  quota_bytes: ByteValue | null;
  observed_at: string;
  stale: boolean;
}

export interface Snapshot {
  id: string;
  problem_id: string;
  generation: number;
  state: 'discovered' | 'hashing' | 'uploading' | 'verifying' | 'ready' | 'error' | 'superseded';
  file_count: number;
  total_bytes: ByteValue;
  manifest_key: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface Job {
  id: string;
  idempotency_key: string;
  job_type: 'scan' | 'snapshot' | 'restore' | 'evict' | 'reconcile' | 'backfill' | 'gc_collect' | 'incident_command';
  problem_id: string | null;
  target_generation: number | null;
  state: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  lease_owner: string | null;
  lease_expires_at: string | null;
  fencing_token: number;
  attempt: number;
  max_attempts: number;
  result: unknown | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface AuditEvent {
  id: string;
  actor: string;
  actor_role: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  problem_id: string | null;
  generation: number | null;
  job_id: string | null;
  metadata: Record<string, unknown>;
  request_id: string | null;
  created_at: string;
}

export interface DownloadRequest {
  problem_external_id: string;
  ttl_seconds?: number;
}

export interface DownloadResponse {
  url: string;
  expires_at: string;
  method: 'GET';
  headers?: Record<string, string>;
}

export interface Orphan {
  code: string;
  logical_bytes: ByteValue;
  allocated_bytes: ByteValue;
  file_count: number;
  observed_at: string;
}

export interface SyncChange {
  external_id: string;
  code: string;
  owner_organization: string | null;
  is_manually_managed: boolean;
  mirror_of: string | null;
  mirror_root: string | null;
  catalog_state: string;
  event_kind: 'upsert' | 'delete';
  schema_version: number;
  downloadable: boolean;
  quota_bytes: ByteValue | null;
  logical_bytes: ByteValue;
  allocated_bytes: ByteValue;
  archive_bytes: ByteValue;
  auxiliary_bytes: ByteValue;
  file_count: number;
  local_status: string;
  r2_status: string;
  snapshot_generation: number | null;
  orphan_bytes: ByteValue;
  referenced_bytes: ByteValue;
  last_accessed_at?: string | null;
  observed_at: string;
  stale: boolean;
  updated_at: string;
}

export interface SyncChangesResponse {
  schema_version: number;
  changes: SyncChange[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface ReconcileRequest {
  problems: Array<{
    external_id: string;
    code: string;
    owner_external_id?: string | null;
    owner_organization?: string | null;
    owner_organization_id?: string | number | null;
    is_manually_managed?: boolean;
    mirror_root_external_id?: string | null;
    mirror_of_external_id?: string | null;
    mirror_of?: string | null;
    problem_pk?: string | number;
    quota_bytes?: ByteValue | null;
    schema_version?: number;
  }>;
}

export interface ReconcileResult {
  discovered: number;
  present: number;
  missing: number;
  orphan: number;
  mirror: number;
}

export interface ProblemActionRequest {
  dry_run?: boolean;
  generation?: number;
  force?: boolean;
  idle_before?: string;
  reason?: string;
}

export interface JobActionRequest {
  reason?: string;
}

export interface DirtyProblemRequest {
  external_id?: string;
  problem_pk?: string | number;
  code: string;
  owner_organization?: string | null;
  owner_organization_id?: string | number | null;
  owner_external_id?: string | null;
  is_manually_managed?: boolean;
  mirror_of?: string | null;
  mirror_of_external_id?: string | null;
  mirror_root?: string | null;
  mirror_root_external_id?: string | null;
  quota_bytes?: ByteValue | null;
  schema_version?: number;
  event_kind?: 'upsert' | 'delete';
  catalog_state?: 'present' | 'orphan' | 'missing' | 'mirror' | 'deleted';
}

export interface EnsureReadyResponse {
  status: 'ready' | 'restoring' | 'snapshotting' | 'unavailable';
  ready: boolean;
  job_id?: string;
  poll_url?: string;
  events_url?: string;
}

export interface ServiceTokenRequest {
  subject?: string;
  scopes?: string[];
  ttl_seconds?: number;
}

export interface ServiceTokenResponse {
  token: string;
  expires_in: number;
  token_type: 'Bearer';
  audience: string;
  scopes: string[];
}

export interface AcceptedJobResponse {
  job_id: string;
  state: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  poll_url: string;
  events_url: string;
}

export interface Paginated<T> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
}

export class StorageAPIError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable: boolean,
    public requestId: string,
    public status: number,
  ) {
    super(message);
    this.name = 'StorageAPIError';
  }
}

export interface StorageClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export class StorageClient {
  private baseUrl: string;
  private token: string;
  private fetchFn: typeof fetch;

  constructor(opts: StorageClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.token;
    this.fetchFn = opts.fetch ?? fetch;
  }

  private async request<T>(
    method: string,
    path: string,
    opts: {
      body?: unknown;
      idempotencyKey?: string;
      query?: Record<string, string | number | boolean | undefined>;
    } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    const res = await this.fetchFn(url.toString(), {
      method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json() as T | ErrorResponse;
    if (!res.ok) {
      const err = data as ErrorResponse;
      throw new StorageAPIError(err.code, err.message, err.retryable, err.request_id, res.status);
    }
    return data as T;
  }

  getHealth(): Promise<HealthResponse> {
    return this.request<HealthResponse>('GET', '/api/v1/system/health');
  }

  login(username: string, password: string): Promise<{ token: string; expires_in: number; role: string; token_type: 'Bearer' }> {
    return this.request('POST', '/api/v1/auth/login', { body: { username, password } });
  }

  issueServiceToken(req: ServiceTokenRequest, idempotencyKey: string): Promise<ServiceTokenResponse> {
    return this.request('POST', '/api/v1/auth/service-token', { body: req, idempotencyKey });
  }

  getVolumes(): Promise<Paginated<Volume>> {
    return this.request('GET', '/api/v1/storage/volumes');
  }

  reconcile(req: ReconcileRequest, idempotencyKey: string): Promise<ReconcileResult> {
    return this.request('POST', '/api/v1/catalog/problems:reconcile', { body: req, idempotencyKey });
  }

  getSyncChanges(cursor?: string, limit?: number): Promise<SyncChangesResponse> {
    return this.request('GET', '/api/v1/sync/changes', { query: { cursor, limit } });
  }

  listProblems(params?: {
    search?: string; owner_organization?: string; catalog_state?: string;
    sort?: string; order?: 'asc' | 'desc'; cursor?: string; limit?: number;
  }): Promise<Paginated<Problem>> {
    return this.request('GET', '/api/v1/problems', { query: params });
  }

  getProblem(externalId: string): Promise<Problem> {
    return this.request('GET', `/api/v1/problems/${encodeURIComponent(externalId)}`);
  }

  getProblemUsage(externalId: string): Promise<ProblemUsage> {
    return this.request('GET', `/api/v1/problems/${encodeURIComponent(externalId)}/usage`);
  }

  markProblemDirty(externalId: string, idempotencyKey: string, body: DirtyProblemRequest): Promise<Problem> {
    return this.request('POST', `/api/v1/problems/${encodeURIComponent(externalId)}/dirty`, { body, idempotencyKey });
  }

  ensureProblemReady(externalId: string, idempotencyKey: string): Promise<EnsureReadyResponse> {
    return this.request('POST', `/api/v1/problems/${encodeURIComponent(externalId)}/ensure-ready`, { idempotencyKey });
  }

  scanProblem(externalId: string, idempotencyKey: string, body?: ProblemActionRequest): Promise<AcceptedJobResponse> {
    return this.request('POST', `/api/v1/problems/${encodeURIComponent(externalId)}/scan`, { body, idempotencyKey });
  }

  snapshotProblem(externalId: string, idempotencyKey: string, body?: ProblemActionRequest): Promise<AcceptedJobResponse> {
    return this.request('POST', `/api/v1/problems/${encodeURIComponent(externalId)}/snapshot`, { body, idempotencyKey });
  }

  restoreProblem(externalId: string, idempotencyKey: string, body: ProblemActionRequest): Promise<AcceptedJobResponse> {
    return this.request('POST', `/api/v1/problems/${encodeURIComponent(externalId)}/restore`, { body, idempotencyKey });
  }

  evictProblem(externalId: string, idempotencyKey: string, body: ProblemActionRequest): Promise<AcceptedJobResponse> {
    return this.request('POST', `/api/v1/problems/${encodeURIComponent(externalId)}/evict`, { body, idempotencyKey });
  }

  listOrganizations(cursor?: string, limit?: number): Promise<Paginated<OrganizationUsage>> {
    return this.request('GET', '/api/v1/organizations', { query: { cursor, limit } });
  }

  getOrganizationUsage(externalId: string): Promise<OrganizationUsage> {
    return this.request('GET', `/api/v1/organizations/${encodeURIComponent(externalId)}/usage`);
  }

  listSnapshots(params?: { problem_id?: string; cursor?: string; limit?: number }): Promise<Paginated<Snapshot>> {
    return this.request('GET', '/api/v1/snapshots', { query: params });
  }

  getSnapshot(id: string): Promise<Snapshot> {
    return this.request('GET', `/api/v1/snapshots/${encodeURIComponent(id)}`);
  }

  listJobs(params?: { state?: string; problem_id?: string; cursor?: string; limit?: number }): Promise<Paginated<Job>> {
    return this.request('GET', '/api/v1/jobs', { query: params });
  }

  getJob(id: string): Promise<Job> {
    return this.request('GET', `/api/v1/jobs/${encodeURIComponent(id)}`);
  }

  jobEventsUrl(id: string): string {
    const url = new URL(this.baseUrl + `/api/v1/jobs/${encodeURIComponent(id)}/events`);
    return url.toString();
  }

  scheduleCatalogSnapshots(idempotencyKey: string, limit?: number): Promise<{ items: Array<{ problem_id: string; scan_job_id: string; snapshot_job_id: string }>; count: number }> {
    return this.request('POST', '/api/v1/catalog/snapshots:schedule', { body: { limit }, idempotencyKey });
  }

  updateOrganizationSettings(externalId: string, idempotencyKey: string, body: { storage_quota_bytes?: ByteValue | null; problem_count_quota?: number | null }): Promise<Record<string, unknown>> {
    return this.request('PUT', `/api/v1/organizations/${encodeURIComponent(externalId)}/settings`, { body, idempotencyKey });
  }

  getDashboardSummary(): Promise<Record<string, unknown>> {
    return this.request('GET', '/api/v1/dashboard/summary');
  }

  getDashboardStatusDistribution(): Promise<Record<string, unknown>> {
    return this.request('GET', '/api/v1/dashboard/status-distribution');
  }

  getLargestProblems(limit?: number): Promise<Paginated<ProblemUsage>> {
    return this.request('GET', '/api/v1/dashboard/largest-problems', { query: { limit } });
  }

  getLargestOrganizations(limit?: number): Promise<Paginated<OrganizationUsage>> {
    return this.request('GET', '/api/v1/dashboard/largest-organizations', { query: { limit } });
  }

  getVolumeTimeseries(params?: { name?: string; limit?: number }): Promise<Paginated<Volume>> {
    return this.request('GET', '/api/v1/dashboard/volume-timeseries', { query: params });
  }

  retryJob(id: string, idempotencyKey: string, body?: JobActionRequest): Promise<Job> {
    return this.request('POST', `/api/v1/jobs/${encodeURIComponent(id)}/retry`, { body, idempotencyKey });
  }

  cancelJob(id: string, idempotencyKey: string, body?: JobActionRequest): Promise<Job> {
    return this.request('POST', `/api/v1/jobs/${encodeURIComponent(id)}/cancel`, { body, idempotencyKey });
  }

  listOrphans(cursor?: string, limit?: number): Promise<Paginated<Orphan>> {
    return this.request('GET', '/api/v1/orphans', { query: { cursor, limit } });
  }

  listAuditEvents(params?: { actor?: string; action?: string; problem_id?: string; cursor?: string; limit?: number }): Promise<Paginated<AuditEvent>> {
    return this.request('GET', '/api/v1/audit-events', { query: params });
  }

  download(req: DownloadRequest, idempotencyKey: string): Promise<DownloadResponse> {
    return this.request('POST', '/api/v1/downloads', { body: req, idempotencyKey });
  }

  startBackfill(capability: string, idempotencyKey: string): Promise<AcceptedJobResponse> {
    return this.request('POST', `/api/v1/backfill/${encodeURIComponent(capability)}/start`, { idempotencyKey });
  }

  pauseBackfill(capability: string, idempotencyKey: string): Promise<{ status: string; capability: string }> {
    return this.request('POST', `/api/v1/backfill/${encodeURIComponent(capability)}/pause`, { idempotencyKey });
  }

  applyRetention(idempotencyKey: string): Promise<Record<string, number>> {
    return this.request('POST', '/api/v1/retention:apply', { idempotencyKey });
  }

  listGcEligible(limit?: number): Promise<Paginated<{ id: string; sha256: string; object_key: string }>> {
    return this.request('GET', '/api/v1/gc/eligible', { query: { limit } });
  }
}
