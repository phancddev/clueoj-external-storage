-- Metadata fingerprints avoid rereading unchanged problem content on every
-- reconciliation and readiness request. A new cache entry requires a full scan.
CREATE TABLE IF NOT EXISTS problem_tree_cache (
    code TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    usage_fingerprint TEXT,
    canonical_download_path TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
