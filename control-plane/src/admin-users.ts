import { Pool } from 'pg';
import {
  changeDashboardUserPassword,
  createDashboardUser,
  deleteDashboardUser,
  listDashboardUsers,
} from './dashboard-users.js';

function usage(): never {
  console.error(`Usage:
  admin-users create <username> --password-stdin
  admin-users passwd <username> --password-stdin
  admin-users delete <username>
  admin-users list`);
  process.exit(2);
}

async function readPasswordFromStdin(): Promise<string> {
  if (!process.argv.includes('--password-stdin')) usage();
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function main(): Promise<void> {
  const databaseUrl = process.env.STORAGE_DATABASE_URL;
  if (!databaseUrl) throw new Error('Missing env STORAGE_DATABASE_URL');
  const [command, username] = process.argv.slice(2);
  if (!command) usage();

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    if (command === 'create') {
      if (!username) usage();
      const password = await readPasswordFromStdin();
      const user = await createDashboardUser(pool, username, password);
      console.log(`Created dashboard administrator: ${user.username}`);
      return;
    }
    if (command === 'passwd') {
      if (!username) usage();
      const password = await readPasswordFromStdin();
      const user = await changeDashboardUserPassword(pool, username, password);
      if (!user) throw new Error(`Dashboard user not found: ${username}`);
      console.log(`Changed password and revoked existing sessions: ${user.username}`);
      return;
    }
    if (command === 'delete') {
      if (!username || process.argv.includes('--password-stdin')) usage();
      if (!await deleteDashboardUser(pool, username)) throw new Error(`Dashboard user not found: ${username}`);
      console.log(`Deleted dashboard administrator and revoked existing sessions: ${username.toLowerCase()}`);
      return;
    }
    if (command === 'list') {
      if (username) usage();
      const users = await listDashboardUsers(pool);
      if (users.length === 0) {
        console.log('No dashboard administrators configured.');
        return;
      }
      console.table(users.map((user) => ({
        username: user.username,
        role: user.role,
        enabled: user.enabled,
        auth_version: user.authVersion,
        created_at: user.createdAt.toISOString(),
        password_changed_at: user.passwordChangedAt.toISOString(),
      })));
      return;
    }
    usage();
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  const code = (err as { code?: string }).code;
  if (code === '23505') console.error('Dashboard user already exists.');
  else console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
