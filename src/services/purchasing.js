import { withTransaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { parseExpiry, today } from '../dates.js';
import { id, int, money, text, list, LIMITS } from '../validate.js';

// Allowed state transitions. Received and Cancelled are terminal.
const TRANSITIONS = {
  draft: ['ordered', 'cancelled'],
  ordered: ['received', 'cancelled'],
  received: [],
  cancelled: [],
};
export const canTransition = (from, to) => TRANSITIONS[from]?.includes(to) ?? false;

const PO_SELECT = `
  SELECT po.*, s.name AS supplier_name, s.lead_time_days,
    COALESCE(json_agg(json_build_object('id', pi.id, 'productId', pi.product_id, 'productName', p.name, 'sku', p.sku,
              'qty', pi.qty, 'unitCost', pi.unit_cost) ORDER BY p.name) FILTER (WHERE pi.id IS NOT NULL), '[]') AS items
  FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
  LEFT JOIN po_items pi ON pi.po_id = po.id LEFT JOIN products p ON p.id = pi.product_id`;

export async function listPurchaseOrders(pool, { status } = {}) {
  const { rows } = await pool.query(
    `${PO_SELECT}
     WHERE ($1::po_status IS NULL OR po.status = $1)
     GROUP BY po.id, s.id
     ORDER BY CASE po.status WHEN 'draft' THEN 0 WHEN 'ordered' THEN 1 ELSE 2 END, po.id DESC
     LIMIT 1000`, [status ?? null]);
  return rows;
}

export async function getPurchaseOrder(pool, id) {
  const { rows } = await pool.query(`${PO_SELECT} WHERE po.id = $1 GROUP BY po.id, s.id`, [id]);
  if (!rows[0]) throw notFound('Purchase order not found');
  return rows[0];
}

function validateItems(items) {
  list(items, 'Order items');
  const seen = new Set();
  return items.map((it) => {
    const productId = id(it?.productId, 'Product');
    const qty = int(it?.qty, 'Quantity', { min: 1, max: LIMITS.qty });
    const unitCost = money(it?.unitCost, 'Unit cost', { optional: true });
    if (seen.has(productId)) throw badRequest('Each product may appear only once per order');
    seen.add(productId);
    return { productId, qty, unitCost };
  });
}

export async function createPurchaseOrder(pool, userId, { supplierId, note, items }) {
  const clean = validateItems(items);
  return withTransaction(pool, async (c) => {
    const sup = (await c.query('SELECT id FROM suppliers WHERE id = $1', [id(supplierId, 'Supplier')])).rows[0];
    if (!sup) throw badRequest('Unknown supplier');
    const po = (await c.query(`INSERT INTO purchase_orders (supplier_id, note, created_by) VALUES ($1, $2, $3) RETURNING id`,
      [sup.id, text(note, 'Note', { optional: true }), userId])).rows[0];
    for (const it of clean) {
      await c.query('INSERT INTO po_items (po_id, product_id, qty, unit_cost) VALUES ($1, $2, $3, $4)',
        [po.id, it.productId, it.qty, it.unitCost]).catch((e) => {
        if (e.code === '23503') throw badRequest(`Unknown product ${it.productId}`);
        throw e;
      });
    }
    return po.id;
  }).then((id) => getPurchaseOrder(pool, id));
}

/** Replace the items of a Draft PO (only drafts are editable). */
export async function updateDraftItems(pool, poId, items) {
  const clean = validateItems(items);
  await withTransaction(pool, async (c) => {
    const po = (await c.query('SELECT status FROM purchase_orders WHERE id = $1 FOR UPDATE', [poId])).rows[0];
    if (!po) throw notFound('Purchase order not found');
    if (po.status !== 'draft') throw conflict('Only draft orders can be edited');
    await c.query('DELETE FROM po_items WHERE po_id = $1', [poId]);
    for (const it of clean) {
      await c.query('INSERT INTO po_items (po_id, product_id, qty, unit_cost) VALUES ($1, $2, $3, $4)', [poId, it.productId, it.qty, it.unitCost]);
    }
  });
  return getPurchaseOrder(pool, poId);
}

async function transition(pool, poId, to, stampColumn) {
  return withTransaction(pool, async (c) => {
    const po = (await c.query('SELECT status FROM purchase_orders WHERE id = $1 FOR UPDATE', [poId])).rows[0];
    if (!po) throw notFound('Purchase order not found');
    if (!canTransition(po.status, to)) throw conflict(`Cannot change a ${po.status} order to ${to}`);
    if (to === 'ordered') {
      const missing = (await c.query('SELECT COUNT(*)::int AS n FROM po_items WHERE po_id = $1 AND unit_cost IS NULL', [poId])).rows[0].n;
      if (missing) throw badRequest('Set a unit cost on every item before placing the order');
    }
    await c.query(`UPDATE purchase_orders SET status = $2, ${stampColumn} = now() WHERE id = $1`, [poId, to]);
  }).then(() => getPurchaseOrder(pool, poId));
}

export const placeOrder = (pool, poId) => transition(pool, poId, 'ordered', 'ordered_at');
export const cancelOrder = (pool, poId) => transition(pool, poId, 'cancelled', 'cancelled_at');

/**
 * Receive an Ordered PO. Each line becomes its own batch (its own stock) with batch no, expiry
 * and purchase cost. An item may be split over several batches (e.g. two batch numbers in one
 * delivery). Received quantity per item may be less than ordered (short delivery) but not more.
 *
 * unitCost is optional: staff never see purchase prices, so when omitted it is taken from the PO
 * item (set by the owner when ordering). Owners may override it with the invoice price.
 *
 * @param {{ lines: {poItemId, batchNo, expiry, qty, unitCost?}[] }} input
 */
export async function receiveOrder(pool, userId, poId, { lines }, { canSetCost }, day = today()) {
  list(lines, 'Received lines');
  return withTransaction(pool, async (c) => {
    const po = (await c.query('SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE', [poId])).rows[0];
    if (!po) throw notFound('Purchase order not found');
    if (!canTransition(po.status, 'received')) throw conflict(`Cannot receive a ${po.status} order`);
    const items = new Map((await c.query('SELECT * FROM po_items WHERE po_id = $1', [poId])).rows.map((i) => [i.id, i]));

    const receivedPerItem = new Map();
    const created = [];
    for (const [i, l] of lines.entries()) {
      const where = `Line ${i + 1}`;
      const item = items.get(Number(l?.poItemId));
      if (!item) throw badRequest(`${where}: item does not belong to this order`);
      let batchNo;
      try { batchNo = text(l.batchNo, 'batch number', { max: 40 }); } catch (e) { throw badRequest(`${where}: ${e.message}`); }
      let expiry;
      try { expiry = parseExpiry(l.expiry); } catch (e) { throw badRequest(`${where}: ${e.message}`); }
      if (expiry < day) throw badRequest(`${where}: batch ${batchNo} is already expired (${expiry}) — do not accept it`);
      let qty, cost;
      try {
        qty = int(l.qty, 'quantity', { min: 1, max: LIMITS.qty });
        cost = canSetCost ? money(l.unitCost, 'unit cost', { optional: true }) ?? item.unit_cost : item.unit_cost;
      } catch (e) { throw badRequest(`${where}: ${e.message}`); }
      if (cost === null) throw badRequest(`${where}: purchase price is missing`);

      const total = (receivedPerItem.get(item.id) ?? 0) + qty;
      if (total > item.qty) throw badRequest(`${where}: receiving ${total} but only ${item.qty} were ordered`);
      receivedPerItem.set(item.id, total);

      const b = (await c.query(
        `INSERT INTO batches (product_id, po_item_id, batch_no, expiry_date, qty_received, qty_on_hand, unit_cost, received_at)
         VALUES ($1, $2, $3, $4, $5, $5, $6, $7) RETURNING id, batch_no, expiry_date, qty_received`,
        [item.product_id, item.id, batchNo, expiry, qty, cost, day])).rows[0];
      await c.query(`INSERT INTO stock_movements (batch_id, product_id, type, qty, ref_id, user_id, movement_date)
                     VALUES ($1, $2, 'receive', $3, $4, $5, $6)`, [b.id, item.product_id, qty, poId, userId, day]);
      created.push(b);
    }
    await c.query(`UPDATE purchase_orders SET status = 'received', received_at = now() WHERE id = $1`, [poId]);
    return created;
  }).then(async (batches) => ({ order: await getPurchaseOrder(pool, poId), batches }));
}
