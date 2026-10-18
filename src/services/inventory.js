import { withTransaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { batchStatus } from '../domain/batchStatus.js';
import { config } from '../config.js';
import { today } from '../dates.js';
import { id, int, money, text, LIMITS } from '../validate.js';

// ---------- suppliers ----------
export async function listSuppliers(pool) {
  return (await pool.query('SELECT * FROM suppliers ORDER BY name')).rows;
}

export async function createSupplier(pool, { name, phone, leadTimeDays } = {}) {
  name = text(name, 'Supplier name', { max: 120 });
  phone = text(phone, 'Phone', { optional: true, max: 30 });
  const lead = int(leadTimeDays ?? 3, 'Lead time (days)', { max: LIMITS.days });
  try {
    return (await pool.query('INSERT INTO suppliers (name, phone, lead_time_days) VALUES ($1, $2, $3) RETURNING *',
      [name, phone, lead])).rows[0];
  } catch (e) {
    if (e.code === '23505') throw conflict('A supplier with this name already exists');
    throw e;
  }
}

// ---------- products ----------
/**
 * Products with live stock figures. `usable` excludes expired and written-off stock;
 * `onOrder` is quantity on Ordered (in-transit) purchase orders.
 */
export async function listProducts(pool, day = today()) {
  const { rows } = await pool.query(
    `SELECT p.*, s.name AS supplier_name,
       COALESCE(SUM(b.qty_on_hand) FILTER (WHERE b.state = 'active' AND b.expiry_date >= $1), 0)::INT AS usable,
       COALESCE(SUM(b.qty_on_hand) FILTER (WHERE b.state = 'active' AND b.expiry_date <  $1), 0)::INT AS expired,
       COALESCE(SUM(b.qty_on_hand) FILTER (WHERE b.state = 'active' AND b.expiry_date >= $1 AND b.expiry_date <= $1::date + $2::int), 0)::INT AS near_expiry,
       MIN(b.expiry_date) FILTER (WHERE b.state = 'active' AND b.expiry_date >= $1) AS next_expiry,
       COALESCE((SELECT SUM(pi.qty) FROM po_items pi JOIN purchase_orders po ON po.id = pi.po_id
                 WHERE pi.product_id = p.id AND po.status = 'ordered'), 0)::INT AS on_order,
       COALESCE((SELECT SUM(ds.qty) FROM daily_sales ds
                 WHERE ds.product_id = p.id AND ds.day > $1::date - 30), 0)::INT AS sold_30d
     FROM products p
     LEFT JOIN suppliers s ON s.id = p.supplier_id
     LEFT JOIN batches b ON b.product_id = p.id AND b.qty_on_hand > 0
     GROUP BY p.id, s.name
     ORDER BY p.name`, [day, config.nearExpiryDays]);
  return rows.map((r) => ({ ...r, below_min: r.usable < r.min_level }));
}

export async function getProduct(pool, id) {
  const p = (await pool.query('SELECT * FROM products WHERE id = $1', [id])).rows[0];
  if (!p) throw notFound('Product not found');
  return p;
}

/** Validate and normalise product fields (shared by create and update). */
function productFields(b = {}) {
  return {
    sku: text(b.sku, 'SKU', { max: 40 }),
    name: text(b.name, 'Product name', { max: 120 }),
    unit: text(b.unit, 'Unit', { optional: true, max: 20 }) ?? 'pcs',
    supplierId: b.supplierId === undefined || b.supplierId === null || b.supplierId === '' ? null : id(b.supplierId, 'Supplier'),
    lead: int(b.leadTimeDays, 'Lead time (days)', { max: LIMITS.days }),
    review: int(b.reviewPeriodDays ?? 7, 'Review period (days)', { min: 1, max: LIMITS.days }),
    min: int(b.minLevel ?? 0, 'Minimum level', { max: LIMITS.qty }),
    price: money(b.sellPrice, 'Sell price'),
  };
}

export async function updateProduct(pool, productId, b) {
  const p = productFields(b);
  const active = b.active === undefined ? true : Boolean(b.active);
  try {
    const { rows } = await pool.query(
      `UPDATE products SET sku = $2, name = $3, unit = $4, supplier_id = $5, lead_time_days = $6, review_period_days = $7,
         min_level = $8, sell_price = $9, active = $10 WHERE id = $1 RETURNING *`,
      [productId, p.sku, p.name, p.unit, p.supplierId, p.lead, p.review, p.min, p.price, active]);
    if (!rows[0]) throw notFound('Product not found');
    return rows[0];
  } catch (e) {
    if (e.code === '23505') throw conflict('SKU already exists');
    if (e.code === '23503') throw badRequest('Unknown supplier');
    throw e;
  }
}

export async function updateSupplier(pool, supplierId, { name, phone, leadTimeDays } = {}) {
  name = text(name, 'Supplier name', { max: 120 });
  phone = text(phone, 'Phone', { optional: true, max: 30 });
  const lead = int(leadTimeDays, 'Lead time (days)', { max: LIMITS.days });
  try {
    const { rows } = await pool.query('UPDATE suppliers SET name = $2, phone = $3, lead_time_days = $4 WHERE id = $1 RETURNING *', [supplierId, name, phone, lead]);
    if (!rows[0]) throw notFound('Supplier not found');
    return rows[0];
  } catch (e) {
    if (e.code === '23505') throw conflict('A supplier with this name already exists');
    throw e;
  }
}

export async function createProduct(pool, b) {
  const p = productFields(b);
  try {
    return (await pool.query(
      `INSERT INTO products (sku, name, unit, supplier_id, lead_time_days, review_period_days, min_level, sell_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [p.sku, p.name, p.unit, p.supplierId, p.lead, p.review, p.min, p.price])).rows[0];
  } catch (e) {
    if (e.code === '23505') throw conflict('SKU already exists');
    if (e.code === '23503') throw badRequest('Unknown supplier');
    throw e;
  }
}

// ---------- batches & expiry ----------
export async function listBatches(pool, { productId, includeEmpty = false } = {}, day = today()) {
  const { rows } = await pool.query(
    `SELECT b.*, p.name AS product_name, p.sku, (b.expiry_date - $1::date) AS days_left
     FROM batches b JOIN products p ON p.id = b.product_id
     WHERE ($2::int IS NULL OR b.product_id = $2) AND ($3 OR b.qty_on_hand > 0 OR b.state = 'written_off')
     ORDER BY b.expiry_date, b.id`, [day, productId ?? null, includeEmpty]);
  return rows.map((b) => ({ ...b, status: batchStatus(b, day, config.nearExpiryDays) }));
}

/** Expiry watch list: expired-but-on-shelf and near-expiry batches. */
export async function expiryAlerts(pool, day = today()) {
  const batches = await listBatches(pool, {}, day);
  return batches.filter((b) => b.status === 'expired' || b.status === 'near_expiry');
}

/** Owner removes a batch from stock with a mandatory reason; recorded in stock history. */
export async function writeOffBatch(pool, userId, batchId, reason, day = today()) {
  reason = text(reason, 'Write-off reason', { min: 3 });
  return withTransaction(pool, async (c) => {
    const b = (await c.query('SELECT * FROM batches WHERE id = $1 FOR UPDATE', [batchId])).rows[0];
    if (!b) throw notFound('Batch not found');
    if (b.state === 'written_off') throw conflict('Batch is already written off');
    if (b.qty_on_hand > 0) {
      await c.query(`INSERT INTO stock_movements (batch_id, product_id, type, qty, reason, user_id, movement_date)
                     VALUES ($1, $2, 'write_off', $3, $4, $5, $6)`, [b.id, b.product_id, -b.qty_on_hand, reason, userId, day]);
    }
    const updated = (await c.query(`UPDATE batches SET state = 'written_off', qty_on_hand = 0 WHERE id = $1 RETURNING *`, [b.id])).rows[0];
    return { ...updated, writtenOffQty: b.qty_on_hand };
  });
}

export async function stockHistory(pool, { productId, limit = 200 } = {}) {
  const { rows } = await pool.query(
    `SELECT m.*, p.name AS product_name, b.batch_no, u.name AS user_name
     FROM stock_movements m JOIN products p ON p.id = m.product_id JOIN batches b ON b.id = m.batch_id
     LEFT JOIN users u ON u.id = m.user_id
     WHERE ($1::int IS NULL OR m.product_id = $1)
     ORDER BY m.id DESC LIMIT $2`, [productId ?? null, limit]);
  return rows;
}
