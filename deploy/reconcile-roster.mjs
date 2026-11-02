#!/usr/bin/env node
// One-shot operator reconciliation between Hermes profiles and HOB's roster.
//
// HOB deliberately does not enroll native profiles on its own. When profiles are
// created or removed with the Hermes CLI, this command applies the same explicit
// operations the dashboard offers, through the authenticated HTTP API only:
// adopt every unenrolled native profile, revoke dashboard bots whose native
// profile is gone, and optionally rename Main. It never edits bots.json or the
// employee-team database; both are rewritten by the running application.
//
// Usage inside the HOB container after deploying this build:
//   node deploy/reconcile-roster.mjs
//   node deploy/reconcile-roster.mjs --main Hob
//   node deploy/reconcile-roster.mjs --url http://127.0.0.1:3000
//
// Credentials come from HOB_PASSWORD or HOB_ACCESS_TOKEN, never from argv.

import { pathToFileURL } from 'node:url';

const DEFAULT_PORT = 3000;

export function parseArguments(argv = process.argv.slice(2)) {
  const options = { url: undefined, main: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--main' || argument === '--url') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  if (options.main !== undefined) {
    const name = options.main.replace(/\s+/g, ' ').trim();
    if (!name || name.length > 64) throw new Error('--main must be 1-64 printable characters.');
    options.main = name;
  }
  return options;
}

async function sessionCookie(response) {
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  const cookie = cookies.map(value => value.split(';')[0].trim())
    .find(value => value.startsWith('hob_session='));
  if (!cookie) throw new Error('HOB did not issue a session cookie.');
  return cookie;
}

export async function reconcileRoster({ url, password, main, fetchImpl = fetch, log = console.log }) {
  if (typeof password !== 'string' || !password) throw new Error('Set HOB_PASSWORD or HOB_ACCESS_TOKEN.');
  const base = String(url).replace(/\/+$/, '');

  const login = await fetchImpl(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!login.ok) throw new Error(`HOB sign-in failed (${login.status}). Check HOB_PASSWORD or HOB_ACCESS_TOKEN.`);
  const cookie = await sessionCookie(login);

  const call = async (path, init = {}) => {
    const response = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', cookie, ...(init.headers || {}) },
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!response.ok) {
      const detail = body && typeof body === 'object' ? body.error || body.message : body;
      throw new Error(`${init.method || 'GET'} ${path} failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }
    return body;
  };

  const adopted = [];
  const revoked = [];
  const failures = [];
  const initial = await call('/api/hermes/profiles');

  for (const profile of initial?.available || []) {
    try {
      await call('/api/hermes/profiles/adopt', { method: 'POST', body: JSON.stringify({ name: profile.name }) });
      adopted.push(profile.name);
      log(`adopted ${profile.name}`);
    } catch (error) {
      failures.push(`adopt ${profile.name}: ${error.message}`);
      log(`FAILED adopt ${profile.name}: ${error.message}`);
    }
  }

  // A stale dashboard record is still "active" in the registry even when the
  // native profile disappeared, so the relay and team roster keep advertising
  // it until it is revoked.
  const afterAdoption = await call('/api/hermes/profiles');
  for (const profile of afterAdoption?.profiles || []) {
    if (profile.name === 'default' || profile.state !== 'unavailable') continue;
    try {
      await call(`/api/hermes/profiles/${encodeURIComponent(profile.name)}`, { method: 'DELETE' });
      revoked.push(profile.name);
      log(`revoked ${profile.name}`);
    } catch (error) {
      failures.push(`revoke ${profile.name}: ${error.message}`);
      log(`FAILED revoke ${profile.name}: ${error.message}`);
    }
  }

  let renamed;
  if (main) {
    const result = await call('/api/hermes/profiles/default', {
      method: 'PATCH', body: JSON.stringify({ displayName: main }),
    });
    renamed = result?.displayName || main;
    log(`renamed Main to ${renamed}`);
  }

  const final = await call('/api/hermes/profiles');
  const roster = (final?.profiles || [])
    .filter(profile => profile.state === 'active')
    .map(profile => profile.displayName || profile.display_name || profile.name);
  return { adopted, revoked, renamed, failures, roster };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArguments();
    const url = options.url || process.env.HOB_INTERNAL_URL || `http://127.0.0.1:${process.env.HOB_PORT || DEFAULT_PORT}`;
    const password = process.env.HOB_PASSWORD || process.env.HOB_ACCESS_TOKEN;
    const result = await reconcileRoster({ url, password, main: options.main });
    console.log(`Active roster: ${result.roster.join(', ') || '(none)'}`);
    if (result.failures.length) {
      console.error(`${result.failures.length} operation(s) failed. Resolve them and run the command again.`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`Roster reconciliation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
