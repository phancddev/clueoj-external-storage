-- Allow a watcher-created orphan projection to be atomically claimed by its
-- authoritative ClueOJ external ID without losing usage, jobs, or snapshots.

ALTER TABLE problem_usage
  DROP CONSTRAINT problem_usage_problem_id_fkey,
  ADD CONSTRAINT problem_usage_problem_id_fkey
    FOREIGN KEY (problem_id) REFERENCES problems(external_id)
    ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE snapshots
  DROP CONSTRAINT snapshots_problem_id_fkey,
  ADD CONSTRAINT snapshots_problem_id_fkey
    FOREIGN KEY (problem_id) REFERENCES problems(external_id)
    ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE jobs
  DROP CONSTRAINT jobs_problem_id_fkey,
  ADD CONSTRAINT jobs_problem_id_fkey
    FOREIGN KEY (problem_id) REFERENCES problems(external_id)
    ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE problem_generation_counters
  DROP CONSTRAINT problem_generation_counters_problem_id_fkey,
  ADD CONSTRAINT problem_generation_counters_problem_id_fkey
    FOREIGN KEY (problem_id) REFERENCES problems(external_id)
    ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE idempotency_keys
  DROP CONSTRAINT idempotency_keys_response_problem_id_fkey,
  ADD CONSTRAINT idempotency_keys_response_problem_id_fkey
    FOREIGN KEY (response_problem_id) REFERENCES problems(external_id)
    ON UPDATE CASCADE;

ALTER TABLE problems
  DROP CONSTRAINT problems_mirror_of_fkey,
  ADD CONSTRAINT problems_mirror_of_fkey
    FOREIGN KEY (mirror_of) REFERENCES problems(external_id)
    ON UPDATE CASCADE;

ALTER TABLE problems
  DROP CONSTRAINT problems_mirror_root_fkey,
  ADD CONSTRAINT problems_mirror_root_fkey
    FOREIGN KEY (mirror_root) REFERENCES problems(external_id)
    ON UPDATE CASCADE;
