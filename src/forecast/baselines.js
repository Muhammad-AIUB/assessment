// Naive baselines the model must beat to justify itself.

/** "Same weekday last week": tomorrow's forecast = value 7 days before it. */
export function seasonalNaive(y, horizon) {
  const n = y.length;
  if (n < 7) return new Array(horizon).fill(n ? y[n - 1] : 0);
  return Array.from({ length: horizon }, (_, h) => y[n - 7 + (h % 7)]);
}

/** "Mean of the last 7 days", flat across the horizon. */
export function movingAverage7(y, horizon) {
  const last = y.slice(-7);
  const m = last.length ? last.reduce((a, b) => a + b, 0) / last.length : 0;
  return new Array(horizon).fill(m);
}
