// Native clock/parser acceptance in a fresh disposable image only.
import assert from 'node:assert/strict';

export async function scheduleClockSmoke({ api, workspace, check }) {
  const previous = await api('/api/hermes/setup/preferences');
  const { language, maxTurns, runBudgetSeconds } = previous;
  const saveZone = timezone => api('/api/hermes/setup/preferences', 'PUT', { language, maxTurns, runBudgetSeconds, timezone, confirm: true });
  const preview = (schedule, after) => workspace('schedule-preview', 'POST', { schedule, ...(after ? { after } : {}) });
  try {
    const jobs = await workspace('jobs'); assert.ok(Array.isArray(jobs));
    const count = jobs.length;
    await saveZone('UTC');
    assert.equal((await preview('0 9 * * *')).timezone, 'UTC');
    await saveZone('America/New_York');
    check('native preview adopts a saved timezone without restarting the process', (await preview('0 9 * * *')).timezone === 'America/New_York');
    const cases = [
      ['daily cron keeps 9 AM across spring DST', '0 9 * * *', '2027-03-13T09:01:00-05:00', '2027-03-14T09:00:00-04:00'],
      ['daily cron keeps 9 AM across autumn DST', '0 9 * * *', '2027-11-06T09:01:00-04:00', '2027-11-07T09:00:00-05:00'],
      ['an autumn repeated-hour preview is strictly after its reference', '30 1 * * *', '2027-11-07T01:15:00-05:00', '2027-11-07T01:30:00-05:00'],
      ['intervals retain elapsed duration across spring DST', 'every 2h', '2027-03-14T00:30:00-05:00', '2027-03-14T03:30:00-04:00'],
      ['a spring skipped-time preview follows the pinned native instant', '30 2 * * *', '2027-03-14T01:59:00-05:00', '2027-03-14T03:30:00-04:00'],
    ];
    for (const [name, schedule, after, expected] of cases) {
      const result = await preview(schedule, after);
      check(name, result.valid === true && result.timezone === 'America/New_York' && Date.parse(result.nextRun) === Date.parse(expected) && Date.parse(result.nextRun) > Date.parse(after));
    }
    const after = await workspace('jobs'); assert.ok(Array.isArray(after));
    check('native reference previews do not create trial jobs', after.length === count);
  } finally { await saveZone(previous.timezone); }
}
