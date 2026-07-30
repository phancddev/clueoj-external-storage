import type { Pool } from 'pg';
import type { Role, StorageJWTPayload } from './auth.js';
import {
  DUMMY_PASSWORD_HASH, hashPassword, normalizeUsername, verifyPassword,
} from './password.js';

export interface DashboardUser {
  username: string;
  role: Role;
  enabled: boolean;
  authVersion: number;
  createdAt: Date;
  updatedAt: Date;
  passwordChangedAt: Date;
}

export class LastDashboardAdministratorError extends Error {
  constructor() {
    super('Cannot delete the last enabled dashboard administrator; create another administrator first');
    this.name = 'LastDashboardAdministratorError';
  }
}

interface DashboardUserAuth extends DashboardUser {
  passwordHash: string;
}

function rowToUser(row: Record<string, unknown>): DashboardUserAuth {
  return {
    username: String(row.username),
    passwordHash: String(row.password_hash),
    role: row.role as Role,
    enabled: Boolean(row.enabled),
    authVersion: Number(row.auth_version),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
    passwordChangedAt: new Date(String(row.password_changed_at)),
  };
}

export async function getDashboardUser(pool: Pool, username: string): Promise<DashboardUserAuth | null> {
  const normalized = normalizeUsername(username);
  if (!normalized) return null;
  const { rows } = await pool.query(
    `SELECT username, password_hash, role, enabled, auth_version,
            created_at, updated_at, password_changed_at
     FROM dashboard_users
     WHERE username = $1`,
    [normalized],
  );
  return rows[0] ? rowToUser(rows[0]) : null;
}

export async function verifyDashboardCredentials(
  pool: Pool,
  username: string,
  password: string,
): Promise<DashboardUser | null> {
  const user = await getDashboardUser(pool, username);
  const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!user || !user.enabled || !valid) return null;
  return user;
}

export async function isDashboardSessionActive(
  pool: Pool,
  payload: StorageJWTPayload,
): Promise<boolean> {
  if (payload.kind !== 'operator' || !Number.isSafeInteger(payload.auth_version)) return false;
  const user = await getDashboardUser(pool, payload.sub);
  return Boolean(user?.enabled && user.authVersion === payload.auth_version);
}

export async function createDashboardUser(
  pool: Pool,
  username: string,
  password: string,
): Promise<DashboardUser> {
  const normalized = normalizeUsername(username);
  if (!normalized) throw new Error('Username must be 3-64 characters using letters, numbers, dot, underscore, or dash');
  const passwordHash = await hashPassword(password);
  const { rows } = await pool.query(
    `INSERT INTO dashboard_users (username, password_hash, role)
     VALUES ($1, $2, 'storage-admin')
     RETURNING username, password_hash, role, enabled, auth_version,
               created_at, updated_at, password_changed_at`,
    [normalized, passwordHash],
  );
  return rowToUser(rows[0]);
}

export async function changeDashboardUserPassword(
  pool: Pool,
  username: string,
  password: string,
): Promise<DashboardUser | null> {
  const normalized = normalizeUsername(username);
  if (!normalized) return null;
  const passwordHash = await hashPassword(password);
  const { rows } = await pool.query(
    `UPDATE dashboard_users
     SET password_hash = $2,
         auth_version = auth_version + 1,
         password_changed_at = now()
     WHERE username = $1
     RETURNING username, password_hash, role, enabled, auth_version,
               created_at, updated_at, password_changed_at`,
    [normalized, passwordHash],
  );
  return rows[0] ? rowToUser(rows[0]) : null;
}

export async function deleteDashboardUser(pool: Pool, username: string): Promise<boolean> {
  const normalized = normalizeUsername(username);
  if (!normalized) return false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('dashboard-users-delete', 2907))");
    const target = await client.query(
      'SELECT username, enabled FROM dashboard_users WHERE username = $1 FOR UPDATE',
      [normalized],
    );
    if (!target.rows[0]) {
      await client.query('COMMIT');
      return false;
    }
    if (target.rows[0].enabled) {
      const { rows } = await client.query(
        'SELECT COUNT(*)::integer AS count FROM dashboard_users WHERE enabled = true',
      );
      if (Number(rows[0]?.count ?? 0) <= 1) throw new LastDashboardAdministratorError();
    }
    await client.query('DELETE FROM dashboard_users WHERE username = $1', [normalized]);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listDashboardUsers(pool: Pool): Promise<DashboardUser[]> {
  const { rows } = await pool.query(
    `SELECT username, password_hash, role, enabled, auth_version,
            created_at, updated_at, password_changed_at
     FROM dashboard_users
     ORDER BY username`,
  );
  return rows.map(rowToUser);
}
