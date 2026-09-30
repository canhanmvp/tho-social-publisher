import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';

async function migrate(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const migrationsDirectory = resolve(process.cwd(), 'migrations');
    const migrationFiles = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql')).sort();

    for (const name of migrationFiles) {
      const alreadyApplied = await client.query<{ exists: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE name = $1) AS exists',
        [name],
      );
      if (alreadyApplied.rows[0]?.exists) continue;

      const sql = await readFile(resolve(migrationsDirectory, name), 'utf8');
      console.log(`[migrate] applying ${name}`);

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    console.log('[migrate] database is up to date');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((error: unknown) => {
  const details = error instanceof Error
    ? { name: error.name, message: error.message }
    : { message: 'Unknown error' };
  console.error('[migrate] failed', details);
  process.exitCode = 1;
});
