-- Serialize local filesystem operations per problem at the database boundary.
-- The cleanup makes this migration safe on installations that already contain
-- duplicate active jobs from an older application version.

WITH ranked_by_type AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY problem_id, job_type
           ORDER BY created_at ASC, id ASC
         ) AS active_rank
  FROM jobs
  WHERE problem_id IS NOT NULL
    AND job_type IN ('scan', 'snapshot', 'restore', 'evict')
    AND state IN ('pending', 'running')
)
UPDATE jobs
SET state = 'cancelled',
    error_code = 'duplicate_active_operation',
    error_message = 'Cancelled while installing the one-active-operation database guard',
    completed_at = now(),
    lease_owner = NULL,
    lease_expires_at = NULL
WHERE id IN (
  SELECT id FROM ranked_by_type WHERE active_rank > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_one_active_problem_job_type
  ON jobs (problem_id, job_type)
  WHERE problem_id IS NOT NULL
    AND job_type IN ('scan', 'snapshot', 'restore', 'evict')
    AND state IN ('pending', 'running');

WITH ranked_running AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY problem_id
           ORDER BY created_at ASC, id ASC
         ) AS running_rank
  FROM jobs
  WHERE problem_id IS NOT NULL
    AND job_type IN ('scan', 'snapshot', 'restore', 'evict')
    AND state = 'running'
)
UPDATE jobs
SET state = 'cancelled',
    error_code = 'duplicate_running_operation',
    error_message = 'Cancelled while installing the one-running-operation database guard',
    completed_at = now(),
    lease_owner = NULL,
    lease_expires_at = NULL
WHERE id IN (
  SELECT id FROM ranked_running WHERE running_rank > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_one_running_problem_operation
  ON jobs (problem_id)
  WHERE problem_id IS NOT NULL
    AND job_type IN ('scan', 'snapshot', 'restore', 'evict')
    AND state = 'running';
