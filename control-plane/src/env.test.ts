import { describe, expect, it } from 'vitest';
import type { Env } from './env.js';
import { createPool } from './env.js';

describe('PostgreSQL pool recovery', () => {
  it('registers an idle-client error handler so restart events are not fatal', async () => {
    const pool = createPool({
      databaseUrl: 'postgresql://invalid:invalid@127.0.0.1:1/unused',
    } as Env);

    expect(pool.listenerCount('error')).toBeGreaterThan(0);
    await pool.end();
  });
});
