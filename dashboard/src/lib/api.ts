import type {
  ApiError,
  AcceptedJobResponse,
  AuditEvent,
  DownloadRequest,
  DownloadResponse,
  DashboardStatusDistribution,
  DashboardSummary,
  HealthResponse,
  LoginResponse,
  Job,
  Orphan,
  OrganizationUsage,
  Paginated,
  Problem,
  ProblemUsage,
  ReconcileResult,
  Snapshot,
  SyncChangesResponse,
  Volume,
} from './types';

const BASE = '/api/v1';

let token: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

export function setToken(t: string | null) {
  token = t;
}

export function getToken(): string | null {
  return token;
}

export function onUnauthorized(handler: (() => void) | null) {
  unauthorizedHandler = handler;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function apiErrorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  if (error instanceof Error) return error.message;
  return 'Request failed';
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) ?? {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    let err: ApiError;
    try {
      err = (await res.json()) as ApiError;
    } catch {
      err = {
        code: 'http_error',
        message: res.statusText,
        retryable: res.status >= 500,
        request_id: res.headers.get('x-request-id') ?? 'unknown',
      };
    }
    if (res.status === 401) {
      setToken(null);
      unauthorizedHandler?.();
    }
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function requestAllowingHealth503<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...((options.headers as Record<string, string>) ?? {}) },
  });
  if (res.status === 503 && path === '/system/health') return (await res.json()) as T;
  if (!res.ok) {
    let err: ApiError;
    try {
      err = (await res.json()) as ApiError;
    } catch {
      err = { code: 'http_error', message: res.statusText, retryable: res.status >= 500, request_id: res.headers.get('x-request-id') ?? 'unknown' };
    }
    throw err;
  }
  return (await res.json()) as T;
}

function idempotencyKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export const api = {
  login: (username: string, password: string) =>
    request<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  health: () => requestAllowingHealth503<HealthResponse>('/system/health'),

  getVolumes: () => request<Paginated<Volume>>('/storage/volumes'),

  reconcile: (problems: Array<{ external_id: string; code: string }>) =>
    request<ReconcileResult>('/catalog/problems:reconcile', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey() },
      body: JSON.stringify({ problems }),
    }),

  getSyncChanges: (cursor?: string, limit = 500) =>
    request<SyncChangesResponse>(
      `/sync/changes?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),

  listProblems: (params: {
    search?: string;
    owner_organization?: string;
    catalog_state?: string;
    sort?: string;
    order?: 'asc' | 'desc';
    cursor?: string;
    limit?: number;
  }) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== '') q.set(k, String(v));
    }
    return request<Paginated<Problem>>(`/problems?${q.toString()}`);
  },

  getProblem: (externalId: string) =>
    request<Problem>(`/problems/${encodeURIComponent(externalId)}`),

  getProblemUsage: (externalId: string) =>
    request<ProblemUsage>(`/problems/${encodeURIComponent(externalId)}/usage`),

  markProblemDirty: (externalId: string) =>
    request<Problem>(`/problems/${encodeURIComponent(externalId)}/dirty`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey() },
    }),

  scanProblem: (externalId: string) =>
    request<AcceptedJobResponse>(
      `/problems/${encodeURIComponent(externalId)}/scan`,
      { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey() } },
    ),

  snapshotProblem: (externalId: string) =>
    request<AcceptedJobResponse>(
      `/problems/${encodeURIComponent(externalId)}/snapshot`,
      { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey() } },
    ),

  restoreProblem: (externalId: string, generation?: number) =>
    request<AcceptedJobResponse>(
      `/problems/${encodeURIComponent(externalId)}/restore`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey() },
        body: JSON.stringify({ generation }),
      },
    ),

  evictProblem: (externalId: string, dryRun = true, force = false) =>
    request<AcceptedJobResponse>(
      `/problems/${encodeURIComponent(externalId)}/evict`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey() },
        body: JSON.stringify({ dry_run: dryRun, force }),
      },
    ),

  listOrganizations: (cursor?: string, limit = 50) =>
    request<Paginated<OrganizationUsage>>(
      `/organizations?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),

  getOrganizationUsage: (externalId: string) =>
    request<OrganizationUsage>(
      `/organizations/${encodeURIComponent(externalId)}/usage`,
    ),

  listSnapshots: (problemId?: string, cursor?: string, limit = 50) => {
    const q = new URLSearchParams();
    if (problemId) q.set('problem_id', problemId);
    if (cursor) q.set('cursor', cursor);
    q.set('limit', String(limit));
    return request<Paginated<Snapshot>>(`/snapshots?${q.toString()}`);
  },

  getSnapshot: (id: string) =>
    request<Snapshot>(`/snapshots/${encodeURIComponent(id)}`),

  listJobs: (params: {
    state?: string;
    problem_id?: string;
    cursor?: string;
    limit?: number;
  }) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== '') q.set(k, String(v));
    }
    return request<Paginated<Job>>(`/jobs?${q.toString()}`);
  },

  getJob: (id: string) => request<Job>(`/jobs/${encodeURIComponent(id)}`),

  retryJob: (id: string, reason = 'dashboard retry') =>
    request<Job>(`/jobs/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey() },
      body: JSON.stringify({ reason }),
    }),

  cancelJob: (id: string, reason = 'dashboard cancel') =>
    request<Job>(`/jobs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey() },
      body: JSON.stringify({ reason }),
    }),

  listOrphans: (cursor?: string, limit = 50) =>
    request<Paginated<Orphan>>(
      `/orphans?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),

  getDashboardSummary: () =>
    request<DashboardSummary>('/dashboard/summary'),

  getDashboardStatusDistribution: () =>
    request<DashboardStatusDistribution>('/dashboard/status-distribution'),

  getLargestProblems: (limit = 10) =>
    request<Paginated<ProblemUsage>>(`/dashboard/largest-problems?limit=${limit}`),

  getLargestOrganizations: (limit = 10) =>
    request<Paginated<OrganizationUsage>>(`/dashboard/largest-organizations?limit=${limit}`),

  getVolumeTimeseries: (params: { name?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.name) q.set('name', params.name);
    if (params.limit) q.set('limit', String(params.limit));
    return request<Paginated<Volume>>(`/dashboard/volume-timeseries${q.toString() ? `?${q.toString()}` : ''}`);
  },

  listAuditEvents: (params: {
    actor?: string;
    action?: string;
    problem_id?: string;
    cursor?: string;
  }) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v) q.set(k, v);
    }
    return request<Paginated<AuditEvent>>(`/audit-events?${q.toString()}`);
  },

  download: (req: DownloadRequest) =>
    request<DownloadResponse>('/downloads', {
      method: 'POST',
      body: JSON.stringify(req),
      headers: { 'Idempotency-Key': idempotencyKey() },
    }),
};

export type JobStreamStatus = 'streaming' | 'polling' | 'reconnecting';

export interface JobWatcher {
  abort: () => void;
}

function absoluteApiPath(pathOrUrl: string): string {
  if (pathOrUrl.startsWith('http')) return pathOrUrl;
  return pathOrUrl.startsWith('/api/v1') ? pathOrUrl : `${BASE}${pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`}`;
}

function parseSseChunk(text: string): Array<{ event: string; data: unknown }> {
  return text
    .split(/\n\n+/)
    .map((raw) => {
      const event = raw.match(/^event:\s*(.+)$/m)?.[1]?.trim() ?? 'message';
      const dataText = raw.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (!dataText) return null;
      try {
        return { event, data: JSON.parse(dataText) };
      } catch {
        return { event, data: dataText };
      }
    })
    .filter((v): v is { event: string; data: unknown } => v != null);
}

export function watchJob(
  accepted: AcceptedJobResponse,
  callbacks: {
    onJob: (job: Job) => void;
    onTerminal?: (job: Job) => void;
    onStatus?: (status: JobStreamStatus) => void;
    onUnauthorized?: () => void;
    onError?: (error: unknown) => void;
  },
): JobWatcher {
  const controller = new AbortController();
  let pollTimer: number | null = null;
  let reconnectTimer: number | null = null;
  let polling = false;
  let reconnecting = false;
  let terminalSent = false;
  let stopped = false;
  let backoff = 500;

  const cleanupTimers = () => {
    if (pollTimer != null) window.clearTimeout(pollTimer);
    if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
    pollTimer = null;
    reconnectTimer = null;
  };

  const terminal = (job: Job) => ['completed', 'failed', 'cancelled'].includes(job.state);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cleanupTimers();
    controller.abort();
  };

  const handleJob = (job: Job) => {
    if (stopped) return;
    callbacks.onJob(job);
    if (terminal(job) && !terminalSent) {
      terminalSent = true;
      callbacks.onTerminal?.(job);
      stop();
    }
  };

  const poll = async () => {
    if (controller.signal.aborted || stopped || polling) return;
    polling = true;
    callbacks.onStatus?.('polling');
    try {
      const job = await api.getJob(accepted.job_id);
      handleJob(job);
      if (!stopped && !terminal(job)) pollTimer = window.setTimeout(poll, 5_000);
    } catch (error) {
      callbacks.onError?.(error);
      if (!stopped) pollTimer = window.setTimeout(poll, 10_000);
    } finally {
      polling = false;
    }
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer != null || reconnecting) return;
    callbacks.onStatus?.('reconnecting');
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, backoff);
    backoff = Math.min(backoff * 2, 10_000);
  };

  const connect = async () => {
    if (controller.signal.aborted || stopped || reconnecting) return;
    reconnecting = true;
    callbacks.onStatus?.(backoff > 500 ? 'reconnecting' : 'streaming');
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const res = await fetch(absoluteApiPath(accepted.events_url), {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        signal: controller.signal,
      });
      if (res.status === 401) {
        setToken(null);
        unauthorizedHandler?.();
        callbacks.onUnauthorized?.();
        stop();
        return;
      }
      if (!res.ok || !res.body) throw new Error(`SSE unavailable (${res.status})`);
      backoff = 500;
      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done || controller.signal.aborted) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\n\n+/);
        buffer = parts.pop() ?? '';
        for (const event of parseSseChunk(parts.join('\n\n'))) {
          if (event.event === 'job' && typeof event.data === 'object' && event.data !== null) {
            const job = event.data as Job;
            handleJob(job);
            if (stopped || terminal(job)) return;
          }
        }
      }
      if (!stopped) {
        scheduleReconnect();
        poll();
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      callbacks.onError?.(error);
      if (!stopped) {
        scheduleReconnect();
        poll();
      }
    } finally {
      reconnecting = false;
      if (stopped && reader) reader.cancel().catch(() => {});
    }
  };

  connect();

  return {
    abort: () => {
      stop();
    },
  };
}
