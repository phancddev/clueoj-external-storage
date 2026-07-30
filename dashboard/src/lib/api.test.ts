import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, getToken, onUnauthorized, setToken, watchJob } from './api';

describe('api client', () => {
  beforeEach(() => {
    setToken(null);
    onUnauthorized(null);
    vi.restoreAllMocks();
  });

  it('sends the login contract expected by the control plane', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ token: 'jwt', expires_in: 3600, role: 'storage-admin' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.login('operator.one', 'secret');

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/login', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ username: 'operator.one', password: 'secret' }),
    }));
  });

  it('reads the paginated volume envelope from the contract', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        items: [{
          name: 'problem-root',
          mount_path: '/problems',
          total_bytes: '9007199254740993',
          free_bytes: '4',
          available_bytes: '3',
          observed_at: '2026-01-01T00:00:00Z',
          stale: false,
        }],
        next_cursor: null,
        has_more: false,
      }), { status: 200 }),
    ));

    await expect(api.getVolumes()).resolves.toMatchObject({ items: [{ total_bytes: '9007199254740993' }] });
  });

  it('clears token and notifies the app on 401', async () => {
    const handler = vi.fn();
    setToken('expired');
    onUnauthorized(handler);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 'invalid_token', message: 'Invalid or expired token', retryable: false, request_id: 'r1' }), { status: 401 }),
    ));

    await expect(api.listJobs({})).rejects.toMatchObject({ code: 'invalid_token' });
    expect(getToken()).toBeNull();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('parses public degraded health 503 without logging out', async () => {
    setToken('still-valid');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'degraded', version: '1', database: false, rust_data_plane: true }), { status: 503 }),
    ));

    await expect(api.health()).resolves.toMatchObject({ database: false, rust_data_plane: true });
    expect(getToken()).toBe('still-valid');
  });

  it('posts problem actions as snake_case JSON body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ job_id: 'job-1' }), { status: 202 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.evictProblem('p1', false, true);

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/problems/p1/evict', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ dry_run: false, force: true }),
    }));
  });

  it('reads sync changes from the changes envelope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ changes: [], next_cursor: 'c2', has_more: true }), { status: 200 }),
    ));

    await expect(api.getSyncChanges('c1')).resolves.toMatchObject({ changes: [], next_cursor: 'c2', has_more: true });
  });

  it('wires dashboard read model endpoints from the contract', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ items: [], next_cursor: null, has_more: false }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.getLargestProblems(8);
    await api.getLargestOrganizations(8);
    await api.getVolumeTimeseries({ limit: 100 });

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/dashboard/largest-problems?limit=8', expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/dashboard/largest-organizations?limit=8', expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/dashboard/volume-timeseries?limit=100', expect.any(Object));
  });

  it('streams job events over authenticated fetch', async () => {
    setToken('jwt');
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: job\ndata: {"id":"job-1","state":"completed","job_type":"scan","idempotency_key":"k","problem_id":null,"target_generation":null,"lease_owner":null,"lease_expires_at":null,"fencing_token":1,"attempt":1,"max_attempts":1,"result":null,"error_code":null,"error_message":null,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","completed_at":"2026-01-01T00:00:01Z"}\n\n'));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const onJob = vi.fn();

    watchJob({ job_id: 'job-1', state: 'running', poll_url: '/api/v1/jobs/job-1', events_url: '/api/v1/jobs/job-1/events' }, { onJob });
    await vi.waitFor(() => expect(onJob).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-1', state: 'completed' })));
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/jobs/job-1/events', expect.objectContaining({ headers: { Authorization: 'Bearer jwt' } }));
  });

  it('falls back to polling after SSE failure and emits terminal exactly once', async () => {
    const completed = {
      id: 'job-2',
      state: 'completed',
      job_type: 'scan',
      idempotency_key: 'k',
      problem_id: null,
      target_generation: null,
      lease_owner: null,
      lease_expires_at: null,
      fencing_token: 1,
      attempt: 1,
      max_attempts: 1,
      result: null,
      error_code: null,
      error_message: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      completed_at: '2026-01-01T00:00:01Z',
    };
    const onJob = vi.fn();
    const onTerminal = vi.fn();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('stream down'))
      .mockResolvedValueOnce(new Response(JSON.stringify(completed), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    watchJob(
      { job_id: 'job-2', state: 'running', poll_url: '/api/v1/jobs/job-2', events_url: '/api/v1/jobs/job-2/events' },
      { onJob, onTerminal },
    );

    await vi.waitFor(() => expect(onJob).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-2', state: 'completed' })));
    expect(onTerminal).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/jobs/job-2/events', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(fetchMock.mock.calls[0][0]).not.toContain('access_token');
  });
});
