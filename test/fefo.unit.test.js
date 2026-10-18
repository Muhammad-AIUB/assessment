import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateFefo, shortageMessage } from '../src/domain/fefo.js';
import { batchStatus } from '../src/domain/batchStatus.js';
import { parseExpiry } from '../src/dates.js';

const TODAY = '2026-10-18';
const b = (id, expiry_date, qty_on_hand) => ({ id, expiry_date, qty_on_hand });

test('FEFO takes earliest-expiring batch first, regardless of input order', () => {
  const r = allocateFefo([b(1, '2027-06-30', 10), b(2, '2026-12-31', 10)], 4, TODAY);
  assert.deepEqual(r, { ok: true, picks: [{ batchId: 2, qty: 4 }] });
});

test('FEFO spans multiple batches when one is not enough', () => {
  const r = allocateFefo([b(1, '2027-06-30', 10), b(2, '2026-12-31', 3), b(3, '2027-01-31', 2)], 8, TODAY);
  assert.deepEqual(r.picks, [{ batchId: 2, qty: 3 }, { batchId: 3, qty: 2 }, { batchId: 1, qty: 3 }]);
});

test('FEFO skips expired batches but a batch is sellable ON its expiry day', () => {
  const r = allocateFefo([b(1, '2026-10-17', 50), b(2, TODAY, 2), b(3, '2027-01-31', 5)], 4, TODAY);
  assert.deepEqual(r.picks, [{ batchId: 2, qty: 2 }, { batchId: 3, qty: 2 }]);
});

test('same expiry → older batch (lower id) first, deterministically', () => {
  const r = allocateFefo([b(9, '2027-01-31', 5), b(4, '2027-01-31', 5)], 6, TODAY);
  assert.deepEqual(r.picks, [{ batchId: 4, qty: 5 }, { batchId: 9, qty: 1 }]);
});

test('insufficient stock reports sellable and expired quantities, takes nothing', () => {
  const r = allocateFefo([b(1, '2026-09-30', 3), b(2, '2027-01-31', 5), b(3, '2027-02-28', 0)], 6, TODAY);
  assert.deepEqual(r, { ok: false, sellable: 5, expiredQty: 3, requested: 6 });
  assert.equal(shortageMessage(r), 'বিক্রয়যোগ্য stock 5 (3টা মেয়াদোত্তীর্ণ বাদ)');
});

test('shortage message omits the expired note when nothing is expired', () => {
  assert.equal(shortageMessage({ sellable: 2, expiredQty: 0 }), 'বিক্রয়যোগ্য stock 2');
});

test('rejects non-positive or fractional quantities', () => {
  assert.throws(() => allocateFefo([], 0, TODAY));
  assert.throws(() => allocateFefo([], 1.5, TODAY));
});

test('expiry printed as month/year is valid through the last day of that month', () => {
  assert.equal(parseExpiry('2027-02'), '2027-02-28');
  assert.equal(parseExpiry('02/2028'), '2028-02-29'); // leap year
  assert.equal(parseExpiry('2026-12'), '2026-12-31');
  assert.equal(parseExpiry('2026-11-15'), '2026-11-15');
  assert.throws(() => parseExpiry('2026-13'));
  assert.throws(() => parseExpiry('2026-02-30'));
  assert.throws(() => parseExpiry('soon'));
});

test('batch status lifecycle: active → near expiry → expired; written off wins', () => {
  const s = (expiry_date, extra = {}) => batchStatus({ expiry_date, qty_on_hand: 5, state: 'active', ...extra }, TODAY, 60);
  assert.equal(s('2027-06-30'), 'active');
  assert.equal(s('2026-12-17'), 'near_expiry'); // exactly 60 days
  assert.equal(s(TODAY), 'near_expiry');
  assert.equal(s('2026-10-17'), 'expired');
  assert.equal(s('2026-10-17', { state: 'written_off', qty_on_hand: 0 }), 'written_off');
  assert.equal(s('2027-06-30', { qty_on_hand: 0 }), 'depleted');
});
