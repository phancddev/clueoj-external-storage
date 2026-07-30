-- Database-backed dashboard administrators.
-- Passwords are stored as versioned scrypt hashes by the control plane.

CREATE TABLE IF NOT EXISTS dashboard_users (
    username            TEXT PRIMARY KEY,
    password_hash       TEXT NOT NULL,
    role                TEXT NOT NULL DEFAULT 'storage-admin',
    enabled             BOOLEAN NOT NULL DEFAULT true,
    auth_version        BIGINT NOT NULL DEFAULT 1,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT dashboard_users_username_format
      CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
    CONSTRAINT dashboard_users_role
      CHECK (role = 'storage-admin'),
    CONSTRAINT dashboard_users_auth_version_positive
      CHECK (auth_version > 0)
);

CREATE INDEX IF NOT EXISTS idx_dashboard_users_enabled
  ON dashboard_users (enabled, username);

DROP TRIGGER IF EXISTS dashboard_users_updated_at ON dashboard_users;
CREATE TRIGGER dashboard_users_updated_at
  BEFORE UPDATE ON dashboard_users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
