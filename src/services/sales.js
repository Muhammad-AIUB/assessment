import { withTransaction } from '../db.js';
import { allocateFefo, shortageMessage } from '../domain/fefo.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { today } from '../dates.js';

/**
 * Record a sale. Each line is allocated FEFO across batches; expired batches are skipped.
 *
 * Concurrency: the whole sale is one transaction. Candidate batch rows are locked with
 * SELECT … FOR UPDATE, so a concurrent sale of the same product blocks until we commit and then
 * re-reads the decremented quantities — the same unit can never be sold twice. Products are
 * locked in ascending id order so two multi-product sales cannot deadlock each other.
 *
 * @param {{ items: {productId: number, qty: number}[] }} input
 */
export async function createSale(pool, userId, { items }, day = today()) {
  if (!Array.isArray(items) || items.length === 0) throw badRequest('At least one item is required');

  // Merge duplicate product lines, validate quantities.
  const wanted = new Map();
  for (const it of items) {
    const productId = Number(it.productId);
    const qty = Number(it.qty);
    if (!Number.isInteger(productId)) throw badRequest('Invalid product');
    if (!Number.isInteger(qty) || qty <= 0) throw badRequest('Quantity must be a positive whole number');
    wanted.set(productId, (wanted.get(productId) ?? 0) + qty);
  }
  const productIds = [...wanted.keys()].sort((a, b) => a - b);

  return withTransaction(pool, async (c) => {
    const { rows: products } = await c.query(
      'SELECT id, name, sell_price FROM products WHERE id = ANY($1) AND active ORDER BY id', [productIds]);
    if (products.length !== productIds.length) throw notFound('Product not found or inactive');

    const sale = (await c.query('INSERT INTO sales (user_id, sale_date) VALUES ($1, $2) RETURNING id, sale_date', [userId, day])).rows[0];
    const lines = [];

    for (const product of products) {
      const qty = wanted.get(product.id);
      const { rows: batches } = await c.query(
        `SELECT id, batch_no, expiry_date, qty_on_hand FROM batches
         WHERE product_id = $1 AND state = 'active' AND qty_on_hand > 0
         ORDER BY expiry_date, id
         FOR UPDATE`, [product.id]);

      const result = allocateFefo(batches, qty, day);
      if (!result.ok) {
        throw conflict(`${product.name}: ${shortageMessage(result)}`, {
          productId: product.id, requested: qty, sellable: result.sellable, expiredQty: result.expiredQty,
        });
      }

      for (const pick of result.picks) {
        await c.query('UPDATE batches SET qty_on_hand = qty_on_hand - $2 WHERE id = $1', [pick.batchId, pick.qty]);
        await c.query('INSERT INTO sale_lines (sale_id, product_id, batch_id, qty, unit_price) VALUES ($1, $2, $3, $4, $5)',
          [sale.id, product.id, pick.batchId, pick.qty, product.sell_price]);
        await c.query(`INSERT INTO stock_movements (batch_id, product_id, type, qty, ref_id, user_id, movement_date)
                       VALUES ($1, $2, 'sale', $3, $4, $5, $6)`, [pick.batchId, product.id, -pick.qty, sale.id, userId, day]);
        const b = batches.find((x) => x.id === pick.batchId);
        lines.push({ productId: product.id, productName: product.name, batchId: b.id, batchNo: b.batch_no,
          expiryDate: b.expiry_date, qty: pick.qty, unitPrice: product.sell_price });
      }
    }

    const total = lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
    return { saleId: sale.id, saleDate: sale.sale_date, lines, total: Math.round(total * 100) / 100 };
  });
}

export async function recentSales(pool, { limit = 30 } = {}) {
  const { rows } = await pool.query(
    `SELECT s.id, s.sale_date, s.created_at, u.name AS sold_by,
            json_agg(json_build_object('product', p.name, 'batchNo', b.batch_no, 'qty', sl.qty, 'unitPrice', sl.unit_price) ORDER BY sl.id) AS lines,
            SUM(sl.qty * sl.unit_price) AS total
     FROM sales s JOIN sale_lines sl ON sl.sale_id = s.id JOIN products p ON p.id = sl.product_id
     JOIN batches b ON b.id = sl.batch_id LEFT JOIN users u ON u.id = s.user_id
     GROUP BY s.id, u.name ORDER BY s.id DESC LIMIT $1`, [limit]);
  return rows;
}
