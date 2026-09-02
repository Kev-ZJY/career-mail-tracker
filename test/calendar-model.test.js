import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMonthGrid, eventDateKeys, formatDateRange } from '../public/calendar-model.js';

test('event date ranges include every calendar day in an assessment window', () => {
  assert.deepEqual(eventDateKeys('2026-08-09T15:45:00.000Z', '2026-08-12T15:59:00.000Z'), ['2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12']);
  assert.equal(formatDateRange('2026-08-09T15:45:00.000Z', '2026-08-12T15:59:00.000Z'), '8月9日–8月12日');
});

test('month grid always renders six weeks and keeps outside dates marked', () => {
  const grid = buildMonthGrid(2026, 7, []);
  assert.equal(grid.length, 42);
  assert.equal(grid.filter((cell) => cell.inMonth).length, 31);
  assert.equal(grid[0].inMonth, false);
});
