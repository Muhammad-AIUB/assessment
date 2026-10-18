// Walk-forward backtest: train on everything before an origin, forecast the next `horizon`
// days, score, slide the origin forward by `step`, repeat. Parameters are re-tuned at every
// origin using only past data, so there is no look-ahead leakage.
import { forecast } from './model.js';
import { seasonalNaive, movingAverage7 } from './baselines.js';
import { summarise, stdDev } from './metrics.js';

export const MODELS = {
  model: (y, dow, h) => forecast(y, dow, h).forecast,
  seasonal_naive: (y, _dow, h) => seasonalNaive(y, h),
  mean_7: (y, _dow, h) => movingAverage7(y, h),
};

/**
 * @param {number[]} y          daily demand, oldest first
 * @param {number}   startDow   weekday of y[0]
 * @returns {{ windows: number, metrics: Record<string, ReturnType<typeof summarise>>,
 *             modelErrorSigma: number, beatsBaselines: boolean, winner: string } | null}
 */
export function walkForward(y, startDow, { horizon = 7, minTrain = 56, step = 7, maxWindows = 26 } = {}) {
  const origins = [];
  for (let t = minTrain; t + horizon <= y.length; t += step) origins.push(t);
  const used = origins.slice(-maxWindows); // most recent windows (bounded cost)
  if (!used.length) return null;

  const actual = [];
  const preds = Object.fromEntries(Object.keys(MODELS).map((k) => [k, []]));
  for (const t of used) {
    const train = y.slice(0, t);
    actual.push(...y.slice(t, t + horizon));
    for (const [name, fn] of Object.entries(MODELS)) preds[name].push(...fn(train, startDow, horizon));
  }

  const metrics = Object.fromEntries(Object.entries(preds).map(([k, p]) => [k, summarise(actual, p)]));
  const errors = actual.map((a, i) => a - preds.model[i]);
  const bestBaselineMae = Math.min(metrics.seasonal_naive.mae, metrics.mean_7.mae);
  const winner = Object.entries(metrics).sort((a, b) => a[1].mae - b[1].mae)[0][0];

  return {
    windows: used.length,
    metrics,
    modelErrorSigma: stdDev(errors), // σ of daily forecast error → feeds safety stock
    beatsBaselines: metrics.model.mae < bestBaselineMae,
    winner,
  };
}
