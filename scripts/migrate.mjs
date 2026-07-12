import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error('DATABASE_URL is required');
}

const migrationsDirectory = resolve('db/migrations');
const files = (await readdir(migrationsDirectory))
  .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
  .sort();

const client = new pg.Client({ connectionString: databaseUrl, application_name: 'niet-erp-migrator' });
await client.connect();

try {
  await client.query('SELECT pg_advisory_lock($1)', [2_024_071_200]);
  await client.query('CREATE SCHEMA IF NOT EXISTS platform');
  await client.query(`
    CREATE TABLE IF NOT EXISTS platform.schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `);

  for (const file of files) {
    const sql = await readFile(resolve(migrationsDirectory, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const existing = await client.query(
      'SELECT checksum FROM platform.schema_migrations WHERE version = $1',
      [file],
    );
    if (existing.rowCount === 1) {
      if (existing.rows[0].checksum !== checksum) {
        throw new Error(`Applied migration ${file} has been modified`);
      }
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO platform.schema_migrations(version, checksum) VALUES ($1, $2)',
        [file, checksum],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    process.stdout.write(`Applied ${file}\n`);
  }
} finally {
  await client.query('SELECT pg_advisory_unlock($1)', [2_024_071_200]).catch(() => undefined);
  await client.end();
}
