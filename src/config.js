import { readFileSync, existsSync } from 'node:fs';

// Minimal .env loader (avoids a dependency for a handful of variables).
const envPath = new URL('../.env', import.meta.url);
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://pharma:pharma@localhost:5433/pharmastock',
  testDatabaseUrl: process.env.TEST_DATABASE_URL ?? 'postgres://pharma:pharma@localhost:5433/pharmastock_test',
  port: Number(process.env.PORT ?? 3000),
  tz: process.env.APP_TZ ?? 'Asia/Dhaka',
  fixedToday: process.env.APP_TODAY || null,
  nearExpiryDays: Number(process.env.NEAR_EXPIRY_DAYS ?? 60),
};
