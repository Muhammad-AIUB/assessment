// Reorder recommendation — this is where the backtest's error estimate becomes business logic.
//
//   order = forecast demand over (lead time + review period)
//         + safety stock
//         − usable stock (expired excluded)
//         − quantity already on open (Ordered) purchase orders
//
//   safety stock = z × σ(daily forecast error) × √(lead time)      z ≈ 1.65 for 95 % service

export const Z_95 = 1.65;

/**
 * @param {object} p
 * @param {number[]} p.dailyForecast   at least leadTimeDays + reviewPeriodDays values
 * @param {number}   p.leadTimeDays
 * @param {number}   p.reviewPeriodDays
 * @param {number}   p.errorSigma       σ of daily forecast error (from the walk-forward backtest)
 * @param {number}   p.usableStock      non-expired, non-written-off units on hand
 * @param {number}   p.onOrder          units on Ordered (not yet received) POs
 * @param {number}  [p.minLevel=0]      owner's floor: never let projected position drop below this
 * @param {number}  [p.z=Z_95]
 */
export function reorderQuantity({ dailyForecast, leadTimeDays, reviewPeriodDays, errorSigma, usableStock, onOrder, minLevel = 0, z = Z_95 }) {
  const coverDays = leadTimeDays + reviewPeriodDays;
  if (dailyForecast.length < coverDays) throw new Error(`need ${coverDays} forecast days, got ${dailyForecast.length}`);

  const demandOverCover = dailyForecast.slice(0, coverDays).reduce((a, b) => a + b, 0);
  const safetyStock = z * errorSigma * Math.sqrt(leadTimeDays);
  const position = usableStock + onOrder;
  const target = Math.max(demandOverCover + safetyStock, minLevel);
  const quantity = Math.max(0, Math.ceil(target - position));

  return {
    quantity,
    coverDays,
    demandOverCover,
    safetyStock,
    usableStock,
    onOrder,
    minLevel,
    z,
    errorSigma,
  };
}
