// Pure FEFO (First-Expiry-First-Out) allocation. No I/O — the sales service feeds it rows it
// has already locked, and the seed simulator / expiry-risk simulation reuse the same rule.

/**
 * @typedef {{ id: number|string, expiry_date: string, qty_on_hand: number }} BatchLike
 * @param {BatchLike[]} batches  candidate batches for ONE product (any order)
 * @param {number} qty           units requested (positive integer)
 * @param {string} day           'YYYY-MM-DD' sale date; a batch is sellable through its expiry date inclusive
 * @returns {{ ok: true, picks: {batchId, qty}[] } |
 *           { ok: false, sellable: number, expiredQty: number, requested: number }}
 */
export function allocateFefo(batches, qty, day) {
  if (!Number.isInteger(qty) || qty <= 0) throw new Error('qty must be a positive integer');

  let expiredQty = 0;
  const sellable = [];
  for (const b of batches) {
    if (b.qty_on_hand <= 0) continue;
    if (b.expiry_date < day) expiredQty += b.qty_on_hand; // ISO strings compare chronologically
    else sellable.push(b);
  }
  // Earliest expiry first; tie-break on id (older receipt) so the result is deterministic.
  sellable.sort((a, b) =>
    a.expiry_date === b.expiry_date ? Number(a.id) - Number(b.id) : a.expiry_date < b.expiry_date ? -1 : 1);

  const available = sellable.reduce((s, b) => s + b.qty_on_hand, 0);
  if (available < qty) return { ok: false, sellable: available, expiredQty, requested: qty };

  const picks = [];
  let remaining = qty;
  for (const b of sellable) {
    if (remaining === 0) break;
    const take = Math.min(remaining, b.qty_on_hand);
    picks.push({ batchId: b.id, qty: take });
    remaining -= take;
  }
  return { ok: true, picks };
}

/** The user-facing shortage message required by the spec. */
export function shortageMessage({ sellable, expiredQty }) {
  const extra = expiredQty > 0 ? ` (${expiredQty}টা মেয়াদোত্তীর্ণ বাদ)` : '';
  return `বিক্রয়যোগ্য stock ${sellable}${extra}`;
}
