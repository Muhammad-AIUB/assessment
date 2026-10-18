// Versioned SQL migrations: db/migrations/NNN_name.sql, applied in order, each in its own
// transaction, recorded in schema_migrations so each runs exactly once.
import { readFileSync, readdirSync } from 'node:fs';
import { createPool } from '../src/db.js';

const DIR = new URL('../db/migrations/', import.meta.url);

export async function migrate(pool, { log = () => {} } = {}) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const done = new Set((await pool.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
  const files = readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const applied = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(readFileSync(new URL(file, DIR), 'utf8'));
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
      log(`applied ${file}`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${e.message}`);
    } finally {
      client.release();
    }
  }
  return applied;
}

/** Drop everything and rebuild from migrations. Used by the seed script and the tests only. */
export async function resetDatabase(pool) {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  return migrate(pool);
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/migrate.js')) {
  const pool = createPool();
  try {
    const reset = process.argv.includes('--reset');
    const applied = reset ? await resetDatabase(pool) : await migrate(pool, { log: (m) => console.log(m) });
    console.log(reset ? `Database reset; ${applied.length} migrations applied.` : applied.length ? `${applied.length} migration(s) applied.` : 'Database is up to date.');
  } finally {
    await pool.end();
  }
}
