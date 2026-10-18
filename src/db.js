import pg from 'pg';
import { config } from './config.js';

// DATE columns come back as plain 'YYYY-MM-DD' strings, never JS Dates (avoids TZ shifts).
pg.types.setTypeParser(1082, (v) => v);
// NUMERIC -> number (prices are small, 2dp) and BIGINT counts -> number.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => Number(v));

export function createPool(url = config.databaseUrl) {
  return new pg.Pool({ connectionString: url, max: 10 });
}

/** Run fn(client) inside a transaction; rolls back on any throw. */
export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
