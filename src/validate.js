// Input validation helpers. Every value from a request goes through one of these before it
// reaches SQL, so bad input becomes a clear 400 — never a database error or a 500.
import { badRequest } from './errors.js';

export const LIMITS = Object.freeze({
  qty: 100_000,             // units in one sale / order line
  price: 9_999_999.99,      // fits NUMERIC(10,2)
  days: 365,                // lead time / review period
  text: 200,                // names, notes, reasons
  lines: 100,               // lines per sale / order
});

/** Whole number in [min, max]. Accepts numeric strings ("12"), rejects "1e3", 1.5, NaN. */
export function int(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER, optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  const n = typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : value;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw badRequest(`${label} must be a whole number${max < Number.MAX_SAFE_INTEGER ? ` from ${min} to ${max.toLocaleString('en')}` : min > 0 ? ` of at least ${min}` : ''}`);
  }
  return n;
}

export const id = (value, label = 'ID') => int(value, label, { min: 1, max: 2_147_483_647 });

/** Money amount with at most 2 decimals. */
export function money(value, label, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > LIMITS.price) throw badRequest(`${label} must be an amount from 0 to ${LIMITS.price.toLocaleString('en')}`);
  if (Math.round(n * 100) / 100 !== n) throw badRequest(`${label} can have at most 2 decimal places`);
  return n;
}

/** Trimmed string, required unless optional, capped length. */
export function text(value, label, { optional = false, max = LIMITS.text, min = 1 } = {}) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    if (optional) return null;
    throw badRequest(`${label} is required`);
  }
  if (typeof value !== 'string') throw badRequest(`${label} must be text`);
  const s = value.trim();
  if (s.length < min) throw badRequest(`${label} must be at least ${min} characters`);
  if (s.length > max) throw badRequest(`${label} must be at most ${max} characters`);
  return s;
}

export function list(value, label, { max = LIMITS.lines } = {}) {
  if (!Array.isArray(value) || value.length === 0) throw badRequest(`${label} must have at least one entry`);
  if (value.length > max) throw badRequest(`${label} can have at most ${max} entries`);
  return value;
}

export function oneOf(value, label, allowed) {
  if (!allowed.includes(value)) throw badRequest(`${label} must be one of: ${allowed.join(', ')}`);
  return value;
}
