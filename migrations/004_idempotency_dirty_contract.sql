-- Dirty endpoint idempotency hardening.
-- Safe to apply after 003_review_contracts.sql; do not rewrite already-applied migrations.

ALTER TABLE idempotency_keys
  ADD COLUMN IF NOT EXISTS request_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS target_type TEXT,
  ADD COLUMN IF NOT EXISTS target_id TEXT,
  ADD COLUMN IF NOT EXISTS response_problem_id TEXT REFERENCES problems(external_id),
  ADD COLUMN IF NOT EXISTS response_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_target
  ON idempotency_keys (scope, target_type, target_id);
