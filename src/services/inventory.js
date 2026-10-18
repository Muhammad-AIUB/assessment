import { withTransaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { batchStatus } from '../domain/batchStatus.js';
import { config } from '../config.js';
import { today } from '../dates.js';

// ---------- suppliers ----------
export async function listSuppliers(pool) {
  return (await pool.query('SELECT * FROM suppliers ORDER BY name')).rows;
}

export async function createSupplier(pool, { name, phone, leadTimeDays }) {
  if (!name?.trim()) throw badRequest('Supplier name is required');
  const lead = Number(leadTimeDays ?? 3);
  if (!Number.isInteger(lead) || lead < 0) throw badRequest('Lead time must be a whole number of days ≥ 0');
  try {
    return (await pool.query('INSERT INTO suppliers (name, phone, lead_time_days) VALUES ($1, $2, $3) RETURNING *',
      [name.trim(), phone?.trim() || null, lead])).rows[0];
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

export async function createProduct(pool, b) {
  const sku = b.sku?.trim(), name = b.name?.trim();
  if (!sku || !name) throw badRequest('SKU and name are required');
  const lead = Number(b.leadTimeDays), min = Number(b.minLevel ?? 0), price = Number(b.sellPrice), review = Number(b.reviewPeriodDays ?? 7);
  if (!Number.isInteger(lead) || lead < 0) throw badRequest('Lead time must be a whole number of days ≥ 0');
  if (!Number.isInteger(min) || min < 0) throw badRequest('Minimum level must be a whole number ≥ 0');
  if (!Number.isInteger(review) || review <= 0) throw badRequest('Review period must be ≥ 1 day');
  if (!(price >= 0)) throw badRequest('Sell price must be ≥ 0');
  try {
    return (await pool.query(
      `INSERT INTO products (sku, name, unit, supplier_id, lead_time_days, review_period_days, min_level, sell_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [sku, name, b.unit?.trim() || 'pcs', b.supplierId || null, lead, review, min, price])).rows[0];
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
  if (!reason?.trim() || reason.trim().length < 3) throw badRequest('A write-off reason is required');
  return withTransaction(pool, async (c) => {
    const b = (await c.query('SELECT * FROM batches WHERE id = $1 FOR UPDATE', [batchId])).rows[0];
    if (!b) throw notFound('Batch not found');
    if (b.state === 'written_off') throw conflict('Batch is already written off');
    if (b.qty_on_hand > 0) {
      await c.query(`INSERT INTO stock_movements (batch_id, product_id, type, qty, reason, user_id, movement_date)
                     VALUES ($1, $2, 'write_off', $3, $4, $5, $6)`, [b.id, b.product_id, -b.qty_on_hand, reason.trim(), userId, day]);
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
