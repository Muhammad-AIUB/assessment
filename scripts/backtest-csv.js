// Run the same walk-forward backtest as the in-app Model report on an external daily sales CSV.
//
//   npm run backtest:csv -- file.csv [--date=date] [--item=item] [--qty=sales] [--top=200] [--min-days=63] [--json=out.json] [--quiet]
//
// The CSV needs a header with a date column (YYYY-MM-DD), an item id column and a quantity column.
// Rows are summed per (item, day). Each item's series runs from its first sale to the LAST date in
// the whole file, with missing days as zero sales (so a product that stopped selling is scored on
// those zeros too). --top keeps the N items with the most units sold.
import { readFileSync, writeFileSync } from 'node:fs';
import { walkForward } from '../src/forecast/backtest.js';
import { diffDays, weekday } from '../src/dates.js';

const [file, ...flags] = process.argv.slice(2);
if (!file) {
  console.error('usage: npm run backtest:csv -- file.csv [--date=date] [--item=item] [--qty=sales] [--top=N] [--min-days=63] [--json=out.json] [--quiet]');
  process.exit(1);
}
const opt = Object.fromEntries(flags.map((f) => { const [k, v = 'true'] = f.replace(/^--/, '').split('='); return [k, v]; }));
const cols = { date: opt.date ?? 'date', item: opt.item ?? 'item', qty: opt.qty ?? 'sales' };
const top = opt.top ? Number(opt.top) : Infinity;
const minDays = Number(opt['min-days'] ?? 63); // 56 days to train + one 7-day window

// ---------- load ----------
const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
const header = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
const idx = Object.fromEntries(Object.entries(cols).map(([k, c]) => [k, header.indexOf(c)]));
for (const [k, i] of Object.entries(idx)) if (i < 0) throw new Error(`column "${cols[k]}" (${k}) not found in header: ${header.join(',')}`);

const byItem = new Map();
let lastDay = '';
for (const line of lines.slice(1)) {
  const c = line.split(',');
  const day = c[idx.date].trim().slice(0, 10), item = c[idx.item].trim(), q = Number(c[idx.qty]);
  if (!Number.isFinite(q) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
  if (day > lastDay) lastDay = day;
  if (!byItem.has(item)) byItem.set(item, new Map());
  const m = byItem.get(item);
  m.set(day, (m.get(day) ?? 0) + q);
}

// ---------- build series ----------
const series = [];
for (const [item, days] of byItem) {
  const start = [...days.keys()].sort()[0];
  const y = new Array(diffDays(lastDay, start) + 1).fill(0);
  for (const [d, q] of days) y[diffDays(d, start)] = q;
  const total = y.reduce((a, b) => a + b, 0);
  series.push({ item, start, y, total });
}
const eligible = series.filter((s) => s.y.length >= minDays).sort((a, b) => b.total - a.total).slice(0, top);

// Same segmentation as the in-app report, by share of zero-sale days and average volume.
const segmentOf = (y) => {
  const zero = y.filter((v) => v === 0).length / y.length;
  const mean = y.reduce((a, b) => a + b, 0) / y.length;
  return zero >= 0.3 ? 'slow / intermittent' : mean >= 15 ? 'fast' : 'medium';
};

// ---------- backtest ----------
const MODELS = ['model', 'seasonal_naive', 'mean_7'];
const t0 = Date.now();
const results = [];
for (const s of eligible) {
  const bt = walkForward(s.y, weekday(s.start));
  if (!bt) continue;
  results.push({ item: s.item, days: s.y.length, total: s.total, segment: segmentOf(s.y), bt });
  if (!opt.quiet) {
    const m = bt.metrics;
    console.log(`${s.item.padEnd(12)} ${segmentOf(s.y).padEnd(20)} MAE model ${m.model.mae.toFixed(2).padStart(6)}  s-naive ${m.seasonal_naive.mae.toFixed(2).padStart(6)}  mean7 ${m.mean_7.mae.toFixed(2).padStart(6)}  ${bt.beatsBaselines ? 'beats' : 'loses'}`);
  }
}

// Pooled metrics: total absolute error ÷ total actual (WAPE), and error per day (MAE), across items.
function pool(rows) {
  const out = {};
  for (const k of MODELS) {
    let absErr = 0, actual = 0, n = 0;
    for (const r of rows) {
      const m = r.bt.metrics[k];
      absErr += m.mae * m.n;
      if (m.wape !== null) actual += (m.mae * m.n) / m.wape;
      n += m.n;
    }
    out[k] = { mae: n ? absErr / n : null, wape: actual ? absErr / actual : null };
  }
  return out;
}
const segments = {};
for (const seg of ['fast', 'medium', 'slow / intermittent']) {
  const rows = results.filter((r) => r.segment === seg);
  if (rows.length) segments[seg] = { items: rows.length, wins: rows.filter((r) => r.bt.beatsBaselines).length, pooled: pool(rows) };
}
const summary = {
  file, lastDay, itemsInFile: byItem.size, itemsScored: results.length, top: Number.isFinite(top) ? top : 'all', minDays,
  wins: results.filter((r) => r.bt.beatsBaselines).length,
  winner: Object.fromEntries(MODELS.map((k) => [k, results.filter((r) => r.bt.winner === k).length])),
  pooled: pool(results), segments, seconds: Math.round((Date.now() - t0) / 100) / 10,
};

const f = (x) => (x === null ? '   –  ' : x.toFixed(3).padStart(7));
const p = (x) => (x === null ? '   –  ' : `${(x * 100).toFixed(1)}%`.padStart(7));
console.log(`\n${summary.itemsScored} items scored (of ${summary.itemsInFile} in file), data to ${lastDay}, ${summary.seconds}s`);
console.log(`Model beats BOTH baselines on ${summary.wins}/${summary.itemsScored} items (${p(summary.wins / summary.itemsScored).trim()}).`);
console.log(`Lowest MAE per item: model ${summary.winner.model}, same-day-last-week ${summary.winner.seasonal_naive}, 7-day mean ${summary.winner.mean_7}`);
console.log('\nsegment               items  wins |  MAE model  s-naive   mean7 |  WAPE model  s-naive   mean7');
for (const [seg, v] of Object.entries({ ...segments, ALL: { items: results.length, wins: summary.wins, pooled: summary.pooled } })) {
  const P = v.pooled;
  console.log(`${seg.padEnd(20)} ${String(v.items).padStart(6)} ${String(v.wins).padStart(5)} | ${f(P.model.mae)} ${f(P.seasonal_naive.mae)} ${f(P.mean_7.mae)} | ${p(P.model.wape)} ${p(P.seasonal_naive.wape)} ${p(P.mean_7.wape)}`);
}
if (opt.json) writeFileSync(opt.json, JSON.stringify({ summary, items: results.map((r) => ({ item: r.item, segment: r.segment, total: r.total, beats: r.bt.beatsBaselines, winner: r.bt.winner, mae: Object.fromEntries(MODELS.map((k) => [k, r.bt.metrics[k].mae])) })) }, null, 2));
