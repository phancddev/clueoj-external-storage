import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type * as DbModule from './db.js';
import type { JobT } from './schemas.js';
import { MaintenanceScheduler } from './maintenance.js';

const job = { id: 'gc-job' } as JobT;

function dependencies(eligible: boolean) {
  return {
    applyRetention: vi.fn().mockResolvedValue({ gc_marks: 1 }),
    listGcEligible: vi.fn().mockResolvedValue(eligible
      ? [{ id: 'mark-1', sha256: 'a'.repeat(64), object_key: `objects/sha256/aa/${'a'.repeat(64)}` }]
      : []),
    createJob: vi.fn().mockResolvedValue(job),
    setJobPayload: vi.fn().mockResolvedValue(job),
    stableFingerprint: vi.fn().mockReturnValue('fingerprint'),
  } satisfies Pick<
    typeof DbModule,
    'applyRetention' | 'listGcEligible' | 'createJob' | 'setJobPayload' | 'stableFingerprint'
  >;
}

describe('maintenance scheduler', () => {
  it('applies retention without creating an empty GC job', async () => {
    const deps = dependencies(false);
    const scheduler = new MaintenanceScheduler({} as Pool, deps);

    await scheduler.runOnce();

    expect(deps.applyRetention).toHaveBeenCalledOnce();
    expect(deps.listGcEligible).toHaveBeenCalledWith(expect.anything(), 1);
    expect(deps.createJob).not.toHaveBeenCalled();
  });

  it('coalesces eligible work through the global GC job queue', async () => {
    const deps = dependencies(true);
    const scheduler = new MaintenanceScheduler({} as Pool, deps);

    await scheduler.runOnce();

    expect(deps.createJob).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      jobType: 'gc_collect',
      problemId: null,
      targetGeneration: null,
      leaseOwner: 'system',
    }));
    expect(deps.setJobPayload).toHaveBeenCalledWith(expect.anything(), 'gc-job', { limit: 500 });
  });
});
