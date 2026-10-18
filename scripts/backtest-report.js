// Print the walk-forward backtest (model vs baselines) for every product in the database.
import { createPool } from '../src/db.js';
import { modelReport } from '../src/services/forecasting.js';

const pool = createPool();
try {
  const r = await modelReport(pool);
  const f = (x) => (x === null || x === undefined ? '   –  ' : x.toFixed(2).padStart(6));
  const pct = (x) => (x === null || x === undefined ? '   –  ' : `${(x * 100).toFixed(1)}%`.padStart(6));
  console.log(`Walk-forward backtest, 7-day horizon, as of ${r.generatedFor}\n`);
  console.log('Product'.padEnd(32), 'segment'.padEnd(20), 'MAE model  s-naive  mean7 | WAPE model  s-naive  mean7 | MAPE(>0) | beats?');
  for (const p of r.products) {
    const b = p.backtest;
    if (!b) { console.log(p.name.padEnd(32), p.segment.padEnd(20), `skipped (${p.historyDays} days of history)`); continue; }
    const m = b.metrics;
    console.log(p.name.slice(0, 31).padEnd(32), p.segment.padEnd(20),
      f(m.model.mae), f(m.seasonal_naive.mae), f(m.mean_7.mae), '|',
      pct(m.model.wape), pct(m.seasonal_naive.wape), pct(m.mean_7.wape), '|', pct(m.model.mape), '  |', b.beatsBaselines ? 'yes' : 'NO');
  }
  const s = r.summary;
  console.log(`\nModel beats both baselines on ${s.modelBeatsBoth}/${s.productsScored} products.`);
  for (const [k, v] of Object.entries(s.pooled)) console.log(`  pooled ${k.padEnd(15)} MAE ${f(v.mae)}  WAPE ${pct(v.wape)}`);
} finally {
  await pool.end();
}
