import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { parseArguments, reconcileRoster } from './reconcile-roster.mjs';

async function fixture(run) {
  const state = {
    available: [{ name: 'theo' }, { name: 'leo' }],
    profiles: [
      { name: 'default', displayName: 'Professor', state: 'active' },
      { name: 'tony-stark-2', displayName: 'Tony Stark', state: 'unavailable' },
      { name: 'alfred', displayName: 'Alfred', state: 'unavailable' },
    ],
    calls: [],
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    state.calls.push({ method: req.method, url: req.url, body });
    const send = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.url === '/api/auth/login' && req.method === 'POST') {
      if (body?.password !== 'synthetic-password') return send(401, { error: 'Invalid password or access token.' });
      res.setHeader('set-cookie', 'hob_session=synthetic-session; Path=/; HttpOnly');
      return send(200, { authenticated: true });
    }
    if (req.headers.cookie !== 'hob_session=synthetic-session') return send(401, { error: 'Sign in to hob.' });
    if (req.url === '/api/hermes/profiles' && req.method === 'GET') {
      return send(200, { profiles: state.profiles, available: state.available });
    }
    if (req.url === '/api/hermes/profiles/adopt' && req.method === 'POST') {
      const name = body?.name;
      if (!state.available.some(item => item.name === name)) return send(409, { error: 'This profile is already in your dashboard.' });
      state.available = state.available.filter(item => item.name !== name);
      state.profiles.push({ name, displayName: name, state: 'active' });
      return send(201, { ok: true, name, state: 'active', adopted: true });
    }
    const profile = /^\/api\/hermes\/profiles\/([a-z][a-z0-9_-]{0,63})$/.exec(req.url);
    if (profile && req.method === 'DELETE') {
      state.profiles = state.profiles.filter(item => item.name !== profile[1]);
      return send(200, { ok: true, name: profile[1], alreadyAbsent: true });
    }
    if (profile && req.method === 'PATCH') {
      const item = state.profiles.find(entry => entry.name === profile[1]);
      item.displayName = body.displayName;
      return send(200, { ok: true, name: profile[1], displayName: body.displayName });
    }
    return send(404, { error: 'Unknown endpoint.' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await run({ state, url: `http://127.0.0.1:${server.address().port}` });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('roster reconciliation adopts native profiles, revokes stale bots and renames Main', async () => fixture(async ({ state, url }) => {
  const result = await reconcileRoster({ url, password: 'synthetic-password', main: 'Hob', log: () => {} });
  assert.deepEqual(result, {
    adopted: ['theo', 'leo'],
    revoked: ['tony-stark-2', 'alfred'],
    renamed: 'Hob',
    failures: [],
    roster: ['Hob', 'theo', 'leo'],
  });
  assert.deepEqual(state.profiles.map(item => [item.name, item.displayName]), [
    ['default', 'Hob'], ['theo', 'theo'], ['leo', 'leo'],
  ]);
  assert.equal(state.calls.some(call => call.method === 'DELETE' && call.url.includes('default')), false,
    'Main is never deleted');
}));

test('roster reconciliation reports a refused sign-in and makes no changes', async () => fixture(async ({ state, url }) => {
  await assert.rejects(reconcileRoster({ url, password: 'wrong', log: () => {} }), /sign-in failed \(401\)/);
  assert.equal(state.calls.some(call => call.url !== '/api/auth/login'), false);
}));

test('unknown reconciliation options are refused before any request', () => {
  assert.deepEqual(parseArguments(['--main', ' Hob ', '--url', 'http://127.0.0.1:3000']), {
    main: 'Hob', url: 'http://127.0.0.1:3000',
  });
  assert.throws(() => parseArguments(['--main']), /requires a value/);
  assert.throws(() => parseArguments(['--watch']), /Unknown option/);
});
