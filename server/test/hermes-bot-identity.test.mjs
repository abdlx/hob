import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hermesBotTags, withBotIdentity } from '../hermes-bot-identity.mjs';
import { HermesBotRegistry, HermesBots } from '../hermes-bots.mjs';
import { readFile } from 'node:fs/promises';

test('labels normalize, deduplicate, validate bounds and cannot break identity markers', () => {
  assert.deepEqual(hermesBotTags([' Research ', 'research', 'Code  review']), ['Research', 'Code review']);
  for (const input of ['Code', [null], [''], ['a'.repeat(33)], Array(9).fill('tag'), ['a\n']]) assert.throws(() => hermesBotTags(input));
  const result = withBotIdentity('Keep my voice.\n', { name: 'writer', displayName: '$& <!-- hello -->', tags: ['Research'], description: 'Write well.' });
  assert.match(result, /^Keep my voice\./);
  assert.equal(result.match(/HOB:BOT-IDENTITY:START/g).length, 1);
  assert.match(result, /Name: \$& hello/);
});

test('managed identity updates preserve authored personality and do not grow on repeated sync', () => {
  const before = '# Personality\n\nBe brief.\n\n## Preferences\nKeep these.\n';
  const bot = { name: 'writer', displayName: 'Scribe', tags: ['Writing'], description: 'Write documents.' };
  const first = withBotIdentity(before, bot);
  const next = withBotIdentity(first, { ...bot, displayName: 'Editor', tags: ['Review'] });
  assert.ok(next.startsWith(before.trimEnd()));
  assert.doesNotMatch(next, /Scribe|Writing/);
  assert.match(next, /Name: Editor\nLabels: Review/);
  assert.equal(withBotIdentity(next, { ...bot, displayName: 'Editor', tags: ['Review'] }), next);
  assert.throws(() => withBotIdentity('<!-- HOB:BOT-IDENTITY:START -->', bot), /incomplete/);
});

test('names, labels and roles persist, sync native SOUL and all teammate rosters, and survive editor saves', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hob-identity-'));
  try {
    const options = { stateDir: root, mainApiKey: 'a'.repeat(64) };
    const registry = await HermesBotRegistry.open(options);
    await registry.reserve('writer'); await registry.update('writer', { state: 'active', nativeCreated: true });
    const souls = new Map([['default', 'Coordinate carefully.'], ['writer', '# Voice\nKeep this paragraph.']]);
    let fail = false;
    const client = { async dashboard(route, input = {}) {
      if (route === '/api/profiles') return { profiles: [{ name: 'default' }, { name: 'writer' }] };
      if (route.endsWith('/soul')) {
        if (fail && input.method === 'PUT') throw new Error('Disk unavailable');
        if (input.method === 'PUT') { souls.set(input.profile, input.body.content); return { ok: true }; }
        return { content: souls.get(input.profile), exists: true };
      }
      return { ok: true };
    } };
    const bots = new HermesBots({ registry, client, workspaceRoot: path.join(root, 'work'), relayUrl: 'http://127.0.0.1:3000/api/hermes/bot-relay' });
    const result = await bots.updateIdentity('writer', { displayName: 'Scribe', tags: ['Research', 'Coding'], description: 'Document the evidence.' });
    assert.deepEqual(result.sync.failed, []);
    assert.match(souls.get('writer'), /^# Voice\nKeep this paragraph\./);
    assert.match(souls.get('writer'), /Name: Scribe\nLabels: Research, Coding\nRole: Document the evidence\./);
    assert.match(await readFile(path.join(root, 'work', 'main', 'AGENTS.md'), 'utf8'), /Scribe.*Research, Coding.*Document the evidence/);
    await bots.saveSoul('writer', 'A new authored personality.');
    assert.match(souls.get('writer'), /^A new authored personality\./);
    assert.match(souls.get('writer'), /Labels: Research, Coding/);
    const restored = await HermesBotRegistry.open(options);
    assert.deepEqual(restored.list().find(bot => bot.name === 'writer').tags, ['Research', 'Coding']);
    fail = true;
    const pending = await bots.updateIdentity('writer', { displayName: 'Scout' });
    assert.equal(pending.identitySync, 'pending');
    assert.match(pending.sync.failed[0].error, /Disk unavailable/);
    assert.equal(registry.list().find(bot => bot.name === 'writer').identitySync, 'pending');
    fail = false; await bots.syncNetwork();
    assert.match(souls.get('writer'), /Name: Scout/);
  } finally {
    assert.equal(path.dirname(root), tmpdir());
    await rm(root, { recursive: true, force: true });
  }
});
