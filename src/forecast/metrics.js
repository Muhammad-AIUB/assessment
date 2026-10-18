// Error metrics. All take parallel arrays of actuals and predictions.

export function mae(actual, pred) {
  if (!actual.length) return null;
  let s = 0;
  for (let i = 0; i < actual.length; i++) s += Math.abs(actual[i] - pred[i]);
  return s / actual.length;
}

/** Weighted APE = Σ|error| / Σ actual. Robust to zero-sale days; null if nothing was sold. */
export function wape(actual, pred) {
  let err = 0, tot = 0;
  for (let i = 0; i < actual.length; i++) {
    err += Math.abs(actual[i] - pred[i]);
    tot += actual[i];
  }
  return tot > 0 ? err / tot : null;
}

/** MAPE only over days with sales > 0 (undefined when actual = 0). Reports how many days counted. */
export function mape(actual, pred) {
  let s = 0, n = 0;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] > 0) {
      s += Math.abs(actual[i] - pred[i]) / actual[i];
      n++;
    }
  }
  return { value: n ? s / n : null, days: n };
}

export function stdDev(xs) {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export function summarise(actual, pred) {
  const m = mape(actual, pred);
  return { mae: mae(actual, pred), wape: wape(actual, pred), mape: m.value, mapeDays: m.days, n: actual.length };
}
