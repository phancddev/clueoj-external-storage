# Snapshot backoff and job retention

Migration `010_snapshot_backoff_job_retention.sql` adds internal usage counters,
terminal-job retention indexing and outcome/dirty-version triggers. Apply it
before running the updated control plane. No migration or deployment was run as
part of this change.

Only terminal snapshot failures with `manifest_integrity` or
`problem_folder_missing` (case insensitive) increment the failure count. At three
failures, automatic scheduling pauses for 24 hours after the latest permanent
failure. The count stays intact when the window expires: another permanent
failure parks the problem for another 24 hours. Transient failures do not count.
A successful snapshot or a new dirty version resets the count and timestamp.
Dirty notification replays do not reset it. Old-version completions cannot park a
newly edited problem. Recovery scheduling for missing snapshots preserves the
dirty version because it does not represent a content edit.

Configuration (positive integers):

- `STORAGE_PERMANENT_FAILURE_THRESHOLD`: default `3`.
- `STORAGE_SNAPSHOT_BACKOFF_INTERVAL_MS`: default `86400000`.
- `STORAGE_TERMINAL_JOB_RETENTION_DAYS`: default `14`.

Hourly maintenance deletes only completed, failed or cancelled jobs whose
`updated_at` is older than retention, in separately committed batches of 5000,
using `FOR UPDATE SKIP LOCKED`. It logs the total purged count at info level.
Job history and job-key replay expire with retention. The separate
`idempotency_keys` table only stores dirty notification responses referencing
problems, not jobs; these keys are retained. In-flight jobs are never selected.
Automatic scheduling uses a durable per-problem round instead of counting job
history, so deleting old rows cannot cause retry-key reuse.

Regression coverage lives in `maintenance-config.test.ts`, `maintenance.test.ts`
and `postgres-contract.test.ts` (the latter requires `TEST_DATABASE_URL` and uses
an isolated schema). Tests were added but deliberately not executed per request.
The optional filesystem pre-check is omitted.
