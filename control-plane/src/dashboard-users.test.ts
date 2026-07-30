import { describe, expect, it } from 'vitest';
import {
  deleteDashboardUser, LastDashboardAdministratorError,
} from './dashboard-users.js';

class DeletePool {
  public users = new Map<string, boolean>();
  public released = false;

  constructor(usernames: string[]) {
    for (const username of usernames) this.users.set(username, true);
  }

  async connect() {
    return {
      query: async (sql: string, params: unknown[] = []) => {
        if (
          sql === 'BEGIN'
          || sql === 'COMMIT'
          || sql === 'ROLLBACK'
          || sql.includes('pg_advisory_xact_lock')
        ) return { rows: [], rowCount: 0 };
        if (sql.includes('SELECT username, enabled')) {
          const username = String(params[0]);
          return this.users.has(username)
            ? { rows: [{ username, enabled: this.users.get(username) }], rowCount: 1 }
            : { rows: [], rowCount: 0 };
        }
        if (sql.includes('COUNT(*)::integer')) {
          const count = [...this.users.values()].filter(Boolean).length;
          return { rows: [{ count }], rowCount: 1 };
        }
        if (sql.startsWith('DELETE FROM dashboard_users')) {
          const deleted = this.users.delete(String(params[0]));
          return { rows: [], rowCount: deleted ? 1 : 0 };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
      release: () => {
        this.released = true;
      },
    };
  }
}

describe('dashboard administrator deletion', () => {
  it('prevents deletion of the final enabled administrator', async () => {
    const pool = new DeletePool(['admin']);

    await expect(deleteDashboardUser(pool as any, 'admin'))
      .rejects.toBeInstanceOf(LastDashboardAdministratorError);

    expect(pool.users.has('admin')).toBe(true);
    expect(pool.released).toBe(true);
  });

  it('allows deletion when another enabled administrator remains', async () => {
    const pool = new DeletePool(['admin', 'replacement']);

    await expect(deleteDashboardUser(pool as any, 'admin')).resolves.toBe(true);

    expect([...pool.users.keys()]).toEqual(['replacement']);
    expect(pool.released).toBe(true);
  });

  it('returns false for an unknown administrator', async () => {
    const pool = new DeletePool(['admin']);

    await expect(deleteDashboardUser(pool as any, 'missing')).resolves.toBe(false);

    expect(pool.users.has('admin')).toBe(true);
  });
});
