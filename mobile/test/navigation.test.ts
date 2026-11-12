import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommonActions, StackRouter } from '@react-navigation/routers';
import { destinations, openPage, runBusy } from '../src/navigation.ts';

const router = StackRouter({ initialRouteName: 'Chat' });
const options = { routeNames: ['Chat', 'Goals', 'Library', 'File', 'Skills', 'Skill'], routeParamList: { Chat: { profile: 'default' } }, routeGetIdList: {} };

test('Android Back traverses visited workspace pages, folders, and editors before reaching the root', () => {
  let state = router.getInitialState(options);
  for (const action of [openPage('Goals', 'default'), openPage('Library', 'research'), openPage('Library', 'research', { path: 'artifacts' }), openPage('File', 'research', { file: { name: 'report.md', path: 'artifacts/report.md' } })]) {
    state = router.getRehydratedState(router.getStateForAction(state, action, options)!, options);
  }
  const expected = [['Library', 'research', 'artifacts'], ['Library', 'research', undefined], ['Goals', 'default', undefined], ['Chat', 'default', undefined]];
  for (const [name, profile, path] of expected) {
    state = router.getRehydratedState(router.getStateForAction(state, CommonActions.goBack(), options)!, options);
    const route = state.routes[state.index];
    assert.equal(route.name, name); assert.equal((route.params as { profile: string }).profile, profile);
    assert.equal((route.params as { path?: string }).path, path);
  }
  assert.equal(router.getStateForAction(state, CommonActions.goBack(), options), null);
});

test('bot switches and notification conversations get distinct routes without overwriting the previous chat', () => {
  let state = router.getInitialState(options);
  state = router.getRehydratedState(router.getStateForAction(state, openPage('Chat', 'default', { id: 'first' }), options)!, options);
  state = router.getRehydratedState(router.getStateForAction(state, openPage('Chat', 'research', { id: 'notification' }), options)!, options);
  assert.equal((state.routes[state.index].params as { id: string }).id, 'notification');
  state = router.getRehydratedState(router.getStateForAction(state, CommonActions.goBack(), options)!, options);
  assert.deepEqual(state.routes[state.index].params, { profile: 'default', id: 'first' });
  assert.throws(() => openPage('Chat', '../other'));
  assert.equal(openPage('Goals', 'research', { profile: 'other' }).payload.params.profile, 'research');
});

test('unknown or disconnected work fences new submissions until its outcome is observed', () => {
  assert.ok(destinations.some(d => d.name === 'Bots'));
  for (const status of ['queued', 'running', 'waiting_for_approval', 'unknown', 'unavailable', 'admitting', 'stopping']) assert.equal(runBusy(status), true);
  for (const status of ['completed', 'cancelled', 'failed', 'interrupted', undefined]) assert.equal(runBusy(status), false);
});
