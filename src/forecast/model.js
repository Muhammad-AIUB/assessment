// Demand model: exponentially smoothed "level" + a day-of-week seasonal effect
// (a simplified, trend-free Holt-Winters). Pure functions, no dependencies.
//
// Multiplicative form (weekday effect is a factor):
//   forecast(t+h) = level_t × season[dow(t+h)]
//   level_t       = α · (y_t / season[dow t]) + (1 − α) · level_{t−1}
//   season[dow t] = γ · (y_t / level_t)       + (1 − γ) · season[dow t]
// Additive form (weekday effect is a number of units):
//   forecast(t+h) = level_t + season[dow(t+h)]
//   level_t       = α · (y_t − season[dow t]) + (1 − α) · level_{t−1}
//   season[dow t] = γ · (y_t − level_t)       + (1 − γ) · season[dow t]
//
// The multiplicative form divides by the weekday index. When a weekday is nearly "closed"
// (index ≈ 0.01), one normal sale on that day becomes 100× the level and the forecast explodes.
// That is exactly what happened on the real pharmacy dataset (quiet Sundays/Mondays). So the form
// is chosen per series like α and γ, by validation MAE, and multiplicative is not allowed when any
// weekday index is below MIN_MULT_INDEX. The additive form has no division and is stable there.
//
// Weekday effects are initialised from the whole training window (four weeks alone is too noisy
// for a ±15 % weekly effect). Whatever the form, the fitted state is returned as
// level × weekday factor, so callers (reorder, expiry risk, UI) don't need to know which was used.

export const SEASON_LENGTH = 7;
export const MIN_HISTORY = 28;      // below this we fall back to a plain mean + "low confidence"
export const VALIDATION_DAYS = 28;   // tuned with 4 rolling 7-day-ahead origins
export const VALIDATION_STEP = 7;
export const ALPHA_GRID = [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.7];
export const GAMMA_GRID = [0, 0.05, 0.1, 0.2, 0.3];
export const FORMS = ['multiplicative', 'additive'];
export const MIN_MULT_INDEX = 0.2;   // a weekday selling < 20 % of average rules out the multiplicative form

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
 * @param {'multiplicative'|'additive'} form
 * @returns {{ level: number, season: number[], nextDow: number, form: string }}  season = weekday factors
 */
export function fit(y, startDow, alpha, gamma, form = 'multiplicative') {
  return form === 'additive' ? fitAdditive(y, startDow, alpha, gamma) : fitMultiplicative(y, startDow, alpha, gamma);
}

function fitMultiplicative(y, startDow, alpha, gamma) {
  let { level, season } = initialState(y, startDow);
  season = season.slice();
  for (let i = 0; i < y.length; i++) {
    const d = (startDow + i) % SEASON_LENGTH;
    const s = season[d];
    // Floor the divisor: even when allowed, an index can drift low through γ updates.
    const deseasonalised = y[i] / Math.max(s, MIN_MULT_INDEX);
    level = alpha * deseasonalised + (1 - alpha) * level;
    if (level > EPS) season[d] = gamma * (y[i] / level) + (1 - gamma) * s;
  }
  // Keep indices averaging to 1 so "level" stays interpretable as average daily demand.
  const sMean = mean(season);
  if (sMean > EPS) {
    season = season.map((s) => s / sMean);
    level *= sMean;
  }
  return { level: Math.max(level, 0), season, nextDow: (startDow + y.length) % SEASON_LENGTH, form: 'multiplicative' };
}

function fitAdditive(y, startDow, alpha, gamma) {
  const init = initialState(y, startDow);
  const overall = mean(y);
  let level = init.level;
  let season = init.season.map((f) => (f - 1) * overall); // factor → units above/below average
  for (let i = 0; i < y.length; i++) {
    const d = (startDow + i) % SEASON_LENGTH;
    level = alpha * (y[i] - season[d]) + (1 - alpha) * level;
    season[d] = gamma * (y[i] - level) + (1 - gamma) * season[d];
  }
  // Centre the effects on 0 (so level = average daily demand), then express them as factors.
  const sMean = mean(season);
  season = season.map((s) => s - sMean);
  level += sMean;
  const nextDow = (startDow + y.length) % SEASON_LENGTH;
  if (level <= EPS) return { level: 0, season: new Array(SEASON_LENGTH).fill(1), nextDow, form: 'additive' };
  return { level, season: season.map((s) => Math.max(0, level + s) / level), nextDow, form: 'additive' };
}

export function predict(state, horizon) {
  const out = [];
  for (let h = 0; h < horizon; h++) out.push(state.level * state.season[(state.nextDow + h) % SEASON_LENGTH]);
  return out;
}

/** Forms allowed for this series: multiplicative only if no weekday is (almost) a closed day. */
export function allowedForms(y, startDow) {
  return Math.min(...initialState(y, startDow).season) >= MIN_MULT_INDEX ? FORMS : ['additive'];
}

/**
 * Grid-search form, α and γ minimising MAE on the last `valDays` of the series, scored the way the
 * model is used: from each origin in the validation tail (every `step` days) forecast `step` days ahead.
 */
export function selectParams(y, startDow, valDays = VALIDATION_DAYS, step = VALIDATION_STEP) {
  const firstOrigin = y.length - valDays;
  let best = { form: 'multiplicative', alpha: 0.2, gamma: 0.1, mae: Infinity };
  for (const form of allowedForms(y.slice(0, firstOrigin), startDow)) {
    for (const alpha of ALPHA_GRID) {
      for (const gamma of GAMMA_GRID) {
        let err = 0, n = 0;
        for (let t = firstOrigin; t < y.length; t += step) {
          const h = Math.min(step, y.length - t);
          const pred = predict(fit(y.slice(0, t), startDow, alpha, gamma, form), h);
          for (let i = 0; i < h; i++) err += Math.abs(y[t + i] - pred[i]);
          n += h;
        }
        const mae = err / n;
        if (mae < best.mae - 1e-12) best = { form, alpha, gamma, mae }; // strict: earlier (smoother) wins ties
      }
    }
  }
  return best;
}

/**
 * Forecast the next `horizon` days.
 * @returns {{ forecast: number[], method: 'seasonal_es'|'mean', confidence: 'normal'|'low', seasonality?: string,
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
  const valDays = Math.min(VALIDATION_DAYS, y.length - MIN_HISTORY);
  const params = valDays >= SEASON_LENGTH ? selectParams(y, startDow, valDays)
    : { form: allowedForms(y, startDow).at(-1), alpha: 0.2, gamma: 0.1, mae: null };
  const state = fit(y, startDow, params.alpha, params.gamma, params.form);
  return {
    forecast: predict(state, horizon),
    method: 'seasonal_es',
    confidence: 'normal',
    seasonality: params.form,
    alpha: params.alpha,
    gamma: params.gamma,
    validationMae: params.mae,
    level: state.level,
    season: state.season,
  };
}
