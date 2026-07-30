-- Complete the snapshot retention and mark-and-sweep GC lifecycle.
-- PostgreSQL 16+

ALTER TABLE snapshots
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

-- Repair legacy installations that may contain more than one READY row.
-- The highest immutable generation remains authoritative.
WITH ranked_ready AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY problem_id
           ORDER BY generation DESC, completed_at DESC NULLS LAST, id DESC
         ) AS ready_rank
  FROM snapshots
  WHERE state = 'ready'
)
UPDATE snapshots
SET state = 'superseded',
    superseded_at = now()
WHERE id IN (
  SELECT id FROM ranked_ready WHERE ready_rank > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_one_ready_problem
  ON snapshots (problem_id)
  WHERE state = 'ready';

-- Existing rows have no trustworthy transition timestamp. Start their
-- rollback-retention window now instead of immediately expiring them.
UPDATE snapshots
SET superseded_at = now()
WHERE state = 'superseded'
  AND superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_snapshots_superseded_retention
  ON snapshots (superseded_at, id)
  WHERE state = 'superseded';

ALTER TABLE gc_marks
  ADD COLUMN IF NOT EXISTS object_kind TEXT NOT NULL DEFAULT 'content',
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error TEXT;

ALTER TABLE gc_marks
  DROP CONSTRAINT IF EXISTS gc_marks_object_kind_check;
ALTER TABLE gc_marks
  ADD CONSTRAINT gc_marks_object_kind_check
  CHECK (object_kind IN ('content', 'manifest'));

INSERT INTO retention_config (entity_type, retention_days)
VALUES ('error_snapshots', 7)
ON CONFLICT (entity_type) DO NOTHING;

CREATE OR REPLACE FUNCTION snapshot_is_gc_protected(
  snapshot_state TEXT,
  snapshot_superseded_at TIMESTAMPTZ,
  snapshot_completed_at TIMESTAMPTZ
)
RETURNS BOOLEAN
STABLE
LANGUAGE SQL
AS $$
  SELECT
    snapshot_state IN ('discovered', 'hashing', 'uploading', 'verifying', 'ready')
    OR (
      snapshot_state = 'superseded'
      AND snapshot_superseded_at >= now() - make_interval(days => (
        SELECT retention_days FROM retention_config
        WHERE entity_type = 'superseded_snapshots'
      ))
    )
    OR (
      snapshot_state = 'error'
      AND snapshot_completed_at >= now() - make_interval(days => (
        SELECT retention_days FROM retention_config
        WHERE entity_type = 'error_snapshots'
      ))
    )
$$;

CREATE INDEX IF NOT EXISTS idx_snapshot_objects_object_key_live
  ON snapshot_objects (object_key, snapshot_id);

CREATE INDEX IF NOT EXISTS idx_snapshots_manifest_key_live
  ON snapshots (manifest_key, state)
  WHERE manifest_key IS NOT NULL;

WITH ranked_gc AS (
  SELECT id,
         ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS active_rank
  FROM jobs
  WHERE job_type = 'gc_collect'
    AND problem_id IS NULL
    AND state IN ('pending', 'running')
)
UPDATE jobs
SET state = 'cancelled',
    error_code = 'duplicate_active_gc',
    error_message = 'Cancelled while installing the one-active-GC guard',
    completed_at = now(),
    lease_owner = NULL,
    lease_expires_at = NULL
WHERE id IN (
  SELECT id FROM ranked_gc WHERE active_rank > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_one_active_gc_collect
  ON jobs (job_type)
  WHERE job_type = 'gc_collect'
    AND problem_id IS NULL
    AND state IN ('pending', 'running');
