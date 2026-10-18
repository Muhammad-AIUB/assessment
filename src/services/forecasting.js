// Glue between the database and the pure forecasting functions in src/forecast/.
import { forecast, VALIDATION_DAYS } from '../forecast/model.js';
import { walkForward } from '../forecast/backtest.js';
import { reorderQuantity, Z_95 } from '../forecast/reorder.js';
import { simulateExpiryRisk } from '../forecast/risk.js';
import { stdDev } from '../forecast/metrics.js';
import { addDays, diffDays, today, weekday } from '../dates.js';
import { badRequest, notFound } from '../errors.js';
import { createPurchaseOrder } from './purchasing.js';

export const HORIZON = 14;

/**
 * Daily demand series for a product, gap-filled with zeros, from its first sale (or receipt)
 * through *yesterday* — today is still in progress and would bias the last point low.
 */
export async function demandSeries(pool, productId, day = today()) {
  const end = addDays(day, -1);
  const { rows } = await pool.query(
    'SELECT day, qty FROM daily_sales WHERE product_id = $1 AND day <= $2 ORDER BY day', [productId, end]);
  if (!rows.length) return { start: day, values: [] };
  const start = rows[0].day;
  const values = new Array(diffDays(end, start) + 1).fill(0);
  for (const r of rows) values[diffDays(r.day, start)] = r.qty;
  return { start, values };
}

export async function productForecast(pool, productId, day = today()) {
  const product = (await pool.query(
    `SELECT p.*, s.name AS supplier_name FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = $1`, [productId])).rows[0];
  if (!product) throw notFound('Product not found');

  const { start, values } = await demandSeries(pool, productId, day);
  const startDow = weekday(start);
  const coverDays = product.lead_time_days + product.review_period_days;
  const horizon = Math.max(HORIZON, coverDays);
  const fc = forecast(values, startDow, horizon);
  const bt = walkForward(values, startDow);

  // σ of daily forecast error from the backtest; with too little history fall back to the
  // series' own day-to-day variability (more conservative, flagged as low confidence).
  const errorSigma = bt ? bt.modelErrorSigma : stdDev(values);

  const stock = (await pool.query(
    `SELECT
       COALESCE(SUM(qty_on_hand) FILTER (WHERE state = 'active' AND expiry_date >= $2), 0)::INT AS usable,
       COALESCE(SUM(qty_on_hand) FILTER (WHERE state = 'active' AND expiry_date <  $2), 0)::INT AS expired
     FROM batches WHERE product_id = $1`, [productId, day])).rows[0];
  const onOrder = (await pool.query(
    `SELECT COALESCE(SUM(pi.qty), 0)::INT AS q FROM po_items pi JOIN purchase_orders po ON po.id = pi.po_id
     WHERE pi.product_id = $1 AND po.status = 'ordered'`, [productId])).rows[0].q;

  const reorder = reorderQuantity({
    dailyForecast: fc.forecast,
    leadTimeDays: product.lead_time_days,
    reviewPeriodDays: product.review_period_days,
    errorSigma,
    usableStock: stock.usable,
    onOrder,
    minLevel: product.min_level,
    z: Z_95,
  });

  // Expiry risk: extend the weekly pattern as far as the furthest batch expiry.
  const batches = (await pool.query(
    `SELECT id, batch_no, expiry_date, qty_on_hand FROM batches
     WHERE product_id = $1 AND state = 'active' AND qty_on_hand > 0 AND expiry_date >= $2`, [productId, day])).rows;
  const nextDow = weekday(day);
  const demandAt = (k) => fc.level * fc.season[(nextDow + k) % 7];
  const risk = simulateExpiryRisk(batches, demandAt, day);

  const historyDays = Math.min(values.length, 90);
  return {
    product: {
      id: product.id, name: product.name, sku: product.sku, unit: product.unit, supplierId: product.supplier_id,
      supplierName: product.supplier_name, leadTimeDays: product.lead_time_days, reviewPeriodDays: product.review_period_days,
      minLevel: product.min_level,
    },
    history: values.slice(-historyDays).map((qty, i) => ({ day: addDays(start, values.length - historyDays + i), qty })),
    forecast: fc.forecast.slice(0, HORIZON).map((qty, i) => ({ day: addDays(day, i), qty: round2(qty) })),
    forecastTotals: { next7: round2(sum(fc.forecast.slice(0, 7))), next14: round2(sum(fc.forecast.slice(0, 14))) },
    model: {
      method: fc.method, confidence: fc.confidence, alpha: fc.alpha ?? null, gamma: fc.gamma ?? null,
      level: round2(fc.level), season: fc.season.map(round2), historyDays: values.length,
      zeroDayShare: values.length ? round2(values.filter((v) => v === 0).length / values.length) : null,
    },
    backtest: bt,
    stock: { ...stock, onOrder },
    reorder: { ...reorder, demandOverCover: round2(reorder.demandOverCover), safetyStock: round2(reorder.safetyStock), errorSigma: round2(errorSigma) },
    risk,
  };
}

/** "Draft PO বানাও": turn the recommendation into a Draft purchase order. */
export async function draftPoFromRecommendation(pool, userId, productId, day = today()) {
  const f = await productForecast(pool, productId, day);
  if (!f.product.supplierId) throw badRequest('Product has no supplier — set one first');
  if (f.reorder.quantity <= 0) throw badRequest('No purchase needed right now: stock + on-order already covers the forecast');
  const lastCost = (await pool.query(
    'SELECT unit_cost FROM batches WHERE product_id = $1 ORDER BY received_at DESC, id DESC LIMIT 1', [productId])).rows[0]?.unit_cost ?? null;
  return createPurchaseOrder(pool, userId, {
    supplierId: f.product.supplierId,
    note: `From forecast on ${day}: ${f.reorder.coverDays}-day demand ${f.reorder.demandOverCover} + safety ${f.reorder.safetyStock}`,
    items: [{ productId, qty: f.reorder.quantity, unitCost: lastCost }],
  });
}

// ---------- model report (backtest across all products) ----------
let reportCache = { key: null, value: null };

export async function modelReport(pool, day = today()) {
  const key = `${day}:${(await pool.query('SELECT COUNT(*)::int AS n, COALESCE(MAX(id),0) AS m FROM sale_lines')).rows.map((r) => `${r.n}/${r.m}`)[0]}`;
  if (reportCache.key === key) return reportCache.value;

  const products = (await pool.query('SELECT id, name, sku FROM products WHERE active ORDER BY name')).rows;
  const rows = [];
  for (const p of products) {
    const { start, values } = await demandSeries(pool, p.id, day);
    const bt = walkForward(values, weekday(start));
    const meanDaily = values.length ? sum(values) / values.length : 0;
    const zeroShare = values.length ? values.filter((v) => v === 0).length / values.length : 0;
    rows.push({
      productId: p.id, name: p.name, sku: p.sku, historyDays: values.length,
      meanDaily: round2(meanDaily), zeroDayShare: round2(zeroShare),
      segment: values.length < 28 ? 'new' : zeroShare >= 0.3 ? 'slow / intermittent' : meanDaily >= 15 ? 'fast' : 'medium',
      backtest: bt,
    });
  }
  const scored = rows.filter((r) => r.backtest);
  const pooled = (name) => {
    // Pooled (portfolio) metrics: weight each product by its actual volume.
    let absErr = 0, actual = 0, n = 0;
    for (const r of scored) {
      const m = r.backtest.metrics[name];
      absErr += m.mae * m.n;
      actual += m.wape !== null ? (m.mae * m.n) / m.wape : 0;
      n += m.n;
    }
    return { mae: n ? absErr / n : null, wape: actual ? absErr / actual : null };
  };
  const value = {
    generatedFor: day,
    settings: { horizon: 7, step: 7, minTrain: 56, maxWindows: 26, validationDays: VALIDATION_DAYS },
    summary: {
      productsScored: scored.length,
      productsSkipped: rows.length - scored.length,
      modelBeatsBoth: scored.filter((r) => r.backtest.beatsBaselines).length,
      pooled: { model: pooled('model'), seasonal_naive: pooled('seasonal_naive'), mean_7: pooled('mean_7') },
    },
    products: rows,
  };
  reportCache = { key, value };
  return value;
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const round2 = (x) => Math.round(x * 100) / 100;
