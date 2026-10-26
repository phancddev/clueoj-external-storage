-- Track terminal snapshot outcomes regardless of which executor commits them.
ALTER TABLE problem_usage
  ADD COLUMN snapshot_failure_count INT NOT NULL DEFAULT 0,
  ADD COLUMN last_snapshot_failed_at TIMESTAMPTZ,
  ADD COLUMN snapshot_schedule_round BIGINT NOT NULL DEFAULT 0;

CREATE INDEX idx_problem_usage_snapshot_backoff
  ON problem_usage (last_snapshot_failed_at, snapshot_failure_count)
  WHERE local_status = 'present';
CREATE INDEX idx_jobs_terminal_retention
  ON jobs (updated_at, id)
  WHERE state IN ('completed', 'failed', 'cancelled');

-- Retry identities must not depend on the number of retained job rows.
-- snapshot_schedule_round advances on terminal transitions, never on deletion.

CREATE FUNCTION track_snapshot_job_outcome() RETURNS trigger AS $$
DECLARE
  current_dirty_version BIGINT;
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
  IF NEW.state = 'completed' OR
     (NEW.state = 'failed' AND lower(NEW.error_code) IN
       ('manifest_integrity', 'problem_folder_missing')) THEN
    -- Serialize with dirty notifications; an older attempt must not re-park
    -- a newly edited problem. OLD.result still contains the dispatch payload.
    IF OLD.result->>'dirty_version' IS NOT NULL AND
       OLD.result->>'dirty_version' <> current_dirty_version::text THEN
      RETURN NEW;
    END IF;
    INSERT INTO problem_usage (problem_id, snapshot_failure_count, last_snapshot_failed_at)
      VALUES (NEW.problem_id, CASE WHEN NEW.state = 'failed' THEN 1 ELSE 0 END,
              CASE WHEN NEW.state = 'failed' THEN now() ELSE NULL END)
      ON CONFLICT (problem_id) DO UPDATE SET
        snapshot_failure_count = CASE WHEN NEW.state = 'failed'
          THEN LEAST(problem_usage.snapshot_failure_count::bigint + 1, 2147483647)::int
          ELSE 0 END,
        last_snapshot_failed_at = CASE WHEN NEW.state = 'failed' THEN now() ELSE NULL END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jobs_snapshot_outcome AFTER UPDATE OF state ON jobs
  FOR EACH ROW EXECUTE FUNCTION track_snapshot_job_outcome();

-- Both the HTTP dirty notification and the filesystem watcher advance this
-- version. Replayed notifications do not mutate it and must not unpark work.
CREATE FUNCTION reset_snapshot_backoff_on_dirty() RETURNS trigger AS $$
BEGIN
  UPDATE problem_usage SET snapshot_failure_count = 0, last_snapshot_failed_at = NULL
    WHERE problem_id = NEW.external_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER problems_reset_snapshot_backoff AFTER UPDATE OF dirty_version ON problems
  FOR EACH ROW WHEN (OLD.dirty_version IS DISTINCT FROM NEW.dirty_version)
  EXECUTE FUNCTION reset_snapshot_backoff_on_dirty();
