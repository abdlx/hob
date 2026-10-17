import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConversationWork } from '../src/services/conversation-work.ts';

const user = (id, content) => ({ id, role: 'user', content, timestamp: '', status: 'complete' });
const begin = (state, profile, id, history = []) => state.begin(profile, id, 'Hello', `user-${id}`, `reply-${id}`, '', history);

test('separate conversations can work concurrently without sharing replies, busy state or errors', () => {
  const state = new ConversationWork();
  const main = begin(state, 'default', 'main-chat');
  const other = begin(state, 'coder', 'coder-chat');
  state.append(main, 'Main private answer'); state.append(other, 'Coder private answer');
  assert.equal(state.busy('main-chat'), true); assert.equal(state.busy('coder-chat'), true);
  assert.equal(state.project('main-chat', []).at(-1).content, 'Main private answer');
  assert.equal(state.project('coder-chat', []).at(-1).content, 'Coder private answer');
  state.finish(main, 'Main connection interrupted');
  assert.equal(state.busy('coder-chat'), true); assert.equal(state.error('coder-chat'), null);
  assert.equal(state.error('main-chat'), 'Main connection interrupted');
});

test('returning to an active conversation restores its complete streamed prefix', () => {
  const state = new ConversationWork(); const main = begin(state, 'default', 'main');
  state.append(main, 'First '); state.append(main, 'second');
  assert.equal(state.project('main', []).at(-1).content, 'First second');
  state.append(main, 'Replacement', true);
  assert.equal(state.project('main', []).at(-1).content, 'Replacement');
});

test('native admitted user rows replace optimistic prompts without collapsing identical old prompts', () => {
  const state = new ConversationWork(); const history = [user('old', 'Hello')];
  begin(state, 'default', 'main', history);
  assert.equal(state.project('main', history).filter(row => row.role === 'user').length, 2);
  const admitted = [...history, user('new-native-id', 'Hello')];
  const rows = state.project('main', admitted);
  assert.equal(rows.filter(row => row.role === 'user').length, 2);
  assert.equal(rows.some(row => row.id === 'user-main'), false);
});

test('stale tokens cannot append to or clear a newer response in the same conversation', () => {
  const state = new ConversationWork(); const old = begin(state, 'default', 'main');
  state.finish(old);
  const fresh = begin(state, 'default', 'main'); state.append(fresh, 'New answer');
  assert.equal(state.append(old, 'Old late data'), false);
  assert.equal(state.finish(old, 'Old late failure'), false);
  assert.equal(state.busy('main'), true); assert.equal(state.error('main'), null);
  assert.equal(state.project('main', []).at(-1).content, 'New answer');
});

test('history reads can detect begin/finish boundaries without invalidation on every delta', () => {
  const state = new ConversationWork(); const initial = state.version('main');
  const turn = begin(state, 'default', 'main'); const active = state.version('main');
  assert.notEqual(initial, active); state.append(turn, 'hello'); assert.equal(state.version('main'), active);
  state.finish(turn); assert.notEqual(state.version('main'), active);
});

test('duplicate sends are refused locally and clearing one error does not erase another', () => {
  const state = new ConversationWork(); const main = begin(state, 'default', 'main');
  assert.throws(() => begin(state, 'default', 'main'), /already has a response/);
  const other = begin(state, 'coder', 'other'); state.finish(main, 'main failure'); state.finish(other, 'other failure');
  state.clearError('other'); assert.equal(state.error('main'), 'main failure'); assert.equal(state.error('other'), null);
});

test('unsent composer drafts belong to each conversation and never carry over into another bot', () => {
  const state = new ConversationWork();
  state.setDraft('main', 'Private Main draft'); state.setDraft('coder', 'Private coder draft');
  assert.equal(state.draft('main'), 'Private Main draft'); assert.equal(state.draft('coder'), 'Private coder draft');
  state.setDraft('coder', ''); assert.equal(state.draft('main'), 'Private Main draft'); assert.equal(state.draft('coder'), '');
  assert.equal(new ConversationWork().draft('main'), ''); // logout/remount has no retained browser state
});
