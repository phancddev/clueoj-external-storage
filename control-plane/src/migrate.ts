import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function runMigrations(): Promise<void> {
  const databaseUrl = process.env.STORAGE_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('Missing env STORAGE_DATABASE_URL');
  }
  const pool = new Pool({ connectionString: databaseUrl });

  // Ensure schema_migrations table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const migrationsDir = resolve(__dirname, '../../migrations');
  let files: string[];
  try {
    files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    console.log('No migrations directory found, skipping');
    await pool.end();
    return;
  }

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    const { rows } = await pool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
    if (rows.length > 0) {
      console.log(`Skipping ${version} (already applied)`);
      continue;
    }
    console.log(`Applying ${version}...`);
    const sql = readFileSync(resolve(migrationsDir, file), 'utf-8');
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      await pool.query('COMMIT');
      console.log(`  OK ${version}`);
    } catch (err) {
      await pool.query('ROLLBACK');
      console.error(`  FAILED ${version}:`, (err as Error).message);
      process.exit(1);
    }
  }

  console.log('Migrations complete');
  await pool.end();
}

runMigrations().catch((err) => {
  console.error('Migration error:', err);
  process.exit(1);
});
