// Synthetic demo data. THIS IS NOT REAL SALES DATA.
//
// Generates ~9 months of daily demand for 18 products of different behaviours (fast movers with
// a weekly pattern, slow/intermittent items, items with random spikes, one brand-new product),
// then *simulates* the shop: periodic purchase orders, batch receipts with expiry dates, and FEFO
// sales using the exact same allocateFefo() rule the live app uses. Demand that can't be met is a
// lost sale (realistic, and keeps the stock history internally consistent).
//
// Deterministic: a fixed RNG seed gives the same data every run.
import { createPool, withTransaction } from '../src/db.js';
import { resetDatabase } from './migrate.js';
import { hashPassword } from '../src/services/auth.js';
import { allocateFefo } from '../src/domain/fefo.js';
import { today, addDays, weekday, parseExpiry } from '../src/dates.js';

export const HISTORY_DAYS = 270;

// ---------- deterministic RNG ----------
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function poisson(rng, lambda) {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gaussian(rng)));
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}
function gaussian(rng) {
  const u = 1 - rng(), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------- catalogue ----------
// Weekday multipliers Mon..Sun. In Bangladesh Friday is the weekly holiday: pharmacies are busy
// Thu evening/Sat, quieter on Friday mornings.
const WEEKLY = [1.0, 0.95, 1.0, 1.15, 0.7, 1.2, 1.0];
const FLAT = [1, 1, 1, 1, 1, 1, 1];

const SUPPLIERS = [
  { name: 'Square Pharmaceuticals Depot', phone: '01700-000001', lead: 2 },
  { name: 'Beximco Distribution', phone: '01700-000002', lead: 3 },
  { name: 'Incepta Local Agent', phone: '01700-000003', lead: 5 },
  { name: 'City Medical Wholesale', phone: '01700-000004', lead: 7 },
];

// kind: fast | medium | slow | spiky | new.  shelf = shelf life in months at receipt.
const PRODUCTS = [
  ['PCM-500', 'Paracetamol 500mg (strip)', 'strip', 0, 'fast', 38, 2.0, 12, 24],
  ['NAPA-EXT', 'Napa Extra (strip)', 'strip', 0, 'fast', 25, 2.5, 15, 24],
  ['OMP-20', 'Omeprazole 20mg (strip)', 'strip', 1, 'fast', 22, 6.0, 18, 24],
  ['ORS-SAL', 'Oral Saline sachet', 'sachet', 1, 'spiky', 18, 0.8, 10, 18],
  ['CET-10', 'Cetirizine 10mg (strip)', 'strip', 0, 'medium', 12, 3.5, 10, 24],
  ['MET-500', 'Metformin 500mg (strip)', 'strip', 2, 'medium', 10, 4.0, 15, 24],
  ['AML-5', 'Amlodipine 5mg (strip)', 'strip', 2, 'medium', 8, 5.0, 10, 24],
  ['AZI-500', 'Azithromycin 500mg (strip)', 'strip', 1, 'medium', 6, 35, 6, 18],
  ['VIT-C', 'Vitamin C 250mg (strip)', 'strip', 3, 'medium', 7, 1.5, 6, 18],
  ['ANT-SYR', 'Antacid suspension 200ml', 'bottle', 3, 'medium', 5, 9, 5, 12],
  ['COUGH-SYR', 'Cough syrup 100ml', 'bottle', 3, 'spiky', 4, 12, 4, 9],
  ['INS-PEN', 'Insulin pen (Mixtard)', 'pen', 2, 'slow', 0.8, 50, 2, 9],
  ['EYE-DRP', 'Chloramphenicol eye drops', 'bottle', 3, 'slow', 0.6, 30, 2, 6],
  ['THERM', 'Digital thermometer', 'pcs', 3, 'slow', 0.3, 15, 1, 36],
  ['MASK-N95', 'N95 mask', 'pcs', 3, 'spiky', 3, 10, 5, 36],
  ['BAND-AID', 'Adhesive bandage (box)', 'box', 0, 'slow', 1.2, 4, 2, 36],
  ['ZINC-SYR', 'Zinc syrup 100ml', 'bottle', 1, 'slow', 1.0, 3.5, 2, 8],
  ['MONT-10', 'Montelukast 10mg (strip)', 'strip', 2, 'new', 5, 12, 5, 24],
];

const PRICE_MULT = 10; // sell_price above is per unit cost basis; make prices taka-like

function demandSeries(rng, kind, mean, days, startDay) {
  const out = [];
  let spikeLeft = 0, spikeMult = 1;
  for (let i = 0; i < days; i++) {
    const dow = weekday(addDays(startDay, i));
    const pattern = kind === 'slow' ? FLAT : WEEKLY;
    let lambda = mean * pattern[dow] * Math.exp(0.25 * gaussian(rng) - 0.03); // lognormal noise
    if (kind === 'spiky') {
      if (spikeLeft === 0 && rng() < 0.03) { spikeLeft = 2 + Math.floor(rng() * 5); spikeMult = 2.5 + rng() * 2.5; }
      if (spikeLeft > 0) { lambda *= spikeMult; spikeLeft--; }
    }
    out.push(poisson(rng, lambda));
  }
  return out;
}

export async function seed(pool, { day = today(), log = console.log } = {}) {
  const rng = mulberry32(20261018);
  await resetDatabase(pool);

  const start = addDays(day, -HISTORY_DAYS);
  const suppliers = SUPPLIERS.map((s, i) => ({ id: i + 1, ...s }));
  const products = PRODUCTS.map(([sku, name, unit, sup, kind, mean, cost, minLevel, shelf], i) => ({
    id: i + 1, sku, name, unit, kind, mean, shelf, minLevel,
    supplier: suppliers[sup],
    unitCost: cost * PRICE_MULT * 0.8,
    sellPrice: cost * PRICE_MULT,
  }));

  const rows = { pos: [], poItems: [], batches: [], sales: [], lines: [], moves: [] };
  const ids = { po: 0, poItem: 0, batch: 0, sale: 0, line: 0 };
  const salesByDay = new Map(); // dayIndex -> sale id

  for (const p of products) {
    // New product: only 20 days of history -> exercises the low-confidence fallback.
    const historyDays = p.kind === 'new' ? 20 : HISTORY_DAYS;
    const firstDay = HISTORY_DAYS - historyDays;
    const demand = demandSeries(rng, p.kind, p.mean, historyDays, addDays(start, firstDay));
    const lead = p.supplier.lead;
    const review = 7;
    const live = [];          // in-memory batches for the simulation
    const pending = [];       // { arriveIdx, qty, poId, poItemId }
    const orderUpTo = () => Math.ceil(p.mean * (lead + review) * 1.4 + p.minLevel + 2);

    const receive = (idx, qty, poId, poItemId) => {
      const d = addDays(start, idx);
      // Fast movers get long-dated stock; short-shelf items sometimes arrive short-dated.
      const months = Math.max(2, Math.round(p.shelf * (0.5 + rng() * 0.5)));
      const exp = parseExpiry(addDays(d, months * 30).slice(0, 7));
      const b = { id: ++ids.batch, product_id: p.id, po_item_id: poItemId, batch_no: `${p.sku.slice(0, 3)}${String(ids.batch).padStart(4, '0')}`,
        expiry_date: exp, qty_received: qty, qty_on_hand: qty, unit_cost: +(p.unitCost * (0.95 + rng() * 0.1)).toFixed(2), state: 'active', received_at: d };
      rows.batches.push(b);
      live.push(b);
      rows.moves.push({ batch_id: b.id, product_id: p.id, type: 'receive', qty, reason: null, ref_id: poId, user_id: 1, movement_date: d });
    };

    const placeOrder = (idx, qty) => {
      const poId = ++ids.po, itemId = ++ids.poItem;
      const d = addDays(start, idx);
      const arrive = idx + lead;
      const received = arrive < HISTORY_DAYS;
      rows.pos.push({ id: poId, supplier_id: p.supplier.id, status: received ? 'received' : 'ordered', note: 'Auto (seed history)', created_by: 1,
        created_at: `${d}T09:00:00Z`, ordered_at: `${d}T09:00:00Z`, received_at: received ? `${addDays(start, arrive)}T11:00:00Z` : null });
      rows.poItems.push({ id: itemId, po_id: poId, product_id: p.id, qty, unit_cost: +p.unitCost.toFixed(2) });
      if (received) pending.push({ arriveIdx: arrive, qty, poId, itemId });
    };

    // Opening stock
    placeOrder(Math.max(0, firstDay - lead), orderUpTo());
    for (let k = 0; k < historyDays; k++) {
      const idx = firstDay + k;
      const d = addDays(start, idx);
      for (const o of pending.filter((x) => x.arriveIdx === idx)) receive(idx, o.qty, o.poId, o.itemId);
      // Sell FEFO; unmet demand = lost sale.
      const want = demand[k];
      const r = want > 0 ? allocateFefo(live, want, d) : null;
      const picks = !r ? [] : r.ok ? r.picks : r.sellable > 0 ? allocateFefo(live, r.sellable, d).picks : [];
      if (picks.length) {
        if (!salesByDay.has(idx)) {
          salesByDay.set(idx, ++ids.sale);
          rows.sales.push({ id: ids.sale, user_id: 2, sale_date: d, created_at: `${d}T20:00:00Z` });
        }
        for (const pk of picks) {
          const b = live.find((x) => x.id === pk.batchId);
          b.qty_on_hand -= pk.qty;
          rows.lines.push({ id: ++ids.line, sale_id: salesByDay.get(idx), product_id: p.id, batch_id: b.id, qty: pk.qty, unit_price: p.sellPrice });
          rows.moves.push({ batch_id: b.id, product_id: p.id, type: 'sale', qty: -pk.qty, reason: null, ref_id: salesByDay.get(idx), user_id: 2, movement_date: d });
        }
      }
      // Write off what expired yesterday, like a diligent owner would (keeps history tidy)…
      for (const b of live) {
        if (b.state === 'active' && b.qty_on_hand > 0 && b.expiry_date < d && k < historyDays - 30) {
          rows.moves.push({ batch_id: b.id, product_id: p.id, type: 'write_off', qty: -b.qty_on_hand, reason: 'Expired (routine clearance)', ref_id: null, user_id: 1, movement_date: d });
          b.qty_on_hand = 0;
          b.state = 'written_off';
        }
      }
      // Weekly review: order up to target if position is low.
      if (k % review === 0) {
        const onHand = live.filter((b) => b.state === 'active' && b.expiry_date >= d).reduce((s, b) => s + b.qty_on_hand, 0);
        const onOrder = pending.filter((o) => o.arriveIdx > idx).reduce((s, o) => s + o.qty, 0);
        const pos = onHand + onOrder;
        if (pos < orderUpTo() * 0.6) placeOrder(idx, orderUpTo() - pos);
      }
    }
  }

  // ---- demo situations on "today" ----
  const demoBatch = (pid, batchNo, expiry, qty, receivedDaysAgo) => {
    const p = products[pid - 1];
    const b = { id: ++ids.batch, product_id: pid, po_item_id: null, batch_no: batchNo, expiry_date: expiry, qty_received: qty, qty_on_hand: qty,
      unit_cost: +p.unitCost.toFixed(2), state: 'active', received_at: addDays(day, -receivedDaysAgo) };
    rows.batches.push(b);
    rows.moves.push({ batch_id: b.id, product_id: pid, type: 'receive', qty, reason: 'Opening stock (demo)', ref_id: null, user_id: 1, movement_date: b.received_at });
  };
  demoBatch(1, 'PCM-EXP01', addDays(day, -12), 3, 400);           // expired, still on shelf
  demoBatch(13, 'EYE-NEAR1', addDays(day, 20), 14, 120);          // near expiry, slow mover -> risk
  demoBatch(11, 'CGH-NEAR2', addDays(day, 45), 30, 90);           // near expiry syrup
  demoBatch(14, 'THM-OLD', addDays(day, 150), 25, 60);            // slow mover, far expiry, surplus

  // ---- persist ----
  await withTransaction(pool, async (c) => {
    const ins = async (table, data) => {
      for (let i = 0; i < data.length; i += 2000) {
        const chunk = data.slice(i, i + 2000);
        await c.query(`INSERT INTO ${table} SELECT * FROM json_populate_recordset(NULL::${table}, $1)`, [JSON.stringify(chunk)]);
      }
    };
    await c.query(`INSERT INTO users (id, name, username, password_hash, role) VALUES
      (1, 'Rahim (Owner)', 'owner', $1, 'owner'), (2, 'Karim (Staff)', 'staff', $2, 'staff')`,
      [await hashPassword('owner123'), await hashPassword('staff123')]);
    await ins('suppliers', suppliers.map((s) => ({ id: s.id, name: s.name, phone: s.phone, lead_time_days: s.lead })));
    await ins('products', products.map((p) => ({ id: p.id, sku: p.sku, name: p.name, unit: p.unit, supplier_id: p.supplier.id,
      lead_time_days: p.supplier.lead, review_period_days: 7, min_level: p.minLevel, sell_price: p.sellPrice, active: true })));
    await ins('purchase_orders', rows.pos);
    await ins('po_items', rows.poItems);
    await ins('batches', rows.batches);
    await ins('sales', rows.sales);
    await ins('sale_lines', rows.lines);
    await ins('stock_movements', rows.moves.map((m, i) => ({ id: i + 1, created_at: `${m.movement_date}T12:00:00Z`, ...m })));

    for (const t of ['users', 'suppliers', 'products', 'purchase_orders', 'po_items', 'batches', 'sales', 'sale_lines', 'stock_movements']) {
      await c.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), (SELECT COALESCE(MAX(id), 1) FROM ${t}))`);
    }

    // A draft PO to show the workflow
    const draft = await c.query(`INSERT INTO purchase_orders (supplier_id, status, note, created_by) VALUES (2, 'draft', 'Demo draft', 1) RETURNING id`);
    await c.query(`INSERT INTO po_items (po_id, product_id, qty, unit_cost) VALUES ($1, 5, 40, 28), ($1, 8, 20, 280)`, [draft.rows[0].id]);
  });

  log(`Seeded ${products.length} products, ${rows.batches.length} batches, ${rows.sales.length} sale-days, ` +
    `${rows.lines.length} sale lines, ${rows.pos.length} purchase orders (history ${start} → ${addDays(day, -1)}).`);
  log('Logins — owner / owner123   staff / staff123   (demo credentials, synthetic data)');
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/seed.js')) {
  const pool = createPool();
  try { await seed(pool); } finally { await pool.end(); }
}
