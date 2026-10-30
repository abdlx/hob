import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isolationRequest } from '../server/hermes-isolation.mjs';
import { HermesTeam } from '../server/hermes-team.mjs';
import { createTeamArtifactHandoffs } from '../server/hermes-team-artifacts.mjs';
import { parseTeamTask } from '../server/hermes-team-protocol.mjs';

// Disposable first-run CI only. No provider, credentials, or production state
// changes. HTTP coordinator authority is covered separately by relay tests.
assert.equal(process.platform, 'linux');
assert.equal(process.env.HOB_SMOKE_TEAM_ARTIFACTS, '1', 'This probe requires the disposable smoke-test flag.');
const broker = await isolationRequest('status');
assert.equal(process.getuid(), broker.operatorUid);
const main = await isolationRequest('ensure', 'default');
const worker = await isolationRequest('ensure', 'proactive-worker');
for (const [owner, profile] of [[main, 'default'], [worker, 'proactive-worker']]) {
  assert.equal(owner.profile, profile); assert.equal(owner.user, `hob${owner.uid}`);
  assert.equal(owner.host, '127.0.0.1'); assert.equal(owner.port, 22220);
  assert.ok(owner.uid >= 20000 && owner.uid < 60000);
}
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const execute = promisify(execFile);
async function ssh(owner, argv) {
  return execute('/usr/bin/ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-p', '22220', '-i', owner.keyPath,
    `${owner.user}@127.0.0.1`, argv.map(quote).join(' ')], { env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/opt/data' }, timeout: 20000 });
}
const root = '/var/lib/hob-isolation/workspaces';
assert.equal(main.workspace, path.join(root, 'main'));
assert.equal(worker.workspace, path.join(root, 'bots', 'proactive-worker'));
const id = randomUUID(), output = `artifacts/ci-team-output-${id}.json`;
const source = path.join(worker.workspace, output);
const state = await mkdtemp(path.join(tmpdir(), 'hob-team-handoff-'));
let team, receipt;
try {
  const roster = ['default', 'proactive-worker'].map(name => ({ name, state: 'active' }));
  team = new HermesTeam({ stateDir: state, workspaceRoot: root, roster: () => roster });
  team.configure({ revision: 0, confirm: true, coordinatorOnly: true, shareDocuments: false, coreBudget: 4000, sessionWindow: 20 });
  const handoffs = createTeamArtifactHandoffs({ team, workspaceRoot: root, roster: () => roster });
  await ssh(worker, ['python3', '-c', 'import json,os,sys;from pathlib import Path;p=Path(sys.argv[1]);p.parent.mkdir(exist_ok=True);p.write_text(json.dumps({"workerUid":os.getuid(),"steps":["draft","check"]}))', source]);
  await assert.rejects(ssh(main, ['test', '-r', source]), error => error.code === 1, 'Main gained direct access to the worker workspace');
  const message = `TASK handoff-proof — Check the worker plan\nOUTCOME: Read a two-step JSON plan\nCONSTRAINTS: No external calls\nOUTPUT: ${output}\nDEADLINE: none\nCORE REFS: none`;
  const record = { id, from: 'default', to: 'proactive-worker', status: 'completed', teamControlled: true, message, teamTask: parseTeamTask(message),
    reply: `TASK handoff-proof — DONE\nRESULT: Saved the plan\nFILES: ${output}\nVERIFICATION: Wrote the two-step JSON\nBLOCKERS: none\nPROMOTE: none` };
  receipt = await handoffs.receive(record);
  const copied = path.join(main.workspace, receipt.path);
  const read = await ssh(main, ['python3', '-c', 'import hashlib,json,sys;from pathlib import Path;b=Path(sys.argv[1]).read_bytes();v=json.loads(b);print(json.dumps({"sha256":hashlib.sha256(b).hexdigest(),"steps":len(v["steps"]),"workerUid":v["workerUid"]}))', copied]);
  const observed = JSON.parse(read.stdout);
  assert.equal(observed.sha256, receipt.sha256); assert.equal(observed.steps, 2); assert.equal(observed.workerUid, worker.uid);
  await assert.rejects(ssh(worker, ['test', '-r', copied]), error => error.code === 1, 'Worker could read Main\'s inbox');
  await assert.rejects(ssh(main, ['python3', '-c', 'import sys;from pathlib import Path;Path(sys.argv[1]).write_text("changed")', copied]),
    error => error.code === 1 && /PermissionError|Permission denied|Read-only file system/.test(error.stderr), 'Main tool execution could overwrite the operator-owned snapshot');
  const review = await handoffs.review(record, { requestId: 'linux-' + id, sha256: receipt.sha256, verdict: 'passed', checks: 'Main read the copied JSON over its own SSH backend; verified the digest, two steps and worker UID.' });
  assert.equal(review.author, 'default'); assert.equal(review.verdict, 'passed');
  assert.equal((await handoffs.inspect(record)).reviews.length, 1);
  console.log('OS-user handoff: worker created the output, Main read only the nominated copy and verified its digest/content, cross-workspace reads and snapshot writes were denied.');
} finally {
  team?.close();
  if (receipt) {
    const inbox = path.resolve(main.workspace, '.hob', 'team-inbox', id);
    assert.equal(path.dirname(inbox), path.join(main.workspace, '.hob', 'team-inbox'));
    await rm(inbox, { recursive: true, force: true });
  }
  await ssh(worker, ['rm', '-f', '--', source]).catch(() => undefined);
  assert.equal(path.dirname(state), tmpdir()); assert.ok(path.basename(state).startsWith('hob-team-handoff-'));
  await rm(state, { recursive: true, force: true });
}
