import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { maintenanceConfig } from './maintenance-config.js';
import { purgeTerminalJobs } from './db.js';

afterEach(() => vi.unstubAllEnvs());

describe('maintenance configuration and purge batching', () => {
  it('defaults to three failures, 24 hours and 14 days', () => {
    for (const key of ['STORAGE_PERMANENT_FAILURE_THRESHOLD', 'STORAGE_SNAPSHOT_BACKOFF_INTERVAL_MS', 'STORAGE_TERMINAL_JOB_RETENTION_DAYS']) {
      vi.stubEnv(key, undefined);
    }
    expect(maintenanceConfig()).toEqual({
      permanentFailureThreshold: 3, snapshotBackoffIntervalMs: 86400000, terminalJobRetentionDays: 14,
    });
  });

  it('accepts overrides and rejects invalid retention values', () => {
    vi.stubEnv('STORAGE_PERMANENT_FAILURE_THRESHOLD', '5');
    vi.stubEnv('STORAGE_SNAPSHOT_BACKOFF_INTERVAL_MS', '1000');
    vi.stubEnv('STORAGE_TERMINAL_JOB_RETENTION_DAYS', '7');
    expect(maintenanceConfig()).toEqual({
      permanentFailureThreshold: 5, snapshotBackoffIntervalMs: 1000, terminalJobRetentionDays: 7,
    });
    vi.stubEnv('STORAGE_TERMINAL_JOB_RETENTION_DAYS', '-1');
    expect(maintenanceConfig).toThrow('positive integer');
  });

  it('deletes bounded batches until the last partial batch', async () => {
    vi.stubEnv('STORAGE_TERMINAL_JOB_RETENTION_DAYS', '14');
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 5000 })
      .mockResolvedValueOnce({ rowCount: 5000 })
      .mockResolvedValueOnce({ rowCount: 7 });
    expect(await purgeTerminalJobs({ query } as unknown as Pool)).toBe(10007);
    expect(query).toHaveBeenCalledTimes(3);
    for (const [sql, params] of query.mock.calls) {
      expect(sql).toContain("state IN ('completed', 'failed', 'cancelled')");
      expect(sql).toContain('updated_at <');
      expect(sql).toContain('LIMIT $2');
      expect(sql).toContain('FOR UPDATE SKIP LOCKED');
      expect(params).toEqual([14, 5000]);
    }
  });
});
