import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMonthGrid, eventDateKeys, formatDateRange, formatEmailTabLabel, formatSenderDisplay } from '../public/calendar-model.js';

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

test('email history tabs use the compact Shanghai date-time label', () => {
  assert.equal(formatEmailTabLabel('2026-09-11T02:37:00.000Z'), '09-11 10:37');
});

test('email sender display removes angle-bracket address details', () => {
  assert.equal(
    formatSenderDisplay('示例旅行集团(Example Travel Group) <no-reply@travel.example.test>'),
    '示例旅行集团(Example Travel Group)',
  );
  assert.equal(formatSenderDisplay('<no-reply@example.test>'), '招聘团队');
  assert.equal(formatSenderDisplay('招聘团队'), '招聘团队');
});
