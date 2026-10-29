import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scheduleProblem } from '../schedule-input.mjs';

test('schedule input rejects malformed or past input before native validation', () => {
  const now = Date.parse('2026-10-29T00:00:00Z');
  for (const value of ['', '   ', 'whenever', '0h', 'every 0h', '99 99 * * *', '*/0 * * * *', '* * * *', '2020-01-01T00:00:00Z', '2026-99-99', '0 9 * * * extra', '10-2 9 * * *', '0 JAN * * *']) {
    assert.equal(typeof scheduleProblem(value, now), 'string', value);
  }
  for (const value of ['0 9 * * *', '*/15 8-17 * JAN MON-FRI', '0 9 * * * 15', 'every 2h', 'in 30m', '5m', '2027-01-01T09:00:00+05:00']) {
    assert.equal(scheduleProblem(value, now), null, value);
  }
});
