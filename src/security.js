// HTTP hardening: security headers and a login throttle. No dependencies.

/**
 * Content-Security-Policy etc. Scripts only from this origin + the pinned Chart.js CDN;
 * no inline scripts or event handlers. Inline style attributes are allowed (used for bar widths).
 */
export function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store'); // never cache stock/cost data
  next();
}

/**
 * Login throttle: after `max` failed attempts for the same username (or from the same IP) within
 * `windowMs`, further attempts get 429 until the window passes. A success clears the username's count.
 * In-memory — fine for a single-instance shop app; use Redis or similar if you run several instances.
 */
export function createLoginLimiter({ max = 5, windowMs = 15 * 60_000, now = () => Date.now() } = {}) {
  const hits = new Map(); // key -> { count, resetAt }
  const keyFor = (req) => [`ip:${req.ip}`, `user:${String(req.body?.username ?? '').trim().toLowerCase()}`];
  const live = (key) => {
    const h = hits.get(key);
    if (h && h.resetAt <= now()) { hits.delete(key); return null; }
    return h;
  };
  return {
    check(req, res) {
      for (const key of keyFor(req)) {
        const h = live(key);
        // IPs get more room than a single username (several staff may share the shop's network).
        const limit = key.startsWith('ip:') ? max * 4 : max;
        if (h && h.count >= limit) {
          const retry = Math.ceil((h.resetAt - now()) / 1000);
          res.setHeader('Retry-After', String(retry));
          return `Too many failed logins. Try again in ${Math.ceil(retry / 60)} minute${retry > 60 ? 's' : ''}.`;
        }
      }
      return null;
    },
    fail(req) {
      for (const key of keyFor(req)) {
        const h = live(key) ?? { count: 0, resetAt: now() + windowMs };
        h.count++;
        hits.set(key, h);
      }
    },
    succeed(req) { hits.delete(keyFor(req)[1]); },
    reset() { hits.clear(); },
  };
}
