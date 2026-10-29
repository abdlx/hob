import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Front-door acceptance only: no conversations, model calls, config writes or valid jobs. */
export async function auditHobInstance({ origin, password, expectedCommit, fetchImpl = fetch }) {
  const target = new URL(origin);
  if (target.protocol !== 'https:' || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('Use the exact HTTPS dashboard origin without credentials or a path.');
  origin = target.origin;
  if (typeof password !== 'string' || !password) throw new Error('An application password is required in memory.');
  const checks = [];
  const check = (name, passed, status) => checks.push({ name, passed: Boolean(passed), ...(status === undefined ? {} : { status }) });
  let cookie = '';
  const request = async (pathname, { method = 'GET', body, authenticated = false, requestOrigin = origin } = {}) => {
    const response = await fetchImpl(origin + pathname, {
      method, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { Accept: 'application/json', Origin: requestOrigin, ...(authenticated ? { Cookie: cookie, 'X-Hob-Profile': 'default' } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json().catch(() => null);
    return { response, value };
  };
  const startedAt = new Date().toISOString();
  const version = await request('/api/version');
  const routed = version.response.status === 200 && version.value?.runtime === 'hermes';
  check('the HTTPS front door reaches the HOB Hermes application', routed, version.response.status);
  if (!routed) return { origin, startedAt, completedAt: new Date().toISOString(), passed: false, routed: false, checks };
  const build = { commit: /^[a-f0-9]{40,64}$/.test(version.value.commit || '') ? version.value.commit : 'unknown', runtime: 'hermes' };
  if (expectedCommit) check('the deployed build matches the intended commit', build.commit === expectedCommit);
  for (const pathname of ['/api/sessions', '/api/hermes/setup/preferences?profile=default', '/api/hermes/workspace/files?profile=default', '/api/hermes/diagnostics/performance?profile=default']) {
    const { response } = await request(pathname);
    check(`unauthenticated ${pathname.split('?')[0]} is refused`, response.status === 401, response.status);
  }
  const login = await request('/api/auth/login', { method: 'POST', body: { password } });
  check('application login succeeds', login.response.status === 200 && login.value?.authenticated === true, login.response.status);
  const header = login.response.headers.get('set-cookie') || '';
  cookie = header.split(';')[0];
  if (login.response.status !== 200 || !cookie) return { origin, startedAt, completedAt: new Date().toISOString(), build, routed, passed: false, checks };
  check('the login cookie is HttpOnly', /;\s*HttpOnly(?:;|$)/i.test(header));
  check('the login cookie is Secure', /;\s*Secure(?:;|$)/i.test(header));
  check('the login cookie uses SameSite Strict', /;\s*SameSite=Strict(?:;|$)/i.test(header));
  try {
    const status = await request('/api/auth/status', { authenticated: true });
    check('the fresh authenticated session is recognized', status.value?.authenticated === true, status.response.status);
    const crossOrigin = await request('/api/auth/logout', { method: 'POST', authenticated: true, requestOrigin: 'https://hob-audit-forbidden.invalid' });
    check('cross-origin mutations are refused', crossOrigin.response.status === 403, crossOrigin.response.status);
    const unknown = await request('/api/hermes/workspace/files?profile=hob-audit-not-enrolled', { authenticated: true });
    check('an unenrolled bot cannot access a workspace', [400, 403, 404].includes(unknown.response.status), unknown.response.status);
    const traversal = await request('/api/hermes/workspace/download?profile=default&path=../profiles', { authenticated: true });
    check('workspace traversal is refused', [400, 403, 404].includes(traversal.response.status), traversal.response.status);
    for (const subsystem of ['memory', 'skills']) {
      const queue = await request(`/api/hermes/workspace/reviews/${subsystem}?profile=default`, { authenticated: true });
      check(`the native ${subsystem} review contract is available`, queue.response.status === 200 && Array.isArray(queue.value?.items) && queue.value.items.every(item => /^[a-f0-9]{64}$/.test(item.revision)), queue.response.status);
    }
    const preview = await request('/api/hermes/workspace/schedule-preview?profile=default', { method: 'POST', authenticated: true, body: { schedule: '0 9 * * *' } });
    check('the native schedule preview returns a next run and timezone', preview.response.status === 200 && preview.value?.valid === true && Number.isFinite(Date.parse(preview.value.nextRun)) && typeof preview.value.timezone === 'string', preview.response.status);
    const invalid = await request('/api/hermes/workspace/schedule-preview?profile=default', { method: 'POST', authenticated: true, body: { schedule: '99 99 * * *' } });
    check('an invalid schedule preview is refused without creating a job', [400, 422].includes(invalid.response.status), invalid.response.status);
  } finally {
    const logout = await request('/api/auth/logout', { method: 'POST', authenticated: true });
    check('the audit browser session can sign out', logout.response.status === 200 && logout.value?.authenticated === false, logout.response.status);
    cookie = '';
  }
  return { origin, startedAt, completedAt: new Date().toISOString(), build, routed, passed: checks.every(item => item.passed), checks };
}

if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [output] = process.argv.slice(2);
  if (!output) throw new Error('Usage: set HOB_AUDIT_BASE_URL and HOB_AUDIT_PASSWORD privately, then run node deploy/live-acceptance.mjs report.json');
  try {
    const report = await auditHobInstance({ origin: process.env.HOB_AUDIT_BASE_URL, password: process.env.HOB_AUDIT_PASSWORD, expectedCommit: process.env.HOB_AUDIT_EXPECT_COMMIT });
    await writeFile(resolve(output), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(`${report.checks.filter(item => item.passed).length}/${report.checks.length} live checks passed; report saved.`);
    if (!report.passed) process.exitCode = 1;
  } catch { console.error('Live acceptance did not finish. No credentials or upstream response bodies were logged.'); process.exitCode = 1; }
}
