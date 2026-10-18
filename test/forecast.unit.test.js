import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forecast, fit, predict, MIN_HISTORY } from '../src/forecast/model.js';
import { seasonalNaive, movingAverage7 } from '../src/forecast/baselines.js';
import { mae, wape, mape, stdDev } from '../src/forecast/metrics.js';
import { walkForward } from '../src/forecast/backtest.js';
import { reorderQuantity } from '../src/forecast/reorder.js';
import { simulateExpiryRisk } from '../src/forecast/risk.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

// Deterministic pseudo-noise so tests never flake.
function lcg(seed) { return () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296); }
const WEEK = [1.0, 0.9, 1.0, 1.2, 0.5, 1.4, 1.0];
function weeklySeries(days, base, noise, seed = 1) {
  const r = lcg(seed);
  return Array.from({ length: days }, (_, i) => Math.max(0, Math.round(base * WEEK[i % 7] + (r() - 0.5) * 2 * noise)));
}

// ---------- metrics ----------
test('MAE and WAPE', () => {
  close(mae([2, 4, 0], [1, 6, 1]), 4 / 3);
  close(wape([2, 4, 0], [1, 6, 1]), 4 / 6);
  assert.equal(wape([0, 0], [1, 1]), null); // nothing sold → undefined, not Infinity
});

test('MAPE ignores zero-sale days and reports how many days it used', () => {
  const m = mape([0, 10, 0, 20], [5, 8, 3, 25]);
  close(m.value, (0.2 + 0.25) / 2);
  assert.equal(m.days, 2);
  assert.deepEqual(mape([0, 0], [1, 1]), { value: null, days: 0 });
});

test('sample standard deviation', () => {
  close(stdDev([2, 4, 4, 4, 5, 5, 7, 9]), 2.138089935299395, 1e-12);
  assert.equal(stdDev([5]), 0);
});

// ---------- baselines ----------
test('seasonal naive repeats the same weekday from last week', () => {
  const y = [1, 2, 3, 4, 5, 6, 7, 10, 20, 30, 40, 50, 60, 70];
  assert.deepEqual(seasonalNaive(y, 9), [10, 20, 30, 40, 50, 60, 70, 10, 20]);
});

test('7-day moving average is flat', () => {
  assert.deepEqual(movingAverage7([100, 1, 2, 3, 4, 5, 6, 7], 3), [4, 4, 4]);
});

// ---------- model ----------
test('fewer than 28 days → falls back to the mean with low confidence', () => {
  const y = [3, 5, 4, 0, 8];
  const f = forecast(y, 0, 7);
  assert.equal(f.method, 'mean');
  assert.equal(f.confidence, 'low');
  assert.deepEqual(f.forecast, new Array(7).fill(4));
  assert.equal(forecast([], 0, 3).forecast.every((v) => v === 0), true);
  assert.equal(forecast(new Array(MIN_HISTORY).fill(2), 0, 1).confidence, 'normal');
});

test('constant demand is forecast exactly', () => {
  const f = forecast(new Array(90).fill(6), 3, 14);
  f.forecast.forEach((v) => close(v, 6, 1e-6));
});

test('learns the weekday pattern of a noise-free series', () => {
  const y = weeklySeries(84, 20, 0);
  const f = forecast(y, 0, 7); // y[84] is a Monday (84 % 7 = 0)
  const expected = WEEK.map((w) => Math.round(20 * w));
  f.forecast.forEach((v, i) => close(v, expected[i], 0.5));
});

test('weekday indices average to 1 so level = average daily demand', () => {
  const s = fit(weeklySeries(84, 20, 3), 0, 0.2, 0.1);
  close(s.season.reduce((a, b) => a + b, 0) / 7, 1, 1e-9);
  assert.equal(predict(s, 7).length, 7);
});

test('forecast never goes negative on sparse data', () => {
  const y = Array.from({ length: 60 }, (_, i) => (i % 9 === 0 ? 3 : 0));
  assert.ok(forecast(y, 0, 14).forecast.every((v) => v >= 0));
});

// ---------- backtest ----------
test('walk-forward: model beats both baselines on a noisy weekly series', () => {
  const y = weeklySeries(240, 25, 6, 42);
  const bt = walkForward(y, 0);
  assert.ok(bt.windows >= 20);
  assert.ok(bt.metrics.model.mae < bt.metrics.seasonal_naive.mae, JSON.stringify(bt.metrics));
  assert.ok(bt.metrics.model.mae < bt.metrics.mean_7.mae, JSON.stringify(bt.metrics));
  assert.equal(bt.beatsBaselines, true);
  assert.ok(bt.modelErrorSigma > 0);
});

test('walk-forward uses no future data: changing the future does not change past forecasts', () => {
  const y = weeklySeries(120, 10, 2, 7);
  const y2 = y.slice(0, 63).concat(y.slice(63).map((v) => v * 10));
  // Forecast made at origin 56 only sees y[0..55], so the first window's predictions match.
  const a = forecast(y.slice(0, 56), 0, 7).forecast;
  const b = forecast(y2.slice(0, 56), 0, 7).forecast;
  assert.deepEqual(a, b);
});

test('walk-forward returns null when history is too short to score', () => {
  assert.equal(walkForward(new Array(40).fill(1), 0), null);
});

// ---------- reorder ----------
test('reorder = cover demand + z·σ·√L − usable − on order', () => {
  const r = reorderQuantity({ dailyForecast: new Array(14).fill(10), leadTimeDays: 4, reviewPeriodDays: 7,
    errorSigma: 3, usableStock: 40, onOrder: 20, z: 1.65 });
  close(r.demandOverCover, 110);
  close(r.safetyStock, 1.65 * 3 * 2);
  assert.equal(r.quantity, Math.ceil(110 + 9.9 - 60)); // 60
});

test('reorder is never negative and respects the owner minimum level', () => {
  const base = { dailyForecast: new Array(14).fill(1), leadTimeDays: 2, reviewPeriodDays: 7, errorSigma: 0 };
  assert.equal(reorderQuantity({ ...base, usableStock: 500, onOrder: 0 }).quantity, 0);
  assert.equal(reorderQuantity({ ...base, usableStock: 5, onOrder: 0, minLevel: 30 }).quantity, 25);
  assert.throws(() => reorderQuantity({ ...base, dailyForecast: [1], usableStock: 0, onOrder: 0 }));
});

// ---------- expiry risk ----------
test('expiry risk: FEFO simulation flags units that will not sell before expiry', () => {
  const batches = [
    { id: 1, batch_no: 'A', expiry_date: '2026-10-27', qty_on_hand: 30 }, // 10 days of selling at 2/day = 20 sold
    { id: 2, batch_no: 'B', expiry_date: '2027-10-31', qty_on_hand: 10 },
  ];
  const risk = simulateExpiryRisk(batches, () => 2, '2026-10-18');
  const a = risk.find((r) => r.batchId === 1);
  assert.equal(a.expectedSold, 20);
  assert.equal(a.atRisk, 10);
  assert.equal(a.suggestion, 'discount');
  assert.equal(risk.find((r) => r.batchId === 2).atRisk, 0);
});

test('expiry risk: big surplus far from expiry → return to supplier', () => {
  const risk = simulateExpiryRisk([{ id: 1, batch_no: 'T', expiry_date: '2027-03-31', qty_on_hand: 100 }], () => 0.1, '2026-10-18');
  assert.equal(risk[0].suggestion, 'return_to_supplier');
});
