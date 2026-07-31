-- Fence automatic local eviction against submissions racing the Celery sweep.
--
-- Existing present copies receive a fresh grace window at rollout. The
-- ClueOJ-facing ensure-ready endpoint refreshes last_accessed_at for every
-- judge request; the Rust worker rechecks it under the same per-problem
-- advisory lock used for the destructive rename.

ALTER TABLE problem_usage
  ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;

UPDATE problem_usage
SET last_accessed_at = now()
WHERE local_status = 'present'
  AND last_accessed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_problem_usage_local_access
  ON problem_usage (local_status, last_accessed_at);
