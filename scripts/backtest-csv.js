// Run the same walk-forward backtest on an external daily sales CSV (e.g. a public retail dataset).
//
//   npm run backtest:csv -- path/to/file.csv [--date=date] [--item=item] [--qty=sales] [--limit=50]
//
// The CSV needs a header row with a date column (YYYY-MM-DD), an item/series id column and a
// quantity column. Rows are summed per (item, day); missing days count as zero sales.
// Example: Kaggle "Store Item Demand Forecasting Challenge" train.csv (columns date,store,item,sales)
// works with --item=item (it sums across stores). Check the dataset's licence before using it.
import { readFileSync } from 'node:fs';
import { walkForward } from '../src/forecast/backtest.js';
import { diffDays, weekday } from '../src/dates.js';

const [file, ...flags] = process.argv.slice(2);
if (!file) {
  console.error('usage: npm run backtest:csv -- file.csv [--date=date] [--item=item] [--qty=sales] [--limit=50]');
  process.exit(1);
}
const opt = Object.fromEntries(flags.map((f) => f.replace(/^--/, '').split('=')));
const cols = { date: opt.date ?? 'date', item: opt.item ?? 'item', qty: opt.qty ?? 'sales' };
const limit = Number(opt.limit ?? 50);

const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
const header = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
const idx = Object.fromEntries(Object.entries(cols).map(([k, c]) => [k, header.indexOf(c)]));
for (const [k, i] of Object.entries(idx)) if (i < 0) throw new Error(`column "${cols[k]}" (${k}) not found in header: ${header.join(',')}`);

const byItem = new Map();
for (const line of lines.slice(1)) {
  const c = line.split(',');
  const day = c[idx.date].trim().slice(0, 10), item = c[idx.item].trim(), q = Number(c[idx.qty]);
  if (!Number.isFinite(q)) continue;
  if (!byItem.has(item)) byItem.set(item, new Map());
  const m = byItem.get(item);
  m.set(day, (m.get(day) ?? 0) + q);
}

let scored = 0, wins = 0;
const pooled = { model: [0, 0], seasonal_naive: [0, 0], mean_7: [0, 0] };
for (const [item, days] of [...byItem].slice(0, limit)) {
  const sorted = [...days.keys()].sort();
  const start = sorted[0];
  const y = new Array(diffDays(sorted.at(-1), start) + 1).fill(0);
  for (const [d, q] of days) y[diffDays(d, start)] = q;
  const bt = walkForward(y, weekday(start));
  if (!bt) continue;
  scored++;
  if (bt.beatsBaselines) wins++;
  for (const k of Object.keys(pooled)) {
    pooled[k][0] += bt.metrics[k].mae * bt.metrics[k].n;
    pooled[k][1] += bt.metrics[k].n;
  }
  const m = bt.metrics;
  console.log(`${item.padEnd(12)} MAE model ${m.model.mae.toFixed(2)}  s-naive ${m.seasonal_naive.mae.toFixed(2)}  mean7 ${m.mean_7.mae.toFixed(2)}  WAPE ${(m.model.wape * 100).toFixed(1)}%  ${bt.beatsBaselines ? 'beats' : 'loses'}`);
}
console.log(`\nModel beats both baselines on ${wins}/${scored} series.`);
for (const [k, [e, n]] of Object.entries(pooled)) console.log(`  pooled MAE ${k.padEnd(15)} ${(e / n).toFixed(3)}`);
