import { readFileSync } from 'node:fs';
import { createPool } from '../src/db.js';

export async function migrate(pool) {
  const sql = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/migrate.js')) {
  const pool = createPool();
  try {
    await migrate(pool);
    console.log('Schema applied (all data dropped). Run `npm run seed` for demo data.');
  } finally {
    await pool.end();
  }
}
