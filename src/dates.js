// Calendar-date helpers. Business dates are 'YYYY-MM-DD' strings and all arithmetic is done
// in UTC, so day maths never drifts with DST or with the server's own timezone.
import { config } from './config.js';

const DAY_MS = 86_400_000;

/** The shop's current calendar date (APP_TZ), or APP_TODAY when frozen for demos/tests. */
export function today() {
  if (config.fixedToday) return config.fixedToday;
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.tz }).format(new Date());
}

export const toUtc = (iso) => Date.parse(`${iso}T00:00:00Z`);
export const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (iso, n) => fromUtc(toUtc(iso) + n * DAY_MS);
/** a − b in whole days */
export const diffDays = (a, b) => Math.round((toUtc(a) - toUtc(b)) / DAY_MS);
/** 0 = Monday … 6 = Sunday */
export const weekday = (iso) => (new Date(toUtc(iso)).getUTCDay() + 6) % 7;

/**
 * Packets print expiry as MM/YYYY; the medicine is valid until the last day of that month.
 * Accepts 'YYYY-MM', 'MM/YYYY', or a full 'YYYY-MM-DD' (kept as is).
 */
export function parseExpiry(input) {
  const s = String(input ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    if (Number.isNaN(toUtc(s)) || fromUtc(toUtc(s)) !== s) throw new Error(`Invalid expiry date: ${s}`);
    return s;
  }
  let y, m, match;
  if ((match = s.match(/^(\d{4})-(\d{1,2})$/))) [, y, m] = match;
  else if ((match = s.match(/^(\d{1,2})\/(\d{4})$/))) [, m, y] = match;
  else throw new Error(`Invalid expiry "${s}" — use YYYY-MM or MM/YYYY`);
  y = Number(y);
  m = Number(m);
  if (m < 1 || m > 12) throw new Error(`Invalid expiry month in "${s}"`);
  return fromUtc(Date.UTC(y, m, 0)); // day 0 of the next month = last day of this month
}
