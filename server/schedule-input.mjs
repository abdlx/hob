/** Input validation only. Native Hermes remains the schedule parser and execution owner. */
export function scheduleProblem(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) return 'Enter a schedule of at most 200 characters.';
  const schedule = value.trim();
  if (/^(?:every |in )?\d+(?:\.\d+)?\s*[smhdw]$/i.test(schedule)) {
    return Number(schedule.match(/\d+(?:\.\d+)?/)[0]) > 0 ? null : 'The interval must be greater than zero.';
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(schedule)) {
    const time = Date.parse(schedule);
    return Number.isFinite(time) && time > now ? null : 'Choose a valid future date and time.';
  }
  if (/^(?:every )?(?:day|weekdays|weekends|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?: at)? \d{1,2}(?::\d{2})?\s*(?:am|pm)?$/i.test(schedule)) return null;
  const fields = schedule.split(/\s+/);
  if (![5, 6].includes(fields.length)) return 'Use a cron expression, an interval such as every 2h, or a future ISO date.';
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7], [0, 59]];
  const names = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12, SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
  for (let index = 0; index < fields.length; index++) {
    const [min, max] = ranges[index];
    const words = fields[index].toUpperCase().match(/[A-Z]{3}/g) || [];
    if (words.some(name => index === 3 ? !(name in names) || names[name] < 1 || /^(SUN|MON|TUE|WED|THU|FRI|SAT)$/.test(name) : index === 4 ? !/^(SUN|MON|TUE|WED|THU|FRI|SAT)$/.test(name) : true)) return 'Named months and weekdays belong in their respective cron fields.';
    const field = fields[index].toUpperCase().replace(/[A-Z]{3}/g, name => Object.hasOwn(names, name) ? String(names[name]) : name);
    if (!/^[\d*,/\-]+$/.test(field)) return 'Use numbers, named months/weekdays, ranges, lists, and steps in cron fields.';
    for (const part of field.split(',')) {
      const [base, step, extra] = part.split('/');
      if (!base || extra !== undefined || (step !== undefined && (!/^\d+$/.test(step) || Number(step) < 1))) return 'Cron steps must be positive whole numbers.';
      if (base === '*') continue;
      const bounds = base.split('-');
      if (bounds.length > 2 || bounds.some(item => !/^\d+$/.test(item) || Number(item) < min || Number(item) > max)) return `Cron field ${index + 1} must be between ${min} and ${max}.`;
      if (bounds.length === 2 && Number(bounds[0]) > Number(bounds[1])) return 'Cron ranges must be in ascending order.';
    }
  }
  return null;
}
