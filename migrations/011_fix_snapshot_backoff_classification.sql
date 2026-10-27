-- Fix snapshot backoff classification: the rust data plane surfaces most
-- manifest-integrity rejections as HTTP 500, so the executor records them with
-- the generic error_code 'job_failed' and the human-readable message. The
-- original trigger only matched the rare 409/404 codes ('manifest_integrity',
-- 'problem_folder_missing') and never counted the dominant failure class,
-- leaving the failure counter at zero and disabling the 24h parking.
-- Classify by message as well; transient errors (connection refused, timeouts,
-- r2 dispatch failures) must still not count as permanent failures.

CREATE OR REPLACE FUNCTION track_snapshot_job_outcome() RETURNS trigger AS $fn$
DECLARE
  current_dirty_version BIGINT;
  permanent_failure BOOLEAN;
BEGIN
  IF NEW.job_type <> 'snapshot' OR NEW.problem_id IS NULL
     OR NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;
  IF NEW.state IN ('completed', 'failed', 'cancelled') THEN
    SELECT dirty_version INTO current_dirty_version FROM problems
      WHERE external_id = NEW.problem_id FOR UPDATE;
    INSERT INTO problem_usage (problem_id, snapshot_schedule_round)
      VALUES (NEW.problem_id, 1)
      ON CONFLICT (problem_id) DO UPDATE SET
        snapshot_schedule_round = problem_usage.snapshot_schedule_round + 1;
  END IF;
  permanent_failure :=
    NEW.state = 'failed' AND (
      lower(coalesce(NEW.error_code, '')) IN ('manifest_integrity', 'problem_folder_missing')
      OR (lower(coalesce(NEW.error_code, '')) = 'job_failed'
          AND coalesce(NEW.error_message, '') ILIKE '%manifest integrity error%')
    );
  IF NEW.state = 'completed' OR permanent_failure THEN
    INSERT INTO problem_usage (problem_id, snapshot_failure_count, last_snapshot_failed_at)
      VALUES (NEW.problem_id, CASE WHEN permanent_failure THEN 1 ELSE 0 END,
              CASE WHEN permanent_failure THEN now() ELSE NULL END)
      ON CONFLICT (problem_id) DO UPDATE SET
        snapshot_failure_count = CASE WHEN permanent_failure
          THEN LEAST(problem_usage.snapshot_failure_count::bigint + 1, 2147483647)::int
          ELSE 0 END,
        last_snapshot_failed_at = CASE WHEN permanent_failure THEN now() ELSE NULL END;
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
