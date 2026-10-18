import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripCosts } from '../src/routes/api.js';

test('stripCosts removes purchase prices at any depth for staff', () => {
  const out = stripCosts([{ id: 1, unit_cost: 9, items: [{ qty: 2, unitCost: 4 }] }]);
  assert.deepEqual(out, [{ id: 1, items: [{ qty: 2 }] }]);
});

test('stripCosts leaves timestamps and other non-plain values intact', () => {
  const at = new Date('2026-10-14T09:00:00Z');
  const out = stripCosts({ ordered_at: at, note: null, n: 0 });
  assert.equal(out.ordered_at, at);
  assert.equal(JSON.parse(JSON.stringify(out)).ordered_at, '2026-10-14T09:00:00.000Z');
  assert.equal(out.note, null);
});
