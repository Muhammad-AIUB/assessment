// Shared state, API client and formatting helpers.

export const state = { user: null, today: null, charts: [], routeSeq: 0 };
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const isOwner = () => state.user?.role === 'owner';

// ---------- safe HTML templating ----------
// html`` escapes every interpolated value unless it is wrapped in raw(). Nested html`` results
// and arrays of them are already-safe markup, so they are passed through untouched.
const SAFE = Symbol('safe');
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const raw = (s) => ({ [SAFE]: true, value: String(s ?? '') });
function piece(v) {
  if (v === null || v === undefined || v === false) return '';
  if (Array.isArray(v)) return v.map(piece).join('');
  if (typeof v === 'object' && v[SAFE]) return v.value;
  return esc(v);
}
export function html(strings, ...vals) {
  return raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? piece(vals[i]) : ''), ''));
}
/** Render an html`` result into an element. */
export const render = (el, tpl) => { el.innerHTML = piece(tpl); return el; };

// ---------- formatting ----------
export const num = (x, d = 0) => (x === null || x === undefined ? '–' : Number(x).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const n2 = (x) => num(x, 2);
export const pct = (x) => (x === null || x === undefined ? '–' : `${(x * 100).toFixed(1)}%`);
export const money = (x) => `৳${num(x, 2)}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtDate = (iso) => (iso ? `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : '–');
export const fmtMonth = (iso) => (iso ? `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : '–');
export function relDays(days) {
  if (days === null || days === undefined) return '';
  if (days < -1) return `expired ${-days} days ago`;
  if (days === -1) return 'expired yesterday';
  if (days === 0) return 'expires today';
  if (days === 1) return 'expires tomorrow';
  if (days < 60) return `${days} days left`;
  if (days < 365) return `${Math.round(days / 30)} months left`;
  return `${(days / 365).toFixed(1)} years left`;
}
export const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

// ---------- API ----------
export class ApiError extends Error {
  constructor(message, status, details) { super(message); this.status = status; this.details = details; }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

/**
 * fetch wrapper. GET responses that arrive after the user has navigated away are dropped
 * (a silent "stale" error) so a slow page can never overwrite the page now on screen.
 */
export async function api(path, opts = {}) {
  const seq = state.routeSeq;
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method ?? 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError('Cannot reach the server. Check the connection and try again.', 0);
  }
  const data = res.status === 204 ? null : await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/auth/login') { onUnauthorized(); throw new ApiError('Your session has ended — please log in again.', 401); }
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status, data.details);
  if (seq !== state.routeSeq && !opts.method) throw Object.assign(new Error('stale'), { stale: true });
  return data;
}
