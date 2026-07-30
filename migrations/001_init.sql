-- ClueOJ External Storage - Initial Schema
-- PostgreSQL 16+

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ===========================================================================
-- storage_volumes: filesystem volume accounting
-- ===========================================================================
CREATE TABLE storage_volumes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            TEXT NOT NULL UNIQUE,
    mount_path      TEXT NOT NULL,
    total_bytes     BIGINT NOT NULL DEFAULT 0,
    free_bytes      BIGINT NOT NULL DEFAULT 0,
    available_bytes BIGINT NOT NULL DEFAULT 0,
    observed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    stale           BOOLEAN NOT NULL DEFAULT true
);

-- ===========================================================================
-- problems: catalog of problems known to the storage app
-- external_id = ClueOJ Problem.pk (stable integer, cast to text)
-- code = mutable ClueOJ Problem.code (used as FS subfolder name)
-- ===========================================================================
CREATE TABLE problems (
    external_id         TEXT PRIMARY KEY,
    code                TEXT NOT NULL,
    owner_organization  TEXT,
    is_manually_managed BOOLEAN NOT NULL DEFAULT false,
    mirror_of           TEXT REFERENCES problems(external_id),
    mirror_root         TEXT REFERENCES problems(external_id),
    catalog_state       TEXT NOT NULL DEFAULT 'present',
    -- present | orphan | missing | mirror
    observed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    stale               BOOLEAN NOT NULL DEFAULT true,
    UNIQUE(code)
);

-- ===========================================================================
-- problem_usage: per-problem storage accounting metrics
-- ===========================================================================
CREATE TABLE problem_usage (
    problem_id          TEXT PRIMARY KEY REFERENCES problems(external_id) ON DELETE CASCADE,
    logical_bytes       BIGINT NOT NULL DEFAULT 0,
    allocated_bytes     BIGINT NOT NULL DEFAULT 0,
    archive_bytes       BIGINT NOT NULL DEFAULT 0,
    auxiliary_bytes     BIGINT NOT NULL DEFAULT 0,
    file_count          INTEGER NOT NULL DEFAULT 0,
    local_status        TEXT NOT NULL DEFAULT 'missing',
    -- missing | present | partial
    r2_status           TEXT NOT NULL DEFAULT 'none',
    -- none | uploading | ready | error | superseded
    snapshot_generation INTEGER,
    orphan_bytes        BIGINT NOT NULL DEFAULT 0,
    referenced_bytes    BIGINT NOT NULL DEFAULT 0,
    -- for mirrors: bytes referenced from root
    observed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    stale               BOOLEAN NOT NULL DEFAULT true
);

-- ===========================================================================
-- snapshots: immutable full-folder snapshot generations
-- ===========================================================================
CREATE TABLE snapshots (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    problem_id  TEXT NOT NULL REFERENCES problems(external_id) ON DELETE CASCADE,
    generation  INTEGER NOT NULL,
    state       TEXT NOT NULL DEFAULT 'discovered',
    -- discovered | hashing | uploading | verifying | ready | error | superseded
    file_count  INTEGER NOT NULL DEFAULT 0,
    total_bytes BIGINT NOT NULL DEFAULT 0,
    manifest_key TEXT,
    error_code  TEXT,
    error_message TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    UNIQUE(problem_id, generation)
);

CREATE INDEX idx_snapshots_problem_id ON snapshots(problem_id);
CREATE INDEX idx_snapshots_state ON snapshots(state);

-- ===========================================================================
-- snapshot_objects: individual content objects within a snapshot
-- ===========================================================================
CREATE TABLE snapshot_objects (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    snapshot_id   UUID NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    sha256        TEXT NOT NULL,
    rel_path      TEXT NOT NULL,
    size_bytes    BIGINT NOT NULL DEFAULT 0,
    object_key    TEXT NOT NULL,
    uploaded      BOOLEAN NOT NULL DEFAULT false,
    verified      BOOLEAN NOT NULL DEFAULT false,
    UNIQUE(snapshot_id, rel_path)
);

CREATE INDEX idx_snapshot_objects_sha256 ON snapshot_objects(sha256);
CREATE INDEX idx_snapshot_objects_snapshot_id ON snapshot_objects(snapshot_id);

-- ===========================================================================
-- jobs: background job queue with lease + fencing
-- ===========================================================================
CREATE TABLE jobs (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    idempotency_key   TEXT NOT NULL,
    job_type          TEXT NOT NULL,
    -- scan | snapshot | restore | evict | reconcile
    problem_id        TEXT REFERENCES problems(external_id) ON DELETE CASCADE,
    target_generation INTEGER,
    state             TEXT NOT NULL DEFAULT 'pending',
    -- pending | running | completed | failed | cancelled
    lease_owner       TEXT,
    lease_expires_at  TIMESTAMPTZ,
    fencing_token     BIGINT NOT NULL DEFAULT 0,
    attempt           INTEGER NOT NULL DEFAULT 0,
    max_attempts      INTEGER NOT NULL DEFAULT 3,
    result            JSONB,
    error_code        TEXT,
    error_message     TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at      TIMESTAMPTZ,
    UNIQUE(idempotency_key, job_type)
);

CREATE INDEX idx_jobs_state ON jobs(state);
CREATE INDEX idx_jobs_problem_id ON jobs(problem_id);
CREATE INDEX idx_jobs_lease_expires ON jobs(lease_expires_at);

-- ===========================================================================
-- audit_events: immutable audit log (no secrets or presigned URLs)
-- ===========================================================================
CREATE TABLE audit_events (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    actor       TEXT NOT NULL,
    -- user sub or 'system' or 'clueoj-service'
    actor_role  TEXT,
    action      TEXT NOT NULL,
    -- problem.scan | problem.snapshot | problem.restore | problem.evict |
    -- job.retry | job.cancel | settings.update | owner.update |
    -- download.url_issued | download.url_failed | auth.login | auth.denied
    target_type TEXT,
    target_id   TEXT,
    problem_id  TEXT,
    generation  INTEGER,
    job_id      UUID,
    metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
    request_id  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_events_created_at ON audit_events(created_at);
CREATE INDEX idx_audit_events_actor ON audit_events(actor);
CREATE INDEX idx_audit_events_action ON audit_events(action);
CREATE INDEX idx_audit_events_problem_id ON audit_events(problem_id);

-- ===========================================================================
-- updated_at trigger for jobs
-- ===========================================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jobs_updated_at BEFORE UPDATE ON jobs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();