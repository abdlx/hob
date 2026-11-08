// This helper talks only to HOB's role-scoped bookkeeping API. It never opens a
// native memory database or starts a model run.
export function hobWorkClient(endpoint) {
  return `#!/usr/bin/env node
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
let credential;
try {
  const handle = await open(new URL('./relay.json', import.meta.url), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 4096) throw new Error();
    const bytes = Buffer.alloc(4097), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) throw new Error();
    credential = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')).token;
  } finally { await handle.close(); }
  if (!/^[a-f0-9]{64}$/.test(credential || '')) throw new Error();
} catch { console.error('HOB relay credential unavailable. Ask the operator to synchronize this bot.'); process.exit(2); }
const [command = 'status', argument, ...extra] = process.argv.slice(2);
const reads = { status: '', tasks: '/tasks', followups: '/followups', candidates: '/candidates', episodes: '/episodes', inbox: '/inbox' };
const writes = { plan: '/plan', progress: '/progress', followup: '/followups', decide: '/followups/decide', remember: '/remember', propose: '/candidates' };
try {
  if (extra.length || (!Object.hasOwn(reads, command) && !Object.hasOwn(writes, command))) throw new Error('Use status/tasks/followups/candidates/episodes/inbox or plan/progress/followup/decide/remember/propose followed by one JSON object.');
  const mutation = Object.hasOwn(writes, command);
  let input;
  if (mutation) {
    input = JSON.parse(argument || '{}');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Use a JSON object.');
    input.requestId ||= randomUUID();
    console.error('HOB request ID: ' + input.requestId + '. Reuse the same ID and payload if an acknowledgement is lost.');
  } else if (argument) throw new Error('Read commands take no arguments.');
  const response = await fetch(${JSON.stringify(endpoint)} + '/work' + (mutation ? writes[command] : reads[command]), {
    method: mutation ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + credential, ...(mutation ? { 'Content-Type': 'application/json' } : {}) },
    ...(mutation ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(20000),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message || value.error || value.message || 'HOB request rejected.');
  console.log(JSON.stringify(value, null, 2));
} catch (error) { console.error(error.message + ' No automatic mutation retry was attempted.'); process.exitCode = 1; }
`;
}
