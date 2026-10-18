// Integration tests against a real PostgreSQL (TEST_DATABASE_URL). Row locking and transaction
// rollback can only be proven against the real database, not a mock.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../src/db.js';
import { config } from '../src/config.js';
import { migrate } from '../scripts/migrate.js';
import { createSale } from '../src/services/sales.js';
import { writeOffBatch, listProducts } from '../src/services/inventory.js';
import { createPurchaseOrder, placeOrder, receiveOrder, cancelOrder } from '../src/services/purchasing.js';
import { draftPoFromRecommendation, productForecast } from '../src/services/forecasting.js';
import { hashPassword } from '../src/services/auth.js';
import { addDays } from '../src/dates.js';

const TODAY = '2026-10-18';
let pool;

before(async () => {
  pool = createPool(config.testDatabaseUrl);
  await pool.query('SELECT 1').catch((e) => {
    throw new Error(`Test database unreachable (${config.testDatabaseUrl}). Run "npm run db:up". ${e.message}`);
  });
});
after(() => pool?.end());

beforeEach(async () => {
  await migrate(pool);
  const h = await hashPassword('secret1');
  await pool.query(`INSERT INTO users (id, name, username, password_hash, role) VALUES (1,'O','o',$1,'owner'), (2,'S','s',$1,'staff')`, [h]);
  await pool.query(`INSERT INTO suppliers (id, name, lead_time_days) VALUES (1, 'Sup', 3)`);
  await pool.query(`INSERT INTO products (id, sku, name, supplier_id, lead_time_days, min_level, sell_price) VALUES
    (1, 'P1', 'Paracetamol', 1, 3, 5, 2.5), (2, 'P2', 'Omeprazole', 1, 3, 0, 6)`);
  await pool.query(`SELECT setval('users_id_seq', 2), setval('suppliers_id_seq', 1), setval('products_id_seq', 2)`);
});

async function addBatch(productId, batchNo, expiry, qty) {
  const { rows } = await pool.query(
    `INSERT INTO batches (product_id, batch_no, expiry_date, qty_received, qty_on_hand, unit_cost, received_at)
     VALUES ($1, $2, $3, $4, $4, 1, $5) RETURNING id`, [productId, batchNo, expiry, qty, addDays(TODAY, -30)]);
  return rows[0].id;
}
const onHand = async (id) => (await pool.query('SELECT qty_on_hand FROM batches WHERE id = $1', [id])).rows[0].qty_on_hand;

test('sale draws FEFO across several batches and skips expired stock', async () => {
  const expired = await addBatch(1, 'OLD', '2026-10-17', 3);
  const late = await addBatch(1, 'LATE', '2027-06-30', 10);
  const soon = await addBatch(1, 'SOON', '2026-11-30', 4);

  const sale = await createSale(pool, 2, { items: [{ productId: 1, qty: 6 }] }, TODAY);
  assert.deepEqual(sale.lines.map((l) => [l.batchNo, l.qty]), [['SOON', 4], ['LATE', 2]]);
  assert.equal(sale.total, 15);
  assert.equal(await onHand(soon), 0);
  assert.equal(await onHand(late), 8);
  assert.equal(await onHand(expired), 3, 'expired stock must not be sold');

  const moves = (await pool.query(`SELECT batch_id, qty FROM stock_movements WHERE type = 'sale' ORDER BY id`)).rows;
  assert.deepEqual(moves, [{ batch_id: soon, qty: -4 }, { batch_id: late, qty: -2 }]);
});

test('insufficient stock → clear Bengali error, and nothing is written (atomic)', async () => {
  await addBatch(1, 'OLD', '2026-09-30', 3);
  const good = await addBatch(1, 'OK', '2027-01-31', 5);
  const other = await addBatch(2, 'O2', '2027-01-31', 10);

  await assert.rejects(
    createSale(pool, 2, { items: [{ productId: 2, qty: 2 }, { productId: 1, qty: 6 }] }, TODAY),
    (e) => e.status === 409 && e.message === 'Paracetamol: বিক্রয়যোগ্য stock 5 (3টা মেয়াদোত্তীর্ণ বাদ)'
      && e.details.sellable === 5 && e.details.expiredQty === 3);

  // Product 2 was processed first inside the same transaction — it must be rolled back too.
  assert.equal(await onHand(other), 10);
  assert.equal(await onHand(good), 5);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM sales')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM stock_movements')).rows[0].n, 0);
});

test('concurrent sales never oversell: two clerks race for the last units', async () => {
  const id = await addBatch(1, 'B', '2027-01-31', 10);
  const results = await Promise.allSettled([
    createSale(pool, 2, { items: [{ productId: 1, qty: 6 }] }, TODAY),
    createSale(pool, 1, { items: [{ productId: 1, qty: 6 }] }, TODAY),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const failed = results.find((r) => r.status === 'rejected');
  assert.match(failed.reason.message, /বিক্রয়যোগ্য stock 4/);
  assert.equal(await onHand(id), 4);
});

test('many concurrent single-unit sales sell exactly the stock available', async () => {
  const a = await addBatch(1, 'A', '2026-12-31', 4);
  const b = await addBatch(1, 'B', '2027-03-31', 4);
  const results = await Promise.allSettled(
    Array.from({ length: 15 }, () => createSale(pool, 2, { items: [{ productId: 1, qty: 1 }] }, TODAY)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 8);
  assert.equal(await onHand(a), 0);
  assert.equal(await onHand(b), 0);
  const sold = (await pool.query('SELECT SUM(qty)::int AS q FROM sale_lines')).rows[0].q;
  assert.equal(sold, 8);
});

test('sale input validation', async () => {
  await assert.rejects(createSale(pool, 2, { items: [] }, TODAY), { status: 400 });
  await assert.rejects(createSale(pool, 2, { items: [{ productId: 1, qty: 0 }] }, TODAY), { status: 400 });
  await assert.rejects(createSale(pool, 2, { items: [{ productId: 1, qty: 2.5 }] }, TODAY), { status: 400 });
  await assert.rejects(createSale(pool, 2, { items: [{ productId: 999, qty: 1 }] }, TODAY), { status: 404 });
});

test('purchase order lifecycle: draft → ordered → received creates one batch per line with month-end expiry', async () => {
  const po = await createPurchaseOrder(pool, 1, { supplierId: 1, items: [{ productId: 1, qty: 50, unitCost: 1.8 }, { productId: 2, qty: 20, unitCost: 4 }] });
  assert.equal(po.status, 'draft');
  await assert.rejects(receiveOrder(pool, 2, po.id, { lines: [] }, { canSetCost: false }, TODAY), { status: 400 });
  const ordered = await placeOrder(pool, po.id);
  assert.equal(ordered.status, 'ordered');

  // On-order counts toward the stock position used by reorder
  assert.equal((await listProducts(pool, TODAY)).find((p) => p.id === 1).on_order, 50);

  const [i1, i2] = [ordered.items.find((i) => i.productId === 1), ordered.items.find((i) => i.productId === 2)];
  const res = await receiveOrder(pool, 2, po.id, { lines: [
    { poItemId: i1.id, batchNo: 'X1', expiry: '2027-02', qty: 30, unitCost: 999 },   // staff cannot override cost
    { poItemId: i1.id, batchNo: 'X2', expiry: '03/2027', qty: 20 },
    { poItemId: i2.id, batchNo: 'Y1', expiry: '2027-12', qty: 20 },
  ] }, { canSetCost: false }, TODAY);

  assert.equal(res.order.status, 'received');
  assert.deepEqual(res.batches.map((b) => [b.batch_no, b.expiry_date, b.qty_received]),
    [['X1', '2027-02-28', 30], ['X2', '2027-03-31', 20], ['Y1', '2027-12-31', 20]]);
  const costs = (await pool.query(`SELECT batch_no, unit_cost FROM batches ORDER BY id`)).rows;
  assert.deepEqual(costs, [{ batch_no: 'X1', unit_cost: 1.8 }, { batch_no: 'X2', unit_cost: 1.8 }, { batch_no: 'Y1', unit_cost: 4 }]);
  assert.equal((await listProducts(pool, TODAY)).find((p) => p.id === 1).on_order, 0);
  await assert.rejects(cancelOrder(pool, po.id), { status: 409 }); // received is terminal
});

test('receiving rejects over-delivery and already-expired batches', async () => {
  const po = await placeOrder(pool, (await createPurchaseOrder(pool, 1, { supplierId: 1, items: [{ productId: 1, qty: 10, unitCost: 2 }] })).id);
  const item = po.items[0];
  await assert.rejects(receiveOrder(pool, 2, po.id, { lines: [{ poItemId: item.id, batchNo: 'A', expiry: '2027-01', qty: 11 }] }, { canSetCost: false }, TODAY),
    /only 10 were ordered/);
  await assert.rejects(receiveOrder(pool, 2, po.id, { lines: [{ poItemId: item.id, batchNo: 'A', expiry: '2026-09', qty: 5 }] }, { canSetCost: false }, TODAY),
    /already expired/);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM batches')).rows[0].n, 0);
});

test('cannot place an order with a missing unit cost; cancelled orders stay cancelled', async () => {
  const po = await createPurchaseOrder(pool, 1, { supplierId: 1, items: [{ productId: 1, qty: 10 }] });
  await assert.rejects(placeOrder(pool, po.id), /unit cost/);
  assert.equal((await cancelOrder(pool, po.id)).status, 'cancelled');
  await assert.rejects(placeOrder(pool, po.id), { status: 409 });
});

test('write-off zeroes the batch and is recorded with its reason', async () => {
  const id = await addBatch(1, 'EXP', '2026-09-30', 7);
  await assert.rejects(writeOffBatch(pool, 1, id, ''), { status: 400 });
  const r = await writeOffBatch(pool, 1, id, 'Expired on shelf', TODAY);
  assert.equal(r.writtenOffQty, 7);
  const m = (await pool.query(`SELECT type, qty, reason FROM stock_movements WHERE batch_id = $1`, [id])).rows;
  assert.deepEqual(m, [{ type: 'write_off', qty: -7, reason: 'Expired on shelf' }]);
  await assert.rejects(writeOffBatch(pool, 1, id, 'again'), { status: 409 });
});

test('forecast → reorder → Draft PO end to end', async () => {
  // 60 days of steady sales of 10/day, then 12 usable units on hand and 3 expired.
  const batch = await addBatch(1, 'HIST', '2027-12-31', 600);
  for (let d = 60; d >= 1; d--) {
    const s = (await pool.query('INSERT INTO sales (user_id, sale_date) VALUES (2, $1) RETURNING id', [addDays(TODAY, -d)])).rows[0];
    await pool.query('INSERT INTO sale_lines (sale_id, product_id, batch_id, qty, unit_price) VALUES ($1, 1, $2, 10, 2.5)', [s.id, batch]);
  }
  await pool.query('UPDATE batches SET qty_on_hand = 12 WHERE id = $1', [batch]);
  await addBatch(1, 'DEAD', '2026-10-01', 3);

  const f = await productForecast(pool, 1, TODAY);
  assert.equal(f.model.method, 'seasonal_es');
  assert.equal(f.stock.usable, 12);
  assert.equal(f.stock.expired, 3);
  assert.equal(f.forecast.length, 14);
  f.forecast.forEach((p) => assert.ok(Math.abs(p.qty - 10) < 0.01));
  // (3 lead + 7 review) × 10 = 100 demand, σ = 0 → safety 0, minus 12 usable = 88
  assert.equal(f.reorder.quantity, 88);

  const po = await draftPoFromRecommendation(pool, 1, 1, TODAY);
  assert.equal(po.status, 'draft');
  assert.deepEqual(po.items.map((i) => [i.productId, i.qty]), [[1, 88]]);
});
