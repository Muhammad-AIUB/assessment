// End-to-end HTTP tests: the real Express app on a random port against the test database.
// Covers what unit tests can't: authentication, role checks, input validation at the edge,
// security headers and the login throttle.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../src/db.js';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createLoginLimiter } from '../src/security.js';
import { resetDatabase } from '../scripts/migrate.js';
import { hashPassword } from '../src/services/auth.js';

let pool, server, base, limiter;

before(async () => {
  pool = createPool(config.testDatabaseUrl);
  limiter = createLoginLimiter({ max: 3 });
  server = createApp(pool, { loginLimiter: limiter }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); await pool?.end(); });

beforeEach(async () => {
  limiter.reset();
  await resetDatabase(pool);
  const h = await hashPassword('secret1');
  await pool.query(`INSERT INTO users (id, name, username, password_hash, role) VALUES (1,'Olivia','owner',$1,'owner'), (2,'Sam','staff',$1,'staff')`, [h]);
  await pool.query(`INSERT INTO suppliers (id, name, lead_time_days) VALUES (1, 'Sup', 3)`);
  await pool.query(`INSERT INTO products (id, sku, name, supplier_id, lead_time_days, sell_price) VALUES (1, 'P1', 'Paracetamol', 1, 3, 2.5)`);
  await pool.query(`INSERT INTO batches (product_id, batch_no, expiry_date, qty_received, qty_on_hand, unit_cost, received_at) VALUES (1, 'B1', '2099-12-31', 10, 10, 1.75, '2026-01-01')`);
  await pool.query(`INSERT INTO purchase_orders (id, supplier_id, status, ordered_at) VALUES (1, 1, 'ordered', now())`);
  await pool.query(`INSERT INTO po_items (po_id, product_id, qty, unit_cost) VALUES (1, 1, 5, 1.8)`);
  await pool.query(`SELECT setval('users_id_seq', 2), setval('suppliers_id_seq', 1), setval('products_id_seq', 1), setval('purchase_orders_id_seq', 1)`);
});

async function call(path, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers };
}
async function loginAs(username, password = 'secret1') {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.equal(res.status, 200, `login ${username}`);
  return res.headers.get('set-cookie').split(';')[0];
}

test('API requires a session', async () => {
  assert.equal((await call('/api/products')).status, 401);
  assert.equal((await call('/api/products', { cookie: 'ps_session=forged' })).status, 401);
});

test('session cookie is httpOnly + SameSite=Strict, and only a hash of it is stored', async () => {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'secret1' }) });
  const set = res.headers.get('set-cookie');
  assert.match(set, /HttpOnly/i);
  assert.match(set, /SameSite=Strict/i);
  const token = set.split(';')[0].split('=')[1];
  const stored = (await pool.query('SELECT token_hash FROM sessions')).rows.map((r) => r.token_hash);
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0], token);
  assert.equal(stored[0].length, 64);
});

test('logout ends the session', async () => {
  const cookie = await loginAs('owner');
  assert.equal((await call('/api/me', { cookie })).status, 200);
  await call('/api/auth/logout', { method: 'POST', cookie });
  assert.equal((await call('/api/me', { cookie })).status, 401);
});

test('wrong password → 401 with a generic message; repeated failures are throttled (429)', async () => {
  const bad = await call('/api/auth/login', { method: 'POST', body: { username: 'owner', password: 'nope' } });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error, 'Wrong username or password');
  const unknown = await call('/api/auth/login', { method: 'POST', body: { username: 'ghost', password: 'nope' } });
  assert.equal(unknown.json.error, bad.json.error, 'must not reveal whether the user exists');
  await call('/api/auth/login', { method: 'POST', body: { username: 'owner', password: 'nope' } });
  await call('/api/auth/login', { method: 'POST', body: { username: 'owner', password: 'nope' } });
  const blocked = await call('/api/auth/login', { method: 'POST', body: { username: 'owner', password: 'secret1' } });
  assert.equal(blocked.status, 429, 'even the right password is refused while throttled');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
});

test('staff cannot reach owner-only endpoints', async () => {
  const cookie = await loginAs('staff');
  for (const [method, path, body] of [
    ['GET', '/api/forecast/1'], ['GET', '/api/reorder-plan'], ['GET', '/api/model-report'], ['GET', '/api/stock-history'], ['GET', '/api/users'],
    ['POST', '/api/batches/1/write-off', { reason: 'Expired' }], ['POST', '/api/purchase-orders', { supplierId: 1, items: [{ productId: 1, qty: 1 }] }],
    ['POST', '/api/purchase-orders/1/cancel'], ['POST', '/api/products', { sku: 'X', name: 'X', leadTimeDays: 1, sellPrice: 1 }],
    ['PATCH', '/api/products/1', {}], ['POST', '/api/users', { name: 'X', username: 'xx', password: 'secret1' }],
  ]) {
    const r = await call(path, { method, body, cookie });
    assert.equal(r.status, 403, `${method} ${path} → ${r.status}`);
  }
});

test('staff never see purchase prices — in any response that carries them', async () => {
  const cookie = await loginAs('staff');
  for (const path of ['/api/batches?productId=1', '/api/purchase-orders', '/api/purchase-orders/1', '/api/products', '/api/alerts/expiry']) {
    const r = await call(path, { cookie });
    assert.equal(r.status, 200, path);
    assert.doesNotMatch(JSON.stringify(r.json), /unit_?cost/i, path);
  }
  const owner = await loginAs('owner');
  assert.match(JSON.stringify((await call('/api/batches?productId=1', { cookie: owner })).json), /unit_cost/);
});

test('staff receive at the PO price even if they send a different one', async () => {
  const cookie = await loginAs('staff');
  const po = (await call('/api/purchase-orders/1', { cookie })).json;
  const r = await call('/api/purchase-orders/1/receive', { method: 'POST', cookie, body: { lines: [{ poItemId: po.items[0].id, batchNo: 'NEW', expiry: '2099-01', qty: 5, unitCost: 0.01 }] } });
  assert.equal(r.status, 200);
  assert.equal((await pool.query(`SELECT unit_cost FROM batches WHERE batch_no = 'NEW'`)).rows[0].unit_cost, 1.8);
});

test('malformed input is a 400 with a clear message — never a 500', async () => {
  const cookie = await loginAs('owner');
  const cases = [
    ['GET', '/api/purchase-orders/abc'], ['GET', '/api/forecast/1.5'], ['GET', '/api/batches?productId=x'], ['GET', '/api/purchase-orders?status=shipped'],
    ['POST', '/api/sales', { items: 'x' }], ['POST', '/api/sales', { items: [{ productId: 1, qty: 1e9 }] }], ['POST', '/api/sales', { items: [{ productId: 'one', qty: 1 }] }],
    ['POST', '/api/sales', { items: [null] }], ['POST', '/api/sales', '{not json'],
    ['POST', '/api/products', { sku: 'S', name: 'N', leadTimeDays: 3, sellPrice: 1e20 }], ['POST', '/api/products', { sku: 'S', name: 'N', leadTimeDays: 3, sellPrice: 1.234 }],
    ['POST', '/api/products', { sku: 'S'.repeat(500), name: 'N', leadTimeDays: 3, sellPrice: 1 }], ['POST', '/api/products', { sku: 'S', name: 'N', leadTimeDays: -1, sellPrice: 1 }],
    ['POST', '/api/purchase-orders', { supplierId: 'abc', items: [{ productId: 1, qty: 1 }] }], ['POST', '/api/purchase-orders', { supplierId: 1, items: [{ productId: 1, qty: 1, unitCost: -5 }] }],
    ['POST', '/api/batches/1/write-off', { reason: '' }], ['PATCH', '/api/users/2', { active: 'yes' }], ['POST', '/api/users', { name: 'X', username: 'bad name!', password: 'secret1' }],
  ];
  for (const [method, path, body] of cases) {
    const r = await call(path, { method, body, cookie });
    assert.equal(r.status, 400, `${method} ${path} ${JSON.stringify(body)} → ${r.status} ${JSON.stringify(r.json)}`);
    assert.ok(r.json?.error && r.json.error !== 'Internal server error', path);
  }
});

test('security headers are set on pages and API; API responses are not cached', async () => {
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('x-powered-by'), null);
  assert.equal((await call('/api/products')).headers.get('cache-control'), 'no-store');
});

test('owner can edit a product; duplicate SKU is a 409', async () => {
  const cookie = await loginAs('owner');
  await call('/api/products', { method: 'POST', cookie, body: { sku: 'P2', name: 'Other', leadTimeDays: 2, sellPrice: 5 } });
  const ok = await call('/api/products/1', { method: 'PATCH', cookie, body: { sku: 'P1', name: 'Paracetamol 500', supplierId: 1, leadTimeDays: 4, minLevel: 10, sellPrice: '3.00', active: false } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.name, 'Paracetamol 500');
  assert.equal(ok.json.active, false);
  const dup = await call('/api/products/1', { method: 'PATCH', cookie, body: { sku: 'P2', name: 'x', leadTimeDays: 1, sellPrice: 1 } });
  assert.equal(dup.status, 409);
  assert.equal((await call('/api/products/999', { method: 'PATCH', cookie, body: { sku: 'Z', name: 'x', leadTimeDays: 1, sellPrice: 1 } })).status, 404);
});
