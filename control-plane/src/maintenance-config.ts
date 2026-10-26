export const PERMANENT_FAILURE_THRESHOLD = 3;
export const SNAPSHOT_BACKOFF_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const TERMINAL_JOB_RETENTION_DAYS = 14;
export const TERMINAL_JOB_DELETE_BATCH_SIZE = 5000;

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function maintenanceConfig() {
  return {
    permanentFailureThreshold: positiveInteger('STORAGE_PERMANENT_FAILURE_THRESHOLD', PERMANENT_FAILURE_THRESHOLD),
    snapshotBackoffIntervalMs: positiveInteger('STORAGE_SNAPSHOT_BACKOFF_INTERVAL_MS', SNAPSHOT_BACKOFF_INTERVAL_MS),
    terminalJobRetentionDays: positiveInteger('STORAGE_TERMINAL_JOB_RETENTION_DAYS', TERMINAL_JOB_RETENTION_DAYS),
  };
}
