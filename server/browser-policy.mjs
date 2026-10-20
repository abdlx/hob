// CDP command classification for exclusive human takeover.
//
// The rule is deliberately two-sided and conservative:
//   * An `Observe` command only *reads*. It may run at any time, from either
//     principal, because it cannot change page state.
//   * Everything else is a `Mutate` command. Only the lease holder may run it.
//
// The observational set is an explicit, audited allowlist rather than a
// prefix rule, so a new or renamed CDP domain can never silently become
// unprivileged. Anything unknown is a mutation by default.

export const OBSERVE = 'observe';
export const MUTATE = 'mutate';

// Read-only commands. Verified against the DevTools Protocol domains used by
// Hermes' browser tools, Playwright's page driver and this gateway.
//
// The bar for membership is that the command cannot change page state, cannot
// install a *capability* that could (a scripting binding, a session that carries
// commands), and cannot suspend or destroy anything another principal depends
// on. Several commands whose names read as harmless are deliberately absent:
//
//   * `Target.exposeDevToolsProtocol` injects a CDP-sending binding into a
//     target: a scripting capability, so it is a mutation.
//   * `Target.setAutoAttach` installs browser-wide state, and with
//     `waitForDebuggerOnStart` it *suspends* every target that appears
//     afterwards until somebody sends `Runtime.runIfWaitingForDebugger`. That
//     is a live page hanging on a refusal, so it is a mutation.
//   * `Log.clear` and `DOM.setInspectedNode` destroy state.
//
// `Target.attachToTarget` stays observational, and that is safe *because*
// classification is session-agnostic: attaching yields a session id, but every
// message is classified on its own method whether or not it carries one, so an
// attached session confers no ability to mutate. `browser-takeover-bypass`
// proves that directly.
const OBSERVATIONAL = new Set([
  // Browser / schema
  'Browser.getVersion', 'Browser.getBrowserCommandLine', 'Browser.getHistograms',
  'Browser.getHistogram', 'Browser.getWindowBounds', 'Browser.getWindowForTarget',
  'Browser.getBrowserContexts', 'Schema.getDomains',
  // Targets (attachment and discovery are routing, not page state)
  'Target.getTargets', 'Target.getTargetInfo', 'Target.attachToTarget', 'Target.detachFromTarget',
  'Target.setDiscoverTargets', 'Target.getBrowserContexts',
  'Target.receiveMessageFromTarget',
  // Page: observation, layout, capture and the screencast transport
  'Page.enable', 'Page.disable', 'Page.getFrameTree', 'Page.getResourceTree',
  'Page.getResourceContent', 'Page.getNavigationHistory', 'Page.getLayoutMetrics',
  'Page.captureSnapshot', 'Page.captureScreenshot', 'Page.getAppManifest',
  'Page.getInstallabilityErrors', 'Page.getManifestIcons', 'Page.getPermissionsPolicyState',
  'Page.getOriginTrials', 'Page.startScreencast', 'Page.stopScreencast', 'Page.screencastFrameAck',
  'Page.getAdScriptAncestry',
  // Runtime: enabling the domain and reading properties is safe; evaluate is not.
  'Runtime.enable', 'Runtime.disable', 'Runtime.getProperties', 'Runtime.getIsolateId',
  'Runtime.getHeapUsage', 'Runtime.releaseObject', 'Runtime.releaseObjectGroup',
  'Runtime.getExceptionDetails', 'Runtime.globalLexicalScopeNames',
  // DOM inspection
  'DOM.enable', 'DOM.disable', 'DOM.getDocument', 'DOM.getFlattenedDocument', 'DOM.getBoxModel',
  'DOM.getContentQuads', 'DOM.describeNode', 'DOM.querySelector', 'DOM.querySelectorAll',
  'DOM.resolveNode', 'DOM.getOuterHTML', 'DOM.getAttributes', 'DOM.getNodeForLocation',
  'DOM.pushNodesByBackendIdsToFrontend', 'DOM.pushNodeByRemoteObjectId',
  'DOM.getSearchResults', 'DOM.performSearch', 'DOM.getNodeStackTraces',
  // Accessibility tree (the source of Hermes' `@eN` snapshot refs)
  'Accessibility.enable', 'Accessibility.disable', 'Accessibility.getFullAXTree',
  'Accessibility.getPartialAXTree', 'Accessibility.getRootAXNode', 'Accessibility.getAXNodeAndAncestors',
  'Accessibility.queryAXTree',
  // CSS inspection
  'CSS.enable', 'CSS.disable', 'CSS.getComputedStyleForNode', 'CSS.getMatchedStylesForNode',
  'CSS.getInlineStylesForNode', 'CSS.getStyleSheetText', 'CSS.getMediaQueries',
  // Network observation
  'Network.enable', 'Network.disable', 'Network.getCookies', 'Network.getAllCookies',
  'Network.getResponseBody', 'Network.getRequestPostData', 'Network.getCertificate',
  'Network.getSecurityIsolationStatus', 'Network.canClearBrowserCache', 'Network.canClearBrowserCookies',
  // Logging / console
  'Log.enable', 'Log.disable', 'Log.startViolationsReport',
  // Performance / tracing observation
  'Performance.enable', 'Performance.disable', 'Performance.getMetrics', 'Performance.getMetric',
  'Profiler.enable', 'Profiler.disable', 'Profiler.getBestEffortCoverage',
]);

// Viewer principals are a browser *user*, never a scripting console. Even while
// holding the lease they may only perform these mutations.
const VIEWER_MUTATIONS = new Set([
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText',
  'Input.dispatchTouchEvent', 'Input.dispatchDragEvent', 'Input.synthesizeScrollGesture',
  'Input.synthesizePinchGesture', 'Input.synthesizeTapGesture', 'Input.emulateTouchFromMouseEvent',
  'Page.navigate', 'Page.reload', 'Page.stopLoading', 'Page.navigateToHistoryEntry',
  'Page.bringToFront', 'Page.handleJavaScriptDialog', 'Page.close',
  'Target.activateTarget', 'Target.closeTarget', 'Target.createTarget',
  'Emulation.setDeviceMetricsOverride', 'Emulation.clearDeviceMetricsOverride',
  'Emulation.setTouchEmulationEnabled', 'Emulation.setEmitTouchEventsForMouse',
]);

export function classify(method) {
  return OBSERVATIONAL.has(method) ? OBSERVE : MUTATE;
}

export function isObservational(method) { return classify(method) === OBSERVE; }

/** Whether a viewer holding the lease may perform this mutation. */
export function viewerMayMutate(method) { return VIEWER_MUTATIONS.has(method); }

export function observationalMethods() { return [...OBSERVATIONAL]; }
export function viewerMutationMethods() { return [...VIEWER_MUTATIONS]; }
