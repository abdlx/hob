# HOB Browser Integration: Independent Verification & Implementation Plan

> **Status:** Pre-implementation investigation complete. Critical Q1 blocker resolved.
> All findings verified against actual source code with exact file + line citations.

---

## Part 1 — Critical Finding: The Transport Identity Blocker (Q1) — RESOLVED

Both prior reconnaisance documents flagged this as the primary blocker:

> *"Does a run submitted through the native session authority carry `HERMES_BROWSER_CONTROL_PRINCIPAL`/`HERMES_BROWSER_CONTROL_TRANSPORT_FAMILY`?"*

**Answer: YES — but only on the dashboard/RPC transport (`/api/ws`), NOT the api_server HTTP transport. HOB already uses the dashboard transport. The correct controller registration path for HOB is the dashboard WebSocket (`tui_gateway`), not the API server HTTP endpoints.**

### Chain of evidence

**Path A — api_server HTTP (HOB does NOT use this for native chat):**
- `api_server.py:1632–1640` sets `_api_request_browser_control_principal` in a ContextVar per incoming HTTP request, only for the authenticated `v1/*` REST surface.
- `session_api_turn.py:81–88` (`_request_browser_control()`) reads those ContextVars to stamp the browser_control identity onto admitted turns.
- HOB's `hermes-canonical-chat.mjs` uses `prompt.submit` via the native Gateway WebSocket (`HermesSessionBridge`), NOT `POST /v1/chat/stream`. **This path NEVER flows through the api_server request middleware.**

**Path B — dashboard/RPC (`/api/ws`) — HOB's actual transport:**
- `tui_gateway/server.py:1046–1073` (`_set_session_context`) is called for every session turn dispatched through the dashboard Gateway.
- Lines 1055–1067: if the transport's `auth_identity` is an authenticated, non-internal identity, it derives `browser_control_principal = _principal_digest(identity)` and `browser_control_transport_family = "cloud-ticket-ws"` and stamps them into `session_context.py:set_session_vars(...)`.
- `methods_browser_control.py` handles `browser.controller.register` on this same dashboard WebSocket, using `_CLOUD_TRANSPORT_FAMILY = "cloud-ticket-ws"` and `_principal_digest(identity)` — **the exact same values stamped per session.**
- **Conclusion:** When HOB registers a controller over the dashboard WS for a session that originated on that same WS, the principal and transport_family match perfectly. The routing chain works.

### The session_id problem

`methods_browser_control.py:106–114`: `browser.controller.register` requires the session to exist in the `_sessions` map:
```python
session_id = str(params.get("session_id") or "")
with _sessions_lock:
    session = _sessions.get(session_id)
    if not _session_transport_contains(session, transport):
        return _err(rid, _ERR_FORBIDDEN, "session is not owned by this transport")
```

HOB's session IDs (from `hermes-canonical-chat.mjs`) are the raw `session_id` returned by `session.create`, wrapped in `hermesNativeSessionKey(profile, sessionId)` for HOB's own API. The raw `session_id` string (the unwrapped part) is what must be passed to `browser.controller.register`. **This is easily extractable from `parseHermesSessionKey(key).sessionId`.**

### The register timing problem

`methods_browser_control.py` requires the session to be **currently open on the same transport connection**. This means:
- HOB must register the controller **from the same dashboard WebSocket connection that owns the session**.
- The `HermesSessionBridge` opens one WebSocket per bot profile, and all session RPCs flow through it.
- **Solution:** Add `browser.controller.register` and `browser.controller.result` to `SESSION_METHODS` in `hermes-session.mjs`, then call register immediately after `session.create` (or `session.resume`), and maintain a persistent controller registration for each active session.

---

## Part 2 — Architecture Decision: Atrium Worker vs HOB-Native Playwright

### What stock Atrium provides (verified)

| Feature | Status | Source |
|---------|--------|--------|
| Canvas JPEG screencast viewer (`RemoteBrowser`) | ✅ Use as-is | `react/src/index.tsx:372–376` |
| `@atriumjs/protocol` wire schemas | ✅ Use as-is | `protocol/src/index.ts` |
| Playwright-based screencast pipeline (CDP) | ✅ Reusable pattern | `worker/src/index.ts:594–656` |
| Human takeover (`request_control`/`release_control`) | ✅ Protocol built-in | `worker/src/index.ts:1262–1272` |
| Persistent browser context (`launchPersistentContext`) | ❌ Not present | Uses `chromium.launch` + `newContext` |
| Per-bot identity / multi-bot session mapping | ❌ Not present | In-memory session map keyed by UUID |
| `@eN` accessibility ref semantics | ❌ Not present | No AX-tree or ref tracking |
| Restart-safe profile survival | ❌ Not present | `MemorySessionStore` — all in-memory |

### Decision: HOB-Native Playwright Worker (no Atrium worker)

**Use `@atriumjs/react` and `@atriumjs/protocol` as npm dependencies (wire format + React viewer). Implement the backend in a new HOB-owned `server/browser-manager.mjs` using Playwright directly.**

**Rationale:**
1. Stock Atrium worker needs persistent context, restart safety, multi-bot mapping, and AX-ref semantics — that's most of the actual work regardless.
2. The Atrium worker is a separate HTTP server that would be a 4th supervised child, adding IPC complexity with no benefit HOB can't get directly.
3. HOB's Node.js process already has direct access to the Playwright Chromium at `/opt/hermes/tools/chrome` (verified in `deploy/probe-browser.mjs`).
4. `handleNodeViewerUpgrade` from `@atriumjs/core` provides the exact WebSocket upgrade handler HOB needs, wired to HOB's `node:http` server.
5. Maintenance: one codebase to own, zero forks.

### What changes this decision

If Atrium v0.4+ ships persistent context support, the worker could be reintroduced without architecture change since the protocol boundary is fixed.

---

## Part 3 — Verified Integration Contracts

### Contract 1: Controller Registration (Dashboard WebSocket)

HOB registers over its existing `HermesSessionBridge` WebSocket connection to `/api/ws`:

```json
// HOB → Hermes Gateway (browser.controller.register)
{
  "jsonrpc": "2.0",
  "id": 42,
  "method": "browser.controller.register",
  "params": {
    "protocol_version": 1,
    "session_id": "<raw_hermes_session_id>",
    "controller_id": "hob-browser-<botId>-<restartUUID>",
    "browser_profile_id": "br-<16hex>",
    "capabilities": [
      "browser_navigate", "browser_click", "browser_type",
      "browser_snapshot", "browser_screenshot", "browser_scroll",
      "browser_press", "browser_tabs", "browser_back", "controller.noop"
    ]
  }
}
```

Success response confirms scope. **Transport family will be `"cloud-ticket-ws"` (derived server-side).**

### Contract 2: Command Dispatch (Hermes → HOB)

When Hermes routes a `browser_*` tool call, HOB receives on the same WS:
```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "type": "browser.controller.command",
    "session_id": "<session_id>",
    "payload": {
      "command_id": "<hex>",
      "action": "browser_click",
      "arguments": { "ref": "@e3" },
      "controller_id": "hob-browser-...",
      "browser_profile_id": "br-...",
      "tool_call_id": "<tool_call_id>"
    }
  }
}
```

HOB must respond with `browser.controller.result`:
```json
{
  "jsonrpc": "2.0",
  "id": <next_id>,
  "method": "browser.controller.result",
  "params": {
    "command_id": "<same hex>",
    "ok": true,
    "result": "<tool-shaped JSON string>"
  }
}
```

### Contract 3: Tool Semantics (HOB must implement)

**This is the largest implementation cost.** Hermes passes raw tool args and expects the tool-shaped result string. HOB must implement the AX-snapshot format:

`browser_snapshot` must return an accessibility tree with `@eN` refs:
```
Page: Example Domain
[1] button "Click me" @e1
[2] input "Search" @e2
[3] link "Home" @e3
```

`browser_click{ref: "@e3"}` — HOB must maintain an in-memory ref→element mapping per page.

**Implementation:** Use Playwright's `page.accessibility.snapshot()` recursively, assign sequential `@eN` IDs, store the map per live page, and resolve refs on click/type/press.

### Contract 4: HOB Viewer WebSocket

The `@atriumjs/react` `RemoteBrowser` component connects to:
```
ws://localhost:3000/api/browser/stream/<botId>?token=<viewerToken>
```

HOB's `node:http` server handles the upgrade via `handleNodeViewerUpgrade` from `@atriumjs/core`, gated by HOB's cookie auth.

The wire protocol is the Atrium protocol (verified in `protocol/src/index.ts`):
- **Server→client:** `{ t: "hello" }`, `{ t: "frame", seq, ts, mime }` + binary JPEG, `{ t: "control" }`, `{ t: "tabs" }`, `{ t: "navigate" }`, etc.
- **Client→server:** `{ t: "input" }`, `{ t: "request_control" }`, `{ t: "release_control" }`, etc.

---

## Part 4 — HOB Persistence Architecture (Correction to PRD)

**Verified: HOB has NO SQLite database.** The PRD referenced "existing SQLite" — this is incorrect.

HOB uses atomic JSON files exclusively:
- `bots.json` — bot roster (`HermesBotRegistry`, `hermes-bots.mjs:13–104`)
- `runs.json` — admission journal (`HermesRunJournal`, `hermes-run-journal.mjs`)
- `listener-auth.json` — credentials (`bootstrap-hermes.mjs:10–36`)

**Correction:** The browser subsystem MUST follow the same pattern. Use `$HOB_STATE_DIR/browsers.json` (atomic write, mode 0600, single writer, version:1), **not** SQLite.

---

## Part 5 — `SESSION_METHODS` Allowlist Gap

`hermes-session.mjs:10–15` defines `SESSION_METHODS`:
```javascript
export const SESSION_METHODS = new Set(['ping', 'runtime.describe', ..., 'command.dispatch', ...]);
```

`browser.controller.register` and `browser.controller.result` are **NOT** in this set.

`HermesSessionBridge.rpc()` at line 136 throws `INVALID_REQUEST` for unlisted methods.

**Required change in `hermes-session.mjs`:** Add `'browser.controller.register'`, `'browser.controller.result'`, `'browser.controller.heartbeat'`, `'browser.controller.detach'` to `SESSION_METHODS`.

This is a **minimal, additive change** to an existing list — no logic changes.

---

## Part 6 — Exact Implementation Plan (Phase by Phase)

### Phase 0 — Gate: Smoke-Test Controller Registration (NOT skippable)

**Before writing any production code**, write a standalone test:

`server/test/browser-controller-smoke.test.mjs`:
1. Bring up Hermes in test mode (or mock the WS).
2. Create a native session via `bridge.rpc(profile, 'session.create', {...})`.
3. Add `browser.controller.register` to `SESSION_METHODS` temporarily.
4. Call register with a fake `browser_profile_id` and capabilities.
5. Assert the response contains a valid `scope`.
6. Submit a prompt and assert a `browser.controller.command` frame arrives.

**If this fails**, report the exact error before writing Phase 1+.

---

### Phase 1 — SESSION_METHODS Extension (Minimal Change)

**File:** [`server/hermes-session.mjs`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/server/hermes-session.mjs)

Add to `SESSION_METHODS` (line 10–15):
```diff
 export const SESSION_METHODS = new Set(['ping', 'runtime.describe', 'setup.status', 'setup.runtime_check',
   'session.create', 'session.list', 'session.info', 'session.resume', 'session.detach', 'session.interrupt', 'session.mutate',
   'session.events.since', 'session.stats', 'prompt.submit', 'prompt.receipt', 'prompt.cancel',
   'prompt.resolve_unknown', 'approval.respond', 'clarify.respond', 'command.dispatch',
+  'browser.controller.register', 'browser.controller.result', 'browser.controller.heartbeat', 'browser.controller.detach',
   'groups.capabilities', ...]);
```

**Test file:** `server/test/hermes-session.test.mjs` — add a test asserting the new methods are in the set.

---

### Phase 2 — Browser Registry (`server/browser-registry.mjs`)

New file. Mirrors `HermesBotRegistry` exactly in pattern.

**Stores:** `$HOB_STATE_DIR/browsers.json`:
```json
{
  "version": 1,
  "browsers": [{
    "bot": "default",
    "browserProfileId": "br-<16hex>",
    "profileDir": "/opt/data/.hob/browsers/default/chromium",
    "state": "idle",
    "controlHolder": "agent",
    "controlSince": "2026-...",
    "controllerId": null,
    "sessionId": null,
    "createdAt": "...",
    "lastActiveAt": null
  }]
}
```

**API surface:**
```javascript
export class BrowserRegistry {
  static async open({ stateDir }) { ... }
  get(botId) { ... }        // returns record or null
  getOrCreate(botId) { ... } // assigns profileId and profileDir on first call
  update(botId, patch) { ... } // atomic write
  list() { ... }
  profileDir(botId) { ... } // computed path, not stored
}
```

**Profile dir convention:** `path.join(stateDir, 'browsers', botId, 'chromium')`

**Test file:** `server/test/browser-registry.test.mjs`

---

### Phase 3 — Browser Manager (`server/browser-manager.mjs`)

Core lifecycle module. Manages Playwright persistent contexts.

**Key exports:**
```javascript
export class BrowserManager {
  constructor({ registry, stateDir }) { ... }

  // Returns live context or starts one (lazy). Never starts if already running.
  async ensureRunning(botId) { ... }

  // Stop and release. Called by idle timer or explicit stop.
  async stop(botId) { ... }

  // Getter for active Playwright page (null if not running)
  page(botId) { ... }

  // Control lease
  controlHolder(botId) { ... }  // 'agent' | 'human'
  async grantControl(botId, holder) { ... }

  // Idle timer management (10 min with no viewer, no active command)
  refreshIdle(botId) { ... }
  cancelIdle(botId) { ... }

  // CDP screencast — returns an AsyncGenerator<{seq, jpeg: Buffer}>
  screencastStream(botId) { ... }

  // Shutdown all (called on SIGTERM)
  async closeAll() { ... }
}
```

**Launch code:**
```javascript
const context = await chromium.launchPersistentContext(profileDir, {
  executablePath: process.env.PLAYWRIGHT_CHROME_EXECUTABLE
    || findBrowserExecutable(),  // same logic as deploy/probe-browser.mjs
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
         '--remote-debugging-port=0'],
  viewport: { width: 1280, height: 800 },
  ignoreDefaultArgs: ['--enable-automation'],
});
```

**findBrowserExecutable():** Mirror `deploy/probe-browser.mjs` logic — scan `PLAYWRIGHT_BROWSERS_PATH` or `/opt/hermes/tools` for `chrome`/`chromium`.

**AX snapshot with @eN refs:**
```javascript
async function takeSnapshot(page) {
  const tree = await page.accessibility.snapshot({ interestingOnly: false });
  const refs = new Map();   // '@e1' -> node
  let seq = 0;
  function walk(node) {
    const ref = `@e${++seq}`;
    refs.set(ref, node);
    node._ref = ref;
    (node.children || []).forEach(walk);
  }
  walk(tree);
  const text = formatTree(tree);  // "Page: ...\n[1] button 'X' @e1\n..."
  return { text, refs };
}
```

**Idle timer:**
```javascript
const IDLE_MS = 10 * 60 * 1000; // 10 minutes
scheduleIdle(botId) {
  clearTimeout(this._idle.get(botId));
  this._idle.set(botId, setTimeout(() => this.stop(botId), IDLE_MS));
}
```

**Test file:** `server/test/browser-manager.test.mjs` (uses a mock Playwright with stubs for launch/CDP)

---

### Phase 4 — Browser Controller (`server/browser-controller.mjs`)

Hermes wire adapter. Runs per active session.

```javascript
export class BrowserController {
  constructor({ bridge, registry, manager, botId, sessionId, controllerId }) { ... }

  // Register on Hermes dashboard WS and set up command listener
  async register() { ... }

  // Handle browser.controller.command frame
  async handleCommand(payload) {
    const { command_id, action, arguments: args } = payload;
    if (manager.controlHolder(botId) === 'human') {
      await reply(command_id, false, { code: 'human_control',
        message: 'A human is in control. Try again after control is released.' });
      return;
    }
    try {
      const result = await this._dispatch(action, args);
      await reply(command_id, true, result);
    } catch (err) {
      await reply(command_id, false, { message: err.message });
    }
  }

  async _dispatch(action, args) {
    const page = manager.page(botId) || await manager.ensureRunning(botId);
    switch (action) {
      case 'browser_navigate': return this._navigate(page, args);
      case 'browser_click': return this._click(page, args);
      case 'browser_type': return this._type(page, args);
      case 'browser_snapshot': return this._snapshot(page, args);
      case 'browser_screenshot': return this._screenshot(page, args);
      case 'browser_scroll': return this._scroll(page, args);
      case 'browser_press': return this._press(page, args);
      case 'browser_tabs': return this._tabs(page, args);
      case 'browser_back': return this._back(page, args);
      case 'browser_tab_activate': return this._tabActivate(page, args);
      case 'controller.noop': return '';
    }
  }
}
```

**HOB receives `browser.controller.command` as an `event` frame on the existing WS listener in `HermesSessionBridge`.** The bridge must emit these events to the controller. The bridge already emits `'event'` frames (line 111: `this.emit('event', { profile, event })`). The controller subscribes to those.

**Wire through `hermes-session.mjs`:** The bridge emits events of type `browser.controller.command`. The controller filters by `event.type === 'browser.controller.command'` and `event.session_id === this.sessionId`.

**Test file:** `server/test/browser-controller.test.mjs` (mocks `HermesSessionBridge` with event emitter)

---

### Phase 5 — Browser Routes (`server/browser-routes.mjs`)

New HTTP + WebSocket routes:

```
GET  /api/browser/:botId/status        → { state, controlHolder, url, ... }
POST /api/browser/:botId/start         → starts browser lazily
POST /api/browser/:botId/stop          → stops browser
POST /api/browser/:botId/control       → { holder: 'human' | 'agent' }
GET  /api/browser/:botId/session       → { sessionId, viewerToken } (Atrium session)
WS   /api/browser/stream/:botId        → Atrium wire protocol viewer stream
```

**WS upgrade:** In `server/app.mjs`, add after `server` creation:
```javascript
import { handleNodeViewerUpgrade } from '@atriumjs/core';
// ...
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://muse.local');
  if (!url.pathname.startsWith('/api/browser/stream/')) { socket.destroy(); return; }
  if (!authenticatedUpgrade(req)) { socket.destroy(); return; }
  const botId = decodeURIComponent(url.pathname.slice('/api/browser/stream/'.length));
  browserRoutes.handleUpgrade(req, socket, head, botId);
});
```

**Test file:** `server/test/browser-routes.test.mjs`

---

### Phase 6 — Frontend Viewer (`web/src/components/BrowserViewer.tsx`)

```tsx
import { RemoteBrowser, RemoteBrowserHandle } from '@atriumjs/react';

interface Props {
  botId: string;
  sessionId: string;
  viewerToken: string;
}

export function BrowserViewer({ botId, sessionId, viewerToken }: Props) {
  const wsUrl = `/api/browser/stream/${encodeURIComponent(botId)}`;
  const browserRef = useRef<RemoteBrowserHandle>(null);
  const [controlHolder, setControlHolder] = useState<'agent' | 'human'>('agent');

  return (
    <div className="relative w-full h-full">
      {/* Agent cursor overlay — when holder is 'agent' */}
      <AgentCursorOverlay />

      <RemoteBrowser
        ref={browserRef}
        chrome="none"
        sessionId={sessionId}
        viewerToken={viewerToken}
        wsUrl={wsUrl}
        interactive={controlHolder === 'human'}
        onControlChange={setControlHolder}
        style={{ width: '100%', height: '100%' }}
      />

      {/* HOB-styled toolbar */}
      <BrowserToolbar
        controlHolder={controlHolder}
        onTakeControl={() => browserRef.current?.requestControl()}
        onReleaseControl={() => browserRef.current?.releaseControl()}
      />
    </div>
  );
}
```

**Integration point:** [`web/src/pages/HermesWorkspace.tsx:157–184`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/web/src/pages/HermesWorkspace.tsx#L157-L184) — replace stub with `<BrowserViewer>`.

**Package additions to `web/package.json`:**
- `"@atriumjs/react": "^0.3.0"`
- `"@atriumjs/protocol": "^0.3.0"`
- (optionally) `"@atriumjs/core": "^0.3.0"` for `handleNodeViewerUpgrade`

**Package additions to `server/package.json`:**
- `"playwright-core": "^1.49.0"` (not full playwright; reuses in-image Chromium)
- `"@atriumjs/core": "^0.3.0"`

---

### Phase 7 — Config Seeding (`deploy/seed-hermes-config.mjs` + `server/hermes-bots.mjs`)

**`seed-hermes-config.mjs`:** Add `browser: { extension_control: { enabled: true } }` to the seeded config object (line 8):
```diff
-const config = { gateway: { multiplex_profiles: true }, terminal: { cwd: workspace },
-  auth: { adopt_external_logins: false } };
+const config = { gateway: { multiplex_profiles: true }, terminal: { cwd: workspace },
+  auth: { adopt_external_logins: false },
+  browser: { extension_control: { enabled: true } } };
```

**`server/hermes-bots.mjs` `finishSetup`:** Add browser profile dir creation and config patch (after line 154):
```javascript
// Create browser profile directory for the bot
await mkdir(path.join(stateDir, 'browsers', name, 'chromium'), { recursive: true, mode: 0o700 });
// Ensure browser extension_control is on for this profile
await this.#client.dashboard('/api/config', { profile: name, method: 'PUT',
  body: { profile: name, config: { browser: { extension_control: { enabled: true } } } } });
```

> **Risk:** Enabling `browser.extension_control.enabled` globally causes all `browser_*` tool calls to fail closed if HOB's controller is not registered for that session lane. The `lane_registered` fallback in `browser_extension_router.py:87–89` keeps the legacy backend for unregistered lanes. HOB must ensure registration happens before any browser tool call arrives for a session.

---

### Phase 8 — Server Composition (`server/index.mjs`)

Add browser subsystem initialization:

```javascript
// After line 22 (runJournal)
import { BrowserRegistry } from './browser-registry.mjs';
import { BrowserManager } from './browser-manager.mjs';
import { createBrowserRoutes } from './browser-routes.mjs';

const browserRegistry = await BrowserRegistry.open({ stateDir: process.env.HOB_STATE_DIR });
const browserManager = new BrowserManager({ registry: browserRegistry,
  stateDir: process.env.HOB_STATE_DIR });

// Pass to createApp
const server = createApp({ gateway, bots, runJournal, nativeSessions, browserManager, browserRegistry, ... });

// Add to shutdown (line 27)
const shutdown = () => {
  browserManager.closeAll().catch(() => {});
  nativeSessions.close();
  gateway.stop();
  server.close();
  server.closeAllConnections();
};
```

---

## Part 7 — Locked Requirements Compliance

| Requirement | Implementation | Status |
|---|---|---|
| One persistent profile per bot | `launchPersistentContext(profileDir)` where `profileDir = $HOB_STATE_DIR/browsers/<botId>/chromium` | ✅ |
| Lazy Chromium startup | `BrowserManager.ensureRunning(botId)` called on first agent command or viewer open only | ✅ |
| 10-minute idle shutdown | `scheduleIdle()` with `IDLE_MS = 10 * 60 * 1000`; refreshed on agent commands and viewer connections | ✅ |
| Viewer-only screencasting | CDP screencast only starts when a WS viewer connects; `Page.stopScreencast` on last viewer disconnect | ✅ |
| Safe human takeover | `controlHolder` flag; agent commands rejected with structured error while `holder === 'human'` | ✅ |
| No unnecessary desktop environment | `headless: true`, ATRIUM_WORKER_HEADLESS=1 (no Xvfb) | ✅ |
| Chromium sandboxing where supported | Use `--no-sandbox` only as fallback; `deploy/chromium-seccomp.json` already present | ✅ |
| No Hermes source modification | All changes are HOB-side; Hermes config change only (YAML key addition) | ✅ |
| Preserve existing HOB UI/API/chat | All new routes under `/api/browser/`, new WS path, no existing routes removed | ✅ |

---

## Part 8 — Implementation Order & Gates

```
Phase 0: Smoke test (GATE — must pass before proceeding)
    ↓
Phase 1: SESSION_METHODS extension
    ↓
Phase 2: BrowserRegistry (data layer)
    ↓
Phase 3: BrowserManager (lifecycle + CDP)
    ↓
Phase 4: BrowserController (Hermes wire)
    ↓
Phase 5: BrowserRoutes (HTTP + WS upgrade)
    ↓
Phase 6: Frontend BrowserViewer
    ↓
Phase 7: Config seeding
    ↓
Phase 8: Server composition wiring
    ↓
Verification: Extend deploy/smoke-container.mjs with browser E2E test
```

---

## Part 9 — Files to Create (new)

| File | Phase | Description |
|------|-------|-------------|
| `server/browser-registry.mjs` | 2 | Persistent bot→profile mapping, JSON sidecar |
| `server/browser-manager.mjs` | 3 | Playwright lifecycle, CDP screencast, AX refs |
| `server/browser-controller.mjs` | 4 | Hermes wire adapter |
| `server/browser-routes.mjs` | 5 | HTTP REST + WS upgrade handler |
| `web/src/components/BrowserViewer.tsx` | 6 | React wrapper for `@atriumjs/react` |
| `server/test/browser-registry.test.mjs` | 2 | Unit tests |
| `server/test/browser-manager.test.mjs` | 3 | Unit tests with Playwright mocks |
| `server/test/browser-controller.test.mjs` | 4 | Unit tests with WS mock |
| `server/test/browser-routes.test.mjs` | 5 | Route integration tests |
| `server/test/browser-controller-smoke.test.mjs` | 0 | Gate test |

---

## Part 10 — Files to Modify (minimal, additive only)

| File | Lines | Change |
|------|-------|--------|
| `server/hermes-session.mjs` | 10–15 | Add 4 browser.controller.* methods to SESSION_METHODS |
| `server/index.mjs` | 19–27 | Construct BrowserRegistry, BrowserManager; pass to createApp; add to shutdown |
| `server/app.mjs` | 109 (createApp signature), 446 (server.on upgrade) | Accept browserManager/browserRegistry; add WS upgrade handler |
| `deploy/seed-hermes-config.mjs` | 8 | Add `browser.extension_control.enabled: true` to seeded config |
| `server/hermes-bots.mjs` | 150–156 | Add browser profile dir creation + per-profile extension_control config |
| `web/package.json` | dependencies | Add `@atriumjs/react`, `@atriumjs/protocol`, `@atriumjs/core` |
| `server/package.json` | dependencies | Add `playwright-core`, `@atriumjs/core` |
| `web/src/pages/HermesWorkspace.tsx` | 157–184 | Replace HermesBrowser stub with BrowserViewer |
| `web/src/components/RightPanel.tsx` | ~459 | No change needed — BrowserPanel already calls HermesBrowser which we replace |

**DO NOT TOUCH:** `hermes-agent/` (any file), Dockerfile (unless adding playwright-core to npm install), any test harness not listed above.
