-- Review hardening: auth/queue/catalog/sync rollout support.
-- PostgreSQL 16+

ALTER TABLE problems
  ADD COLUMN IF NOT EXISTS dirty BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dirty_generation INTEGER,
  ADD COLUMN IF NOT EXISTS dirty_version BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quota_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS requested_cancel_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS requested_cancel_reason TEXT,
  ADD COLUMN IF NOT EXISTS request_fingerprint TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS job_fencing_counters (
    problem_id  TEXT PRIMARY KEY,
    next_token  BIGINT NOT NULL DEFAULT 1
);

INSERT INTO job_fencing_counters (problem_id, next_token)
SELECT COALESCE(problem_id, '__global__'), COALESCE(MAX(fencing_token), 0) + 1
FROM jobs
GROUP BY COALESCE(problem_id, '__global__')
ON CONFLICT (problem_id) DO UPDATE
SET next_token = GREATEST(job_fencing_counters.next_token, EXCLUDED.next_token);

CREATE TABLE IF NOT EXISTS problem_generation_counters (
    problem_id       TEXT PRIMARY KEY REFERENCES problems(external_id) ON DELETE CASCADE,
    next_generation  INTEGER NOT NULL DEFAULT 1
);

INSERT INTO problem_generation_counters (problem_id, next_generation)
SELECT problem_id, COALESCE(MAX(generation), 0) + 1
FROM snapshots
GROUP BY problem_id
ON CONFLICT (problem_id) DO UPDATE
SET next_generation = GREATEST(problem_generation_counters.next_generation, EXCLUDED.next_generation);

CREATE TABLE IF NOT EXISTS idempotency_keys (
    idempotency_key TEXT NOT NULL,
    scope           TEXT NOT NULL,
    actor           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (idempotency_key, scope)
);

CREATE INDEX IF NOT EXISTS idx_jobs_pending_lease
  ON jobs (state, created_at, id)
  WHERE state IN ('pending', 'running');

CREATE TABLE IF NOT EXISTS queue_state (
    name       TEXT PRIMARY KEY,
    paused     BOOLEAN NOT NULL DEFAULT false,
    reason     TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO queue_state (name, paused)
VALUES ('default', false)
ON CONFLICT (name) DO NOTHING;

ALTER TABLE backfill_state
  ADD COLUMN IF NOT EXISTS lease_owner TEXT,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS error_message TEXT;

CREATE INDEX IF NOT EXISTS idx_problem_usage_observed_at ON problem_usage (observed_at, problem_id);
CREATE INDEX IF NOT EXISTS idx_problems_observed_at ON problems (observed_at, external_id);

CREATE TABLE IF NOT EXISTS organization_settings (
    organization_id            TEXT PRIMARY KEY,
    storage_quota_bytes        BIGINT,
    problem_count_quota        INTEGER,
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage_volume_observations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            TEXT NOT NULL,
    mount_path      TEXT NOT NULL,
    total_bytes     BIGINT NOT NULL DEFAULT 0,
    free_bytes      BIGINT NOT NULL DEFAULT 0,
    available_bytes BIGINT NOT NULL DEFAULT 0,
    observed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_storage_volume_observations_name_time
  ON storage_volume_observations (name, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_snapshot_objects_live_refs
  ON snapshot_objects (sha256, object_key, snapshot_id);

CREATE INDEX IF NOT EXISTS idx_gc_marks_pending_live_check
  ON gc_marks (eligible_at, id)
  WHERE NOT collected;
