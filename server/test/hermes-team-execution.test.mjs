import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HermesTeam } from '../hermes-team.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'hob-team-execution-'));
  await mkdir(path.join(root, 'workspaces'), { recursive: true });
  const roster = [{ name: 'default', state: 'active' }, { name: 'writer', state: 'active' }];
  const options = { stateDir: path.join(root, 'state'), workspaceRoot: path.join(root, 'workspaces'), roster: () => roster };
  let team = new HermesTeam(options);
  t.after(async () => { team.close(); assert.equal(path.dirname(root), tmpdir()); assert.ok(path.basename(root).startsWith('hob-team-execution-')); await rm(root, { recursive: true, force: true }); });
  const input = { profile: 'writer', endpoint: 'https://subscription.example/v1/chat/completions', models: ['included-model'], billingMode: 'subscription', credentialDigest: 'a'.repeat(64), basis: 'Existing account reviewed: included requests; usage and overages disabled.' };
  const preview = (value = {}) => team.execution.preview({ ...input, ...value });
  const approve = draft => team.execution.approve({ ...draft, confirm: true, confirmNoUsageCharges: true });
  return { get team() { return team; }, roster, input, preview, approve, restart() { team.close(); team = new HermesTeam(options); return team; } };
}

test('non-metered model routes require an exact dashboard review and survive restart with immutable approvals', async t => {
  const f = await fixture(t);
  assert.equal(f.team.policy().paidExecution, false); assert.equal(f.team.policy().allowSubscriptions, true);
  assert.deepEqual(f.team.execution.state().routes, []);
  const draft = f.preview();
  assert.throws(() => f.team.execution.approve({ ...draft, confirm: true }), /no usage/);
  assert.throws(() => f.approve({ ...draft, route: { ...draft.route, endpoint: 'https://changed.example/v1/chat/completions' } }), /changed after review/);
  const approved = f.approve(draft); assert.equal(approved.revision, 1);
  assert.equal(approved.routes[0].author, 'user'); assert.equal(approved.routes[0].credentialDigest, 'a'.repeat(64));
  assert.equal(approved.routes[0].revoked, null);
  assert.throws(() => f.approve(draft), /changed/);
  assert.deepEqual(f.restart().execution.state(), approved);
  assert.throws(() => f.team.execution.revoke({ id: draft.route.id, digest: 'b'.repeat(64), revision: 1, confirm: true }), /changed/);
  assert.throws(() => f.team.execution.revoke({ revision: 1, confirm: true }), error => error.status === 400);
  const revoked = f.team.execution.revoke({ id: draft.route.id, digest: draft.digest, revision: 1, confirm: true });
  assert.equal(revoked.revision, 2); assert.equal(typeof revoked.routes[0].revoked, 'number');
  assert.equal(revoked.routes[0].digest, draft.digest);
  assert.throws(() => f.approve({ ...draft, revision: 2 }), /already been used/);
  assert.deepEqual(f.restart().execution.state(), revoked);
});

test('route review refuses paid lanes, broad models, stale credentials, secrets and inactive bots', async t => {
  const f = await fixture(t);
  for (const value of [
    { billingMode: 'paid' }, { billingMode: 'free-tier-with-overage' }, { models: ['*'] }, { models: ['same', 'same'] },
    { endpoint: 'https://x.example/v1/chat/completions?api_key=hidden' }, { endpoint: 'https://x.example/a/../v1/messages' },
    { endpoint: 'https://user:password@x.example/v1/messages' }, { endpoint: 'https://x.example/v1/%6dessages' },
    { endpoint: 'https://x.example/v1' }, { credentialDigest: 'token-value' }, { billingMode: 'subscription', endpoint: 'http://remote.example/v1/messages' },
    { endpoint: 'https://x.example/some path/v1/messages' },
    { basis: 'api_key=synthetic-credential-never-share' }, { paidExecution: true }, { endpoint: 'https://openrouter.ai/api/v1/chat/completions', models: ['paid/model'] },
    { endpoint: 'https://openrouter.ai./api/v1/chat/completions' }, { endpoint: 'https://api.openrouter.ai/api/v1/chat/completions', models: ['paid/model'] },
  ]) assert.throws(() => f.preview(value));
  const local = f.preview({ endpoint: 'http://127.0.0.1:9000/v1/chat/completions', billingMode: 'local' });
  f.approve(local);
  const free = f.preview({ endpoint: 'https://OPENROUTER.AI:443/api/v1/chat/completions', billingMode: 'free', models: ['openrouter/free', 'vendor/model:free'] });
  assert.equal(free.route.endpoint, 'https://openrouter.ai/api/v1/chat/completions');
  const stale = f.preview(); f.approve(free);
  assert.throws(() => f.approve(stale), /changed/);
  const revokedBot = f.preview(); f.roster[1].state = 'revoked';
  assert.throws(() => f.approve(revokedBot), /not active/);
});
