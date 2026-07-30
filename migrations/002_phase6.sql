-- ClueOJ External Storage - Phase 6: Retention, GC, Backfill tracking
-- PostgreSQL 16+

-- ===========================================================================
-- backfill_state: cursor-based backfill progress (resumable after restart)
-- ===========================================================================
CREATE TABLE backfill_state (
    id              SERIAL PRIMARY KEY,
    capability      TEXT NOT NULL UNIQUE,
    -- accounting | atomic_writes | r2_snapshot | direct_download | ensure_ready | eviction
    cursor_value    TEXT,
    -- last processed problem external_id
    status          TEXT NOT NULL DEFAULT 'pending',
    -- pending | running | paused | completed | failed
    total_processed INTEGER NOT NULL DEFAULT 0,
    total_ready     INTEGER NOT NULL DEFAULT 0,
    total_error     INTEGER NOT NULL DEFAULT 0,
    total_skipped   INTEGER NOT NULL DEFAULT 0,
    bytes_hashed    BIGINT NOT NULL DEFAULT 0,
    bytes_uploaded  BIGINT NOT NULL DEFAULT 0,
    bytes_dedup     BIGINT NOT NULL DEFAULT 0,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===========================================================================
-- gc_marks: mark-and-sweep for content object garbage collection
-- an object is GC-eligible only when it has zero live references AND
-- the safety window (default 7 days) has passed since it became unreferenced
-- ===========================================================================
CREATE TABLE gc_marks (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sha256          TEXT NOT NULL,
    object_key      TEXT NOT NULL,
    snapshot_id     UUID REFERENCES snapshots(id) ON DELETE SET NULL,
    marked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    eligible_at     TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
    collected       BOOLEAN NOT NULL DEFAULT false,
    collected_at    TIMESTAMPTZ,
    UNIQUE(sha256, object_key)
);

CREATE INDEX idx_gc_marks_eligible ON gc_marks(eligible_at) WHERE NOT collected;
CREATE INDEX idx_gc_marks_sha256 ON gc_marks(sha256);

-- ===========================================================================
-- incident_commands: audit log for ops/incident commands (dry-run tracking)
-- ===========================================================================
CREATE TABLE incident_commands (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    command         TEXT NOT NULL,
    -- list_stuck_jobs | pause_queue | resume_queue | pin_generation |
    -- verify_generation | restore_problem | force_reconcile |
    -- rotate_credentials | export_audit | backfill | gc_collect
    actor           TEXT NOT NULL,
    args            JSONB NOT NULL DEFAULT '{}'::jsonb,
    dry_run         BOOLEAN NOT NULL DEFAULT false,
    result          JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_incident_commands_created_at ON incident_commands(created_at);
CREATE INDEX idx_incident_commands_command ON incident_commands(command);

-- ===========================================================================
-- retention_config: configurable retention windows
-- ===========================================================================
CREATE TABLE retention_config (
    id              SERIAL PRIMARY KEY,
    entity_type     TEXT NOT NULL UNIQUE,
    -- jobs | audit_events | superseded_snapshots | content_objects
    retention_days  INTEGER NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO retention_config (entity_type, retention_days) VALUES
    ('jobs', 90),
    ('audit_events', 365),
    ('superseded_snapshots', 90),
    ('content_objects', 7);

-- ===========================================================================
-- updated_at trigger for backfill_state
-- ===========================================================================
CREATE TRIGGER backfill_state_updated_at BEFORE UPDATE ON backfill_state
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();