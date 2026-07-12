import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';

const execute = promisify(execFile);
const sourceUrl = process.env.DATABASE_URL;
if (sourceUrl === undefined) throw new Error('DATABASE_URL is required');
const source = new URL(sourceUrl);
if (!source.pathname.endsWith('_test')) throw new Error('Restore verification requires a _test source database');
const targetName = `${source.pathname.slice(1).replace(/_test$/, '')}_restore_test`;
if (!/^[a-zA-Z0-9_]+$/.test(targetName)) throw new Error('Unsafe test database name');
const target = new URL(source);
target.pathname = `/${targetName}`;
const admin = new URL(source);
admin.pathname = '/postgres';
const directory = await mkdtemp(join(tmpdir(), 'niet-erp-backup-'));
const adminPool = new pg.Pool({ connectionString: admin.toString() });
const sourcePool = new pg.Pool({ connectionString: source.toString() });

try {
  await sourcePool.query(`CREATE TABLE IF NOT EXISTS platform.restore_verification_marker (
    id uuid PRIMARY KEY, value text NOT NULL)`);
  const id = randomUUID();
  await sourcePool.query('INSERT INTO platform.restore_verification_marker (id, value) VALUES ($1, $2)',
    [id, 'backup-boundary']);
  const backup = (await execute('sh', ['scripts/backup-postgres.sh'], {
    env: { ...process.env, DATABASE_URL: source.toString(), BACKUP_DIRECTORY: directory },
  })).stdout.trim();
  await adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname = $1 AND pid <> pg_backend_pid()`, [targetName]);
  await adminPool.query(`DROP DATABASE IF EXISTS "${targetName}"`);
  await adminPool.query(`CREATE DATABASE "${targetName}"`);
  await execute('sh', ['scripts/restore-postgres.sh'], {
    env: { ...process.env, TARGET_DATABASE_URL: target.toString(), BACKUP_FILE: backup },
  });
  const restored = new pg.Pool({ connectionString: target.toString() });
  try {
    const result = await restored.query(
      'SELECT value FROM platform.restore_verification_marker WHERE id = $1', [id]);
    if (result.rows[0]?.value !== 'backup-boundary') throw new Error('Restored control record does not match');
    const migrations = await restored.query('SELECT COUNT(*)::int AS count FROM platform.schema_migrations');
    if (migrations.rows[0]?.count < 1) throw new Error('Migration history was not restored');
  } finally {
    await restored.end();
  }
  process.stdout.write('PostgreSQL backup integrity and isolated restore verified\n');
} finally {
  await sourcePool.end();
  await adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname = $1 AND pid <> pg_backend_pid()`, [targetName]).catch(() => undefined);
  await adminPool.query(`DROP DATABASE IF EXISTS "${targetName}"`).catch(() => undefined);
  await adminPool.end();
  await rm(directory, { recursive: true, force: true });
}
