// Demand model: exponential-smoothing "level" × day-of-week seasonal index
// (a simplified, trend-free multiplicative Holt-Winters). Pure functions, no dependencies.
//
//   forecast(t+h) = level_t × season[dow(t+h)]
//   level_t       = α · (y_t / season[dow t]) + (1 − α) · level_{t−1}
//   season[dow t] = γ · (y_t / level_t)       + (1 − γ) · season[dow t]
//
// α and γ are chosen by grid search to minimise 7-day-ahead MAE on a held-out validation tail.
// Weekday indices are initialised from the whole training window (ratio of each weekday's mean
// to the overall mean) — four weeks alone is too noisy for a ±15 % weekly effect.

export const SEASON_LENGTH = 7;
export const MIN_HISTORY = 28;      // below this we fall back to a plain mean + "low confidence"
export const VALIDATION_DAYS = 28;   // tuned with 4 rolling 7-day-ahead origins
export const VALIDATION_STEP = 7;
export const ALPHA_GRID = [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.7];
export const GAMMA_GRID = [0, 0.05, 0.1, 0.2, 0.3];

const EPS = 1e-9;
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Initial level from the first 4 weeks; weekday indices from the whole (training) series. */
export function initialState(y, startDow) {
  const level = mean(y.slice(0, Math.min(y.length, MIN_HISTORY)));
  const overall = mean(y);
  const season = new Array(SEASON_LENGTH).fill(1);
  if (overall > EPS) {
    for (let d = 0; d < SEASON_LENGTH; d++) {
      const vals = [];
      for (let i = 0; i < y.length; i++) if ((startDow + i) % SEASON_LENGTH === d) vals.push(y[i]);
      if (vals.length) season[d] = mean(vals) / overall;
    }
  }
  return { level, season };
}

/**
 * Run the smoothing recursion over the whole series.
 * @param {number[]} y        daily demand, oldest first, no gaps (zeros for no-sale days)
 * @param {number}   startDow weekday of y[0] (0 = Mon)
 * @returns {{ level: number, season: number[], nextDow: number }}
 */
export function fit(y, startDow, alpha, gamma) {
  let { level, season } = initialState(y, startDow);
  season = season.slice();
  for (let i = 0; i < y.length; i++) {
    const d = (startDow + i) % SEASON_LENGTH;
    const s = season[d];
    const deseasonalised = s > EPS ? y[i] / s : y[i];
    level = alpha * deseasonalised + (1 - alpha) * level;
    if (level > EPS) season[d] = gamma * (y[i] / level) + (1 - gamma) * s;
  }
  // Keep indices averaging to 1 so "level" stays interpretable as average daily demand.
  const sMean = mean(season);
  if (sMean > EPS) {
    season = season.map((s) => s / sMean);
    level *= sMean;
  }
  return { level: Math.max(level, 0), season, nextDow: (startDow + y.length) % SEASON_LENGTH };
}

export function predict(state, horizon) {
  const out = [];
  for (let h = 0; h < horizon; h++) out.push(state.level * state.season[(state.nextDow + h) % SEASON_LENGTH]);
  return out;
}

/**
 * Grid-search α, γ minimising MAE on the last `valDays` of the series, scored the way the model
 * is used: from each origin in the validation tail (every `step` days) forecast `step` days ahead.
 */
export function selectParams(y, startDow, valDays = VALIDATION_DAYS, step = VALIDATION_STEP) {
  const firstOrigin = y.length - valDays;
  let best = { alpha: 0.2, gamma: 0.1, mae: Infinity };
  for (const alpha of ALPHA_GRID) {
    for (const gamma of GAMMA_GRID) {
      let err = 0, n = 0;
      for (let t = firstOrigin; t < y.length; t += step) {
        const h = Math.min(step, y.length - t);
        const pred = predict(fit(y.slice(0, t), startDow, alpha, gamma), h);
        for (let i = 0; i < h; i++) err += Math.abs(y[t + i] - pred[i]);
        n += h;
      }
      const mae = err / n;
      if (mae < best.mae - 1e-12) best = { alpha, gamma, mae }; // strict: earlier (smoother) wins ties
    }
  }
  return best;
}

/**
 * Forecast the next `horizon` days.
 * @returns {{ forecast: number[], method: 'seasonal_es'|'mean', confidence: 'normal'|'low',
 *             alpha?: number, gamma?: number, validationMae?: number, level: number, season: number[] }}
 */
export function forecast(y, startDow, horizon) {
  if (y.length < MIN_HISTORY) {
    const level = mean(y);
    return {
      forecast: new Array(horizon).fill(level),
      method: 'mean',
      confidence: 'low',
      level,
      season: new Array(SEASON_LENGTH).fill(1),
    };
  }
  // Need at least MIN_HISTORY days left for training after carving out validation.
  const valDays = Math.min(VALIDATION_DAYS, y.length - MIN_HISTORY);  // keep ≥ 28 days to train on
  const params = valDays >= SEASON_LENGTH ? selectParams(y, startDow, valDays) : { alpha: 0.2, gamma: 0.1, mae: null };
  const state = fit(y, startDow, params.alpha, params.gamma);
  return {
    forecast: predict(state, horizon),
    method: 'seasonal_es',
    confidence: 'normal',
    alpha: params.alpha,
    gamma: params.gamma,
    validationMae: params.mae,
    level: state.level,
    season: state.season,
  };
}
