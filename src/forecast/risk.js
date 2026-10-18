// Expiry-risk simulation: "play" the forecast forward day by day, selling FEFO, and see which
// batches still hold stock when they expire. Uses expected (fractional) demand.
import { addDays, diffDays } from '../dates.js';

/**
 * @param {{id, batch_no, expiry_date, qty_on_hand}[]} batches  sellable batches of one product
 * @param {(dayIndex: number) => number} demandAt  expected demand for today + dayIndex
 * @param {string} day  today
 * @param {number} [maxDays=365]
 */
export function simulateExpiryRisk(batches, demandAt, day, maxDays = 365) {
  const live = batches
    .filter((b) => b.qty_on_hand > 0 && b.expiry_date >= day)
    .map((b) => ({ ...b, left: b.qty_on_hand }))
    .sort((a, b) => (a.expiry_date === b.expiry_date ? a.id - b.id : a.expiry_date < b.expiry_date ? -1 : 1));
  if (!live.length) return [];

  const lastExpiry = live[live.length - 1].expiry_date;
  const days = Math.min(maxDays, diffDays(lastExpiry, day) + 1);
  for (let k = 0; k < days; k++) {
    const d = addDays(day, k);
    let demand = demandAt(k);
    for (const b of live) {
      if (demand <= 0) break;
      if (b.expiry_date < d || b.left <= 0) continue;
      const take = Math.min(b.left, demand);
      b.left -= take;
      demand -= take;
    }
  }

  return live.map((b) => {
    const atRisk = Math.floor(b.left + 1e-9);
    const daysLeft = diffDays(b.expiry_date, day);
    return {
      batchId: b.id,
      batchNo: b.batch_no,
      expiryDate: b.expiry_date,
      daysLeft,
      qtyOnHand: b.qty_on_hand,
      expectedSold: b.qty_on_hand - atRisk,
      atRisk,
      suggestion: suggest(atRisk, b.qty_on_hand, daysLeft),
      horizonCapped: diffDays(b.expiry_date, day) >= maxDays,
    };
  });
}

/** Heuristic: far from expiry with a big surplus → return to supplier; otherwise discount to move it. */
export function suggest(atRisk, onHand, daysLeft) {
  if (atRisk <= 0) return 'none';
  if (daysLeft >= 90 && atRisk / onHand >= 0.5) return 'return_to_supplier';
  return 'discount';
}
