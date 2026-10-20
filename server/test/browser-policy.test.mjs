import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, isObservational, viewerMayMutate, observationalMethods, viewerMutationMethods, OBSERVE, MUTATE } from '../browser-policy.mjs';

test('policy: unknown CDP domains are mutations, not observations', () => {
  assert.equal(classify('SomeFutureDomain.doThing'), MUTATE);
  assert.equal(classify(''), MUTATE);
  assert.equal(classify('Page.addScriptToEvaluateOnNewDocument'), MUTATE);
  assert.equal(classify('Page.setBypassCSP'), MUTATE);
  assert.equal(classify('Browser.grantPermissions'), MUTATE);
  assert.equal(classify('Storage.setCookies'), MUTATE);
  assert.equal(classify('Network.setCookie'), MUTATE);
  assert.equal(classify('Target.createTarget'), MUTATE);
  assert.equal(classify('Runtime.callFunctionOn'), MUTATE);
});

test('policy: reading the page is observational', () => {
  for (const method of [
    'Target.getTargets', 'Target.attachToTarget', 'Target.detachFromTarget',
    'Page.captureScreenshot', 'Page.getLayoutMetrics', 'Page.startScreencast', 'Page.screencastFrameAck',
    'Runtime.getProperties', 'DOM.getDocument', 'DOM.getBoxModel', 'DOM.querySelector',
    'Accessibility.getFullAXTree', 'Network.getCookies', 'Log.enable', 'CSS.getComputedStyleForNode',
  ]) {
    assert.equal(classify(method), OBSERVE, `${method} must be observational`);
  }
  assert.equal(isObservational('Page.captureScreenshot'), true);
  assert.equal(isObservational('Runtime.evaluate'), false);
});

test('policy: a viewer is a browser user, never a scripting console', () => {
  assert.equal(viewerMayMutate('Input.dispatchMouseEvent'), true);
  assert.equal(viewerMayMutate('Input.dispatchKeyEvent'), true);
  assert.equal(viewerMayMutate('Input.insertText'), true);
  assert.equal(viewerMayMutate('Page.navigate'), true);
  assert.equal(viewerMayMutate('Page.reload'), true);
  assert.equal(viewerMayMutate('Target.closeTarget'), true);
  assert.equal(viewerMayMutate('Runtime.evaluate'), false);
  assert.equal(viewerMayMutate('Page.addScriptToEvaluateOnNewDocument'), false);
  assert.equal(viewerMayMutate('Network.setCookie'), false);
  assert.equal(viewerMayMutate('Browser.grantPermissions'), false);
  assert.equal(viewerMayMutate('Storage.clearDataForOrigin'), false);
});

test('policy: the two allowlists do not overlap', () => {
  const observational = new Set(observationalMethods());
  for (const method of viewerMutationMethods()) {
    assert.equal(observational.has(method), false, `${method} cannot be both observed and mutated by a viewer`);
  }
});
