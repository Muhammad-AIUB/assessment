import { diffDays } from '../dates.js';

export const BATCH_STATUS = Object.freeze({
  ACTIVE: 'active',
  NEAR_EXPIRY: 'near_expiry',
  EXPIRED: 'expired',
  WRITTEN_OFF: 'written_off',
  DEPLETED: 'depleted',
});

/**
 * Lifecycle: Active → Near Expiry (≤ nearDays left) → Expired → Written Off.
 * Derived from dates on read, so it is always correct for "today".
 */
export function batchStatus(batch, day, nearDays) {
  if (batch.state === 'written_off') return BATCH_STATUS.WRITTEN_OFF;
  if (batch.qty_on_hand === 0) return BATCH_STATUS.DEPLETED;
  const daysLeft = diffDays(batch.expiry_date, day);
  if (daysLeft < 0) return BATCH_STATUS.EXPIRED;
  if (daysLeft <= nearDays) return BATCH_STATUS.NEAR_EXPIRY;
  return BATCH_STATUS.ACTIVE;
}
