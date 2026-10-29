import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditHobInstance } from './live-acceptance.mjs';

test('a proxy 404 prevents sending a password to an unrouted deployment', async () => {
  const calls = [];
  const report = await auditHobInstance({ origin: 'https://hob.example.test', password: 'DO_NOT_LOG', fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response('404 page not found', { status: 404 }); } });
  assert.equal(report.routed, false); assert.equal(report.passed, false); assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'GET'); assert.doesNotMatch(JSON.stringify(report), /DO_NOT_LOG/);
});

test('a rejected login leaves cookie and authenticated checks untested, not reported as security failures', async () => {
  const report = await auditHobInstance({ origin: 'https://hob.example.test', password: 'DO_NOT_LOG', fetchImpl: async url => new Response(JSON.stringify(url.endsWith('/api/version') ? { runtime: 'hermes', commit: 'unknown' } : {}), { status: url.endsWith('/api/version') ? 200 : 401 }) });
  assert.equal(report.passed, false); assert.equal(report.checks.filter(item => !item.passed).length, 1);
  assert.equal(report.checks.at(-1).name, 'application login succeeds');
  assert.equal(report.checks.some(item => item.name.includes('cookie')), false);
});

test('live acceptance records only checked contracts and makes no inference or configuration writes', async () => {
  const calls = [];
  const report = await auditHobInstance({ origin: 'https://hob.example.test', password: 'DO_NOT_LOG', expectedCommit: 'a'.repeat(40), fetchImpl: async (url, options) => {
    const pathname = new URL(url).pathname; calls.push({ pathname, options });
    const json = (body, status = 200, headers) => new Response(JSON.stringify(body), { status, headers });
    if (pathname === '/api/version') return json({ runtime: 'hermes', commit: 'a'.repeat(40), secret: 'DO_NOT_LOG' });
    if (pathname === '/api/auth/login') return json({ authenticated: true }, 200, { 'Set-Cookie': 'hob_session=PRIVATE; HttpOnly; Secure; SameSite=Strict' });
    if (pathname === '/api/auth/status') return json({ authenticated: true });
    if (pathname === '/api/auth/logout') return options.headers.Origin.includes('forbidden') ? json({}, 403) : json({ authenticated: false });
    if (!options.headers.Cookie) return json({}, 401);
    if (url.includes('not-enrolled') || url.includes('../profiles')) return json({}, 404);
    if (pathname.includes('/reviews/')) return json({ items: [{ id: 'private', summary: 'DO_NOT_LOG', revision: 'b'.repeat(64) }] });
    if (pathname.endsWith('/schedule-preview')) return options.body.includes('99 99') ? json({}, 400) : json({ valid: true, nextRun: '2099-01-01T09:00:00Z', timezone: 'UTC' });
    throw new Error('Unexpected request');
  } });
  assert.equal(report.passed, true);
  assert.ok(calls.filter(call => call.options.method === 'POST').every(call => ['/api/auth/login', '/api/auth/logout', '/api/hermes/workspace/schedule-preview'].includes(call.pathname)));
  assert.doesNotMatch(JSON.stringify(report), /DO_NOT_LOG|PRIVATE|private/);
  assert.ok(calls.every(call => call.options.redirect === 'error'));
});
