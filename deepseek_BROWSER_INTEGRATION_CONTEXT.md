# HOB Browser Integration — Reconnaissance Handoff

**Status:** READ-ONLY reconnaissance. No source was modified. The only artifact created is this file.
**Audience:** the implementation model that will receive this document plus the Browser System PRD.
**Repos inspected:** HOB (`abdlx/hob`, the current working tree), official Hermes
(`NousResearch/hermes-agent`, via the pinned runtime commit + the local reference tree at
`hermes-agent/`), Atrium (`ohmaseclaro/atrium`, cloned to a temp research dir).

> **How to read this file.** Claims are tagged:
> **[V]** verified in source (file + symbol cited), **[A]** assumption / inference not fully proven,
> **[?]** unresolved question requiring a verification step before implementation.
> Line numbers refer to the local trees at recon time; always re-open the cited symbol.

---

## 0. One-paragraph answer

Hermes **already ships the entire agent-side half of this feature**: an identity-scoped
*browser-control broker* plus an authenticated *controller* wire (register ticket + WebSocket) that
lets an external process become the authoritative browser for a given Hermes session, with the
agent's own `browser_*` tools routed to it and failing closed. That mechanism is the correct,
upgrade-safe integration point, and it requires **zero Hermes source changes** (a single config key
opts in). The missing half is entirely on the HOB side: a browser **manager/registry** (per-bot
persistent identity + lazy lifecycle), a **controller adapter** that speaks the Hermes wire and
drives a real Chromium, and a **viewer** in the React app. Atrium is a good fit for the
**presentation + input-relay + human-takeover** layers (MIT, v0.3.0, Playwright worker + React
viewer), but it does **not** implement per-bot persistent profiles, lazy agent-driven launch, or the
Hermes accessibility-snapshot/`@eN`-ref tool semantics — those layers must be built in HOB (or a
minimal worker patch). The single blocking unknown is whether Hermes stamps the browser-control
identity onto runs submitted through the **native session authority** (HOB's current chat transport)
or only through the **api_server** transport — this determines how HOB submits browser-using turns.

---

## 1. Executive architecture summary

**HOB [V]** is a thin Node/React dashboard ("OpenMuse") in front of an **unmodified** Hermes Agent.
It owns login, the UI, and an HTTP/SSE adapter. Hermes owns agents, tools, profiles, memory,
sessions, runs, approvals and browser automation. HOB never imports Hermes Python; it talks HTTP
(runtime `:8642`) and a native WebSocket session protocol (`hermes-gateway-v1`) to the local
Hermes gateway.

**Process topology [V] (`deploy/bootstrap-hermes.mjs::bootstrapHermes`, lines 40–85).** HOB's
supervisor (`deploy/start.mjs::supervise`) runs three children:
1. `hermes -p default serve --host 127.0.0.1 --port 8080 --isolated` — **settings/dashboard**
   listener (`HERMES_DASHBOARD_SESSION_TOKEN`).
2. `hermes -p default gateway run --no-supervise --external-supervisor` — the **runtime** process.
   It hosts (a) the **api_server** platform on `127.0.0.1:8642` (`API_SERVER_KEY`) **and** (b) the
   **native session authority** used by HOB chat. `GATEWAY_MULTIPLEX_PROFILES=true` → one process
   serves many bot profiles.
3. `node server/index.mjs` — the **public HOB app** on `:3000`.

Consequence: the Hermes browser-control broker is **process-local to child #2**, and the api_server
runs inside it. One Hermes process, many profiles, one broker. **[V]**

**Integration shape recommended.** Keep Hermes unmodified. Opt in with
`browser.extension_control.enabled: true`. HOB runs one **Browser Manager** (lifecycle + per-bot
metadata), one **Browser Controller** per active bot (registers over
`POST /v1/browser-control/register`, attaches `GET /v1/browser-control/ws`, executes
`browser.controller.command` frames against that bot's Chromium), and one **viewer** in React fed by
the Atrium worker's screencast WebSocket. Hermes's `browser_*` tools become a thin proxy to HOB's
controller; Hermes's own local/cloud browser backends are bypassed for those sessions (fail-closed),
so there is exactly one browser per bot. **[V]/[A]**

---

## 2. HOB source-code map

### 2.1 Frameworks and build

| Aspect | Fact | Source **[V]** |
|---|---|---|
| Frontend | React 19, react-router-dom 7, Vite 8, Tailwind 4, lucide-react | `web/package.json` |
| FE build | `tsc -b && vite build` → `web/dist` | `web/package.json` scripts; `Dockerfile:18–23` |
| Backend | Plain `node:http`, ESM `.mjs`, **no framework, no ORM, no SQLite** | `server/app.mjs:1`, `server/index.mjs` |
| Backend entry | `server/index.mjs` → `createApp(...)` | `server/index.mjs:1–28` |
| Tests (server) | `node --test test/*.test.mjs` (17 files) | `server/package.json:7` |
| Tests (deploy) | `node --test deploy/*.test.mjs`, plus container smoke/probe scripts | `deploy/*.test.mjs`, `deploy/smoke-*.mjs`, `deploy/probe-browser.mjs` |
| Web tests | `web/tests/` exists; **no** `test` script in `web/package.json` | `web/package.json` **[V]** |

### 2.2 Server modules (all under `server/`)

| File | Role **[V]** |
|---|---|
| `index.mjs` | Composition root: opens `HermesBotRegistry`, builds `HermesBots`, `HermesSessionBridge`, `HermesRunJournal`, `HermesClient`, then `createApp`. Requires `HERMES_HOME` + `HOB_STATE_DIR`. |
| `app.mjs` | `node:http` server; auth, cookie, origin checks, static assets, and the **route table** that fans out to the `hermes-*` modules. |
| `hermes-client.mjs` | `HermesClient` — HTTP boundary to upstream runtime/dashboard. Per-profile Bearer key via `profileAccess`; `runtime()`, `dashboard()`, `events()` (SSE), `credentialBinding()`, `getProfileStatus()`. Also `HermesError`, `hermesProfile`, `hermesResource`, `hermesSessionKey`, `hermesNativeSessionKey`, `parseHermesSessionKey`. |
| `hermes-session.mjs` | `HermesSessionBridge` — the `hermes-gateway-v1` WebSocket client to the **native session authority**. `rpc(profile, method, params)`; `SESSION_METHODS` allowlist (`session.create/list/info/resume/detach/interrupt/mutate/events.since/stats`, `prompt.submit/receipt/cancel/resolve_unknown`, `approval.respond`, `clarify.respond`, `command.dispatch`, `groups.*`). Emits `event` frames. |
| `hermes-bots.mjs` | `HermesBotRegistry` (persistent `bots.json` roster) and `HermesBots` (create/finishSetup/remove against Hermes dashboard `/api/profiles`). |
| `hermes-canonical-chat.mjs` | The **active chat path**: maps HOB REST/SSE onto native `session.create` / `prompt.submit` / `session.resume` / `session.interrupt` / `approval.respond` / `clarify.respond`. Session ids = `hermesNativeSessionKey(profile, sessionId)` = base64url `[profile, sessionId, "canonical"]`. |
| `hermes-chat.mjs` | Legacy HTTP-run chat adapter (older API conversations, read-only). |
| `hermes-run-journal.mjs` | `HermesRunJournal` — adapter-correlation journal (`journal.json`); **not** execution authority. |
| `hermes-routes.mjs` | Explicit allowlist of dashboard management ops (`/api/config`, `/api/env`, `/api/model/*`, `/api/skills`, `/api/providers/*`). |
| `hermes-setup.mjs`, `hermes-groups.mjs`, `hermes-workspace.mjs`, `hermes-mcp-oauth.mjs`, `hermes-memory-setup.mjs`, `hermes-learning-setup.mjs`, `hermes-settings.mjs` | Setup wizard, native group rooms, bot workspace files, MCP OAuth callback, memory/learning/settings helpers. |

### 2.3 Authentication / authorization **[V]**

- `MUSE_PASSWORD` or `MUSE_ACCESS_TOKEN` → HMAC-signed, HttpOnly, SameSite-Strict cookie, bound to a
  fingerprint (UA + IP) with a nonce and 24 h expiry (`app.mjs`, auth block ~lines 180–230).
- All `/api/*` require the cookie (`app.mjs:209–210`).
- **Per-bot selection** is the `X-Hob-Profile` header (validated against `/^[a-z][a-z0-9_-]{0,63}$/`).
  Frontend sets it in `web/src/services/api.ts:12–25,35–43`.
- HOB is a single trusted operator surface: **there is no per-user bot ACL**. All logged-in users can
  reach every bot. Any "human takeover authorization" must therefore be defined **inside** HOB's
  operator model, not assumed from Hermes.

### 2.4 Bot/profile lifecycle **[V]** (`server/hermes-bots.mjs`)

- Persistent roster `bots.json` in `HOB_STATE_DIR` (`/opt/data/.hob` in the image): `{version, bots:[{name,state,nativeCreated,apiKey,createdAt}]}`. Written atomically (`#mutate`, tmp + rename), mode 0600, single writer.
- `create` → `registry.reserve(name)` then Hermes dashboard `POST /api/profiles`.
- `finishSetup(name)` → Hermes dashboard `PUT /api/config` (`terminal.cwd`, `auth.adopt_external_logins:false`) and `PUT /api/env` (`API_SERVER_KEY = record.apiKey`).
- **`registry.token(name)` returns that bot's 64-hex API key** → this *is* the profile's api_server bearer key. **This is the key HOB already holds for the browser-control register call.** **[V]**
- `list()` merges HOB roster with Hermes `/api/profiles`.

### 2.5 Existing browser UI **[V]**

- `web/src/components/RightPanel.tsx`: `BrowserPanel()` (line 459) chooses `HermesBrowser` when
  `runtime === 'hermes'`, else `OpenClawBrowserPanel` (legacy).
- `web/src/pages/HermesWorkspace.tsx:157` `HermesBrowser` — **a stub**: it validates a URL and calls
  `sendMessage("Use your browser tools to open …")`. There is **no viewer, no frames, no tabs, no
  takeover**. This is the component to replace.
- Legacy OpenClaw browser routes exist at `server/app.mjs:356–367` (`/api/browser/tabs`,
  `/api/browser/actions` → `rpc('browser.request', …)`), but they are **unreachable** on a Hermes
  server: `server/app.mjs:234` returns `409 DASHBOARD_RUNTIME_MISMATCH` before them.
  `browserImage()` reads screenshots from `<stateDir>/media/browser`. Do not extend these; they are
  dead on the Hermes path.
- `deploy/probe-browser.mjs` is a container-only sanity probe that locates a `chrome` binary under
  `PLAYWRIGHT_BROWSERS_PATH` (default `/opt/hermes/tools`) and launches it — useful precedent for
  verifying a Chromium exists in-image. **[V]**

### 2.6 Chat streaming architecture **[V]**

- `POST /api/sessions/:id/turns` → SSE frames `accepted` → `delta{text,replace?}` → `done{message}` |
  `error{message}`. Implemented in `hermes-canonical-chat.mjs::route` (~lines 233–313).
- Frontend `web/src/services/api.ts::sendMessage` → `readTurnStream` (`web/src/services/stream.ts`).
- Live events: `GET /api/events` (SSE) multiplexes `connection{connected}` and `gateway{event,payload}`.
- **HOB has no WebSocket server today.** Everything is HTTP + SSE (`node:http`). Adding a
  real-time browser frame channel means introducing HOB's first WS upgrade (or reusing SSE).

### 2.7 Web component structure (relevant)

`web/src/` — `App.tsx`, pages (`HermesWorkspace.tsx`, `HermesSettings.tsx`, …), `components/`
(`RightPanel.tsx` (766 L), `BotsSidebar.tsx` (422 L), `ChatMessageList/Item`, `LeftSidebar`,
`MobileDock`, settings panes), `context/ChatContext`, `services/` (`api.ts`, `stream.ts`,
`hermes-workspace.ts`). Layout: left sidebar = bots; center = chat; right panel = tabs
(Details / Web / Files / …); `activeTab === 'browser'` renders `BrowserPanel` (`RightPanel.tsx:783–784`).

---

## 3. Hermes integration / API map

**Version pin [V]:** `Dockerfile:16` pins
`ghcr.io/abdlx/hob-hermes-runtime:hermes-7e9eb8d9@sha256:1863…`. The commit is
`7e9eb8d9a30f4a9bb9f8ecaf816b4b0ffdf47357` (`.github/workflows/hermes-runtime-image.yml:34`), built
from upstream `NousResearch/hermes-agent` with upstream's own Dockerfile. The local `hermes-agent/`
tree is a **gitignored, untracked reference copy** with no `.git` of its own (`.gitignore:1`;
`git ls-files hermes-agent` = 0). **[V]** → Treat symbols below as accurate for the reference tree;
**[?]** re-confirm the commit hash of that tree before trusting exact line numbers.

### 3.1 How HOB uses Hermes **[V]**

- Embedded/process/API: **launched as processes**, accessed by **HTTP** (`HermesClient`) and a
  **native WS session protocol** (`HermesSessionBridge`, `hermes-gateway-v1`). No Python imports.
- Profiles: created via dashboard `/api/profiles`; per-profile `API_SERVER_KEY` via dashboard `/api/env`.
- Messages/runs: **native** `prompt.submit` (+ `session.create`), *not* the api_server `/v1/runs`.
- Tool execution: entirely inside Hermes (tools run in the runtime process).
- Approvals: native `approval.respond` / `clarify.respond` via the bridge.

### 3.2 Hermes browser subsystems **[V]**

Hermes has **three** relevant browser layers:

1. **Local `agent-browser` backend** — `tools/browser_tool.py` + `browser_tool_session.py`,
   `browser_tool_lifecycle.py`, `browser_cdp_tool.py`, `browser_tool_real_profile.py`,
   `browser_tool_vision.py`, `browser_use_cli.py`, `browser_camofox*.py`, `browser_lightpanda.py`.
   Per-task `--session <name>`; persistent dir via env `AGENT_BROWSER_PROFILE`
   (`browser_tool_session.py:661`); accessibility snapshots with `@eN` refs; automatic cleanup.
   `browser.extension_control.enabled` defaults **off** (`hermes_cli/config_defaults.py:494`).
2. **Bot Desktop** (`tools/bot_desktop/`) — a headed Chromium on a virtual screen (X11/Xvfb) with a
   *shared* persistent profile dir (`bot_desktop/browser.py::profile_dir()`), a DevTools port
   discoverable via `running_instance_cdp_port(user_data_dir)` (line 118), and a **human-control
   lease** (`bot_desktop/lease.py`: `acquire/release/human_holds/viewer_may_send_input/
   assert_agent_may_act`). This is Hermes's own human-takeover mechanism. It is **Hermes-internal**
   (not exposed to HOB) but proves the semantics the PRD wants.
3. **Browser-extension control (the integration seam)** — `gateway/browser_control_broker.py`,
   `gateway/browser_control_artifacts.py`, `tools/browser_extension_router.py`, api_server routes,
   and the dashboard RPC twin `tui_gateway/methods_browser_control.py`.

### 3.3 Browser-extension control — full contract **[V]**

**Enable flag.** `browser.extension_control.enabled` (default `false`) and
`.developer_mode` (default `false`) — `hermes_cli/config_defaults.py:494`;
read by `gateway/browser_control_broker.py::browser_control_enabled()` (line 69) and
`browser_control_developer_mode()` (line 64).

**Discovery.** `GET /v1/capabilities` returns `features.browser_extension_control`
(`gateway/platforms/api_server.py:2464–2481`):
```
{ enabled, protocol_version:1, capabilities:[…], artifact_capabilities:[…],
  developer_capabilities:[…], developer_mode,
  artifact_transport:{ upload:{POST /v1/artifacts/upload},
                       download:{GET /v1/artifacts/download/{id}},
                       max_bytes:10485760, ttl_seconds:300, allowed_mime_types:[…] },
  real_browser_actions:true,
  transports:{ local_vps:"websocket-subprotocol-ticket",
               cloud:"authenticated-gateway-rpc" } }
```
Capability allowlist (`api_server.py:2467`; doc `website/docs/user-guide/features/api-server.md:315–327`):
`controller.noop, browser_back, browser_click, browser_navigate, browser_press, browser_screenshot,
browser_scroll, browser_snapshot, browser_tab_activate, browser_tabs, browser_type`.
Developer mode adds `browser_evaluate` + raw CDP. **Not** available: uploads, image extraction, vision,
console.

**Registration.** `POST /v1/browser-control/register` (`api_server.py:2501`) — Bearer key + JSON body
`{protocol_version:1, controller_id, browser_profile_id, session_id, capabilities[]}`. Ladder:
`404` feature off · `403` no API key · `401` bad Bearer · `400` invalid/protocol/no-caps · `403`
session not in this profile's SessionDB · `201` success. Response:
`{protocol_version:1, ticket, ticket_expires_at, ticket_expires_in_seconds:30,
  ws_path:"/v1/browser-control/ws",
  scope:{principal_id,profile_id,session_id,controller_id,browser_profile_id,transport_family,capabilities}}`.
Identity is **server-derived**, never from the body:
`principal_id = "principal:"+profile+":"+sha256(profile+"\0"+expected_key).hex[:32]`
(`_derive_browser_control_principal`, line 2672); `transport_family` = `local-api` for a loopback
peer else `remote-api` (line 2679).

**Controller socket.** `GET /v1/browser-control/ws` (line 2580). Ticket must ride in
`Sec-WebSocket-Protocol` as **both** `hermes-browser-control-v1`
(`_BROWSER_CONTROL_WS_PROTOCOL`, line 104) **and exactly one**
`hermes-browser-control-ticket.<ticket>` (`_BROWSER_CONTROL_TICKET_PROTOCOL_PREFIX`, line 105); the
query string is rejected. Ticket is single-use, 30 s TTL. On attach the controller may send
`browser.controller.heartbeat{nonce}`, `browser.controller.result{command_id,ok,result|error}`,
`browser.controller.cancel{tool_call_id}`, `browser.controller.detach` (line 2635). Broker →
controller frames are `browser.controller.command{command_id,action,arguments,controller_id,
browser_profile_id,tool_call_id}` (`browser_control_broker.py:347`) and `browser.controller.cancel`
(line 166). Timeouts/cancels fail pending work closed; **errors are authoritative** (no legacy retry).

**Agent-side routing.** `tools/browser_extension_router.py`:
`routed_browser_handler(action,args,fallback,…)` reads identity from the session context
(`_bound_identity()` → `HERMES_SESSION_ID`, `HERMES_BROWSER_CONTROL_PRINCIPAL`,
`HERMES_BROWSER_CONTROL_TRANSPORT_FAMILY`; lines 29–37). Feature off / no identity ⇒ legacy
`fallback()`. Identity present but no controller ⇒ legacy only if the lane is *unregistered*;
registered-but-offline ⇒ **fail closed**. A selected controller is authoritative and its result (a
string, or JSON-serialized) is returned as the tool result (lines 78–99). The tool-availability gate
is `check_browser_routed_requirements(action) = local install OR extension_controller_available(action)`
(`tools/browser_tool.py:1320`; the routed tools are listed in `_BROWSER_TOOL_TABLE`, `browser_tool.py:1340`).

**Session env binding.** The api_server sets contextvars per request
(`api_server.py:1632–1640`) and `_bind_api_server_session(..., browser_control_principal=…,
browser_control_transport_family=…)` (`api_server.py:4064`) stamps them as session env vars
`HERMES_BROWSER_CONTROL_PRINCIPAL` / `HERMES_BROWSER_CONTROL_TRANSPORT_FAMILY`
(`gateway/session_context.py:34–44`). `gateway/session_api_turn.py:81–88` re-derives them for the
live-owner turn path. **This is the causal chain that makes routing work — and it is only wired on
the api_server transport.**

**Second transport (dashboard/RPC).** `tui_gateway/methods_browser_control.py` exposes
`browser.controller.register|result|heartbeat|detach` over the authenticated dashboard `/api/ws`
Gateway RPC; it binds to the server-minted `WSTransport.auth_identity`. This is the `cloud` transport
in the capabilities object. HOB already holds `HERMES_DASHBOARD_SESSION_TOKEN`. **[V]** (exists) /
**[?]** (whether it binds identity for native sessions).

**Artifacts.** Byte transport for uploads/downloads: `ArtifactStore` keyed by profile under
`<profile_dir>/artifacts/browser-control`; ids `[0-9a-f]{32}`; TTL 300 s; 10 MB; MIME allowlist
(`gateway/browser_control_artifacts.py`, `api_server.py:2699–2732`).

### 3.4 How a tool call travels Hermes → HOB's browser (target design) **[V]/[A]**

```
agent turn (session S, profile P)
  └─ model emits browser_click{ref:"@e3"}
      └─ model_tools.handle_function_call → registry handler for browser_click
          └─ routed_browser_handler("browser_click", {ref:"@e3"}, fallback=<agent-browser>)
              ├─ _bound_identity() → (S, principal:P:digest, "local-api")
              └─ broker.dispatch(scope, action="browser_click", arguments={ref:"@e3"}, tool_call_id)
                  └─ frame {method:"browser.controller.command",
                            params:{command_id, action:"browser_click",
                                    arguments:{ref:"@e3"}, controller_id,
                                    browser_profile_id, tool_call_id}}
                      ── ws ──▶ HOB Browser Controller
                          └─ executes against bot P's Chromium (Atrium/CDP)
                              returns the JSON string browser_click expects
                          ◀── ws ── {method:"browser.controller.result",
                                      params:{command_id, ok:true, result:{…}}}
                  └─ broker.complete(command_id) unblocks dispatch
      └─ tool result = controller's JSON string
```

**HARD REQUIREMENT that the controller implements the tool *semantics*, not just transport [V].**
The frame carries the *tool name* (`action`) and the *raw tool args* (`arguments`), e.g.
`browser_click{ref}`, `browser_snapshot{full}`, `browser_type{ref,text}`. Hermes does **not** translate
`@eN` refs. Therefore HOB's controller must itself produce accessibility snapshots with `@eN` refs and
resolve ref→element, and return results in the shape each `browser_*` tool expects. Atrium's worker
does **not** provide these. This is the largest hidden cost.

---

## 4. Atrium package / API map

**Provenance [V]** (`C:\Users\Abdullah\AppData\Local\Temp\opencode\atrium`, cloned `--depth 1`):
MIT license (`LICENSE`, `package.json:license`), pnpm workspace, `pnpm@9.15.0`, Node ≥20.
Packages (all `@atriumjs/*`, version **0.3.0**): `protocol`, `core`, `worker`, `express`, `react`,
`cli`, plus non-published `demo`. Deps of note: `playwright`, `playwright-extra`,
`puppeteer-extra-plugin-stealth`, `ws`, `zod`, `express`.

| Package | Key exports **[V]** | File |
|---|---|---|
| `@atriumjs/protocol` | `serverMessageSchema`, `clientMessageSchema`, `controlStateSchema`, `sessionStatusSchema`, `sessionBootstrapBodySchema`, `sessionSnapshotApplyBodySchema`, `clientCertificateSchema`, `parseServerMessage/parseClientMessage` | `packages/protocol/src/index.ts` (188 L) |
| `@atriumjs/core` | `createAtrium(config)→AtriumCore`, `viewerStreamMatch`, `handleNodeViewerUpgrade`, `MemorySessionStore` | `core/src/{create-atrium,dispatch,streaming,memory-session-store,worker-client,http-input,url-allowlist,types}.ts` |
| `@atriumjs/worker` | `startWorkerServer(options)` (HTTP + WS, port 7070) | `worker/src/index.ts` (~1424 L), `worker/src/run.ts`, `worker/src/stealth-chromium.ts` |
| `@atriumjs/express` | `atrium(config)→{router,handleViewerUpgrade}` | `express/src/middleware.ts` (120 L) |
| `@atriumjs/react` | `RemoteBrowser` (forwardRef), `resolveRemoteBrowserChrome`, types `RemoteBrowserProps/Handle/Tab` | `react/src/index.tsx` (~1406 L) |
| `@atriumjs/cli` | `index.ts` (51 L) | |

### 4.1 Wire protocol **[V]** (`protocol/src/index.ts`)

- Server→viewer JSON: `hello{sessionId,control,viewport}`, `frame{seq,ts,mime:"image/jpeg"}` **(binary
  frame carries the JPEG)**, `control{holder,reason?}`, `navigate{url}`, `title`, `favicon`,
  **`cursor{cursor:string}`**, `loading{loading,progress?}`, `viewport{w,h}`, `tabs[{id,url,title,active}]`,
  `webauthn_required`, `error`, `bye{reason}`, `clipboard`, `pong`.
- Viewer→server JSON: `input{kind:"mouse"|"key"|"wheel"|"clipboard", payload}`, `ime{text,isComposing}`,
  `resize`, `navigate`, `back`, `forward`, `reload`, **`request_control`**, **`release_control`**,
  `ping`, `tab_activate`, `tab_close`, `webauthn_decision`.
- **Cursor**: the protocol *defines* `cursor{cursor:string}` and the React viewer handles it
  (`react/index.tsx:306–308`, `setRemoteCursor`) — **but [V]** the worker grep found **no**
  `{t:"cursor"}` emitter (only the viewer consumer). → **[?]** confirm whether the worker emits a
  synchronized agent cursor; if not, HOB must synthesize it (see §7/§17).

### 4.2 Session / worker model **[V]**

- `createAtrium(config)` (`core/src/create-atrium.ts`) wires HTTP dispatch + viewer upgrade + a
  session-TTL janitor; hosts **must** call `dispose()`.
- `MemorySessionStore` (`core/src/memory-session-store.ts`) is **in-memory only** (Map). No
  persistence, no DB. `createSession(principal)` → `sessionId` (26 chars) + `viewerToken`
  (**TTL 5 min**) + `control:{holder:"agent"}`; `sessionTtlMs`/`idleTtlMs` policies; janitor every
  30 s; `peekReplay` keeps last 20 non-frame JSON messages for reconnect.
- `Principal = {tenantId, userId, scopes?}`; `maxConcurrentSessionsPerTenant` enforced on `POST /sessions`.
- Control plane endpoints (`core/src/dispatch.ts`): `GET /healthz|/readyz`, `POST /sessions`
  (optional worker bootstrap), `GET|DELETE /sessions/:id`, `POST /sessions/:id/control`
  (`{action:"grant"|"release", to:"human"|"agent"}`), `POST /sessions/:id/navigate`,
  `GET /sessions/:id/cookies|storage-state|session-snapshot`, `POST /sessions/:id/session-snapshot`.
  Auth = `authorize(input)` + tenant/user ownership (`authorizeOwnedSession`).
- Transports: exactly one of `ws|sse|poll` (first in `policies.transports`), because the worker has a
  single sink socket.

### 4.3 Worker internals **[V]** (`worker/src/index.ts`, `stealth-chromium.ts`, `run.ts`)

- Launch: `chromium.launch(stealthLaunchOptions(headless, viewport))` then `browser.newContext({
  ...desktopContextHints(viewport), storageState?|cookies?|clientCertificates? })`
  (lines **1349–1362**). **A brand-new Chromium process per session. No `launchPersistentContext`; no
  on-disk user-data-dir.** Persistence is only via injected `storageState`/`cookies` or session
  snapshots.
- Stealth by default (`playwright-extra` + stealth plugin) unless `ATRIUM_STEALTH=0`
  (`stealth-chromium.ts`).
- Screencast: CDP `Page.startScreencast`, adaptive quality/everyNthFrame
  (lines 594–656, 1132), `Page.screencastFrameAck` each frame.
- Input: viewer WS client messages parsed by `parseClientMessage` (line 1241) →
  `dispatchClientInput` (mouse/key/wheel/clipboard/ime/resize); navigate/tabs/back/forward/reload
  handled inline; `request_control|release_control` flips `control.holder` and broadcasts (lines
  1262–1272).
- Tabs: `broadcastTabsState` enumerates pages → `{t:"tabs",tabs}` (lines 660–670).
- Lifecycle: worker HTTP `POST /internal/session/:id/bootstrap`, `…/pending-bootstrap` (DELETE),
  `…/control`, `…/navigate`, `…/cookies`, `…/storage-state`, `…/apply-session`; `pendingBootstraps`
  Map (line 150). `wireDialSocket` reuses an existing session (`existing` branch, line 1317).
  Socket close → `scheduleIdleDestroy` (line 1285). `transportIdleMs` default in `run.ts` is **3 min**
  (line 16–18) — Chromium is reaped when no viewer is attached.
- Auth between core and worker: `Authorization: Bearer ${ATRIUM_WORKER_SECRET}`.
- Docker (`docker/worker/Dockerfile`): base `mcr.microsoft.com/playwright:v1.59.1-jammy`, installs
  `xvfb`, runs under `Xvfb :99` (`entrypoint.sh`), **headed by default** (`run.ts:8`), port 7070,
  `USER pwuser`.

### 4.4 React viewer **[V]** (`react/src/index.tsx`)

`RemoteBrowser` props (`RemoteBrowserProps`, lines 65–121): `sessionId`, `viewerToken`, `wsUrl`,
`interactive?`, `chrome?: "none"|"minimal"|"full"|{showTabStrip,showToolbar,showUrlBar}`,
`showSessionStatus?`, `webauthnNotice?`, `onControlChange?(holder)`, `onTerminated?`, `onError?`,
`onStatusChange?`, `style?`, `fullScreen?`, `onExitFullScreen?`, `connectingOverlay?`.
Handle (`RemoteBrowserHandle`): `reconnect, navigate, back, forward, reload, requestControl,
releaseControl`. It connects `new WebSocket(wsUrl + "?token=" + viewerToken)`, paints JPEG frames on a
canvas, tracks `holder/viewport/tabs/activeUrl/cursor/loading/favicon`, gates pointer/keyboard on
`interactive && holder === "human"`. **Restyling is supported without touching internals** via `chrome`
presets + `style` + `onControlChange` (answered Q11 below).

---

## 5. Verified integration points

| # | Boundary | Existing API | Reuse **[V]** |
|---|---|---|---|
| I1 | Hermes → controller (register) | `POST /v1/browser-control/register` + per-bot Bearer key from `HermesBotRegistry.token(name)` | direct |
| I2 | Hermes → controller (socket) | `GET /v1/browser-control/ws` + subprotocol ticket | direct |
| I3 | Hermes → controller (frames) | `browser.controller.command`.`.result`.`.heartbeat`.`.cancel`.`.detach` | direct |
| I4 | Hermes identity | `_derive_browser_control_principal`, `transport_family=local-api` | server-side, nothing to build |
| I5 | HOB → Hermes HTTP | `HermesClient.runtime/dashboard` (per-profile key) | direct |
| I6 | HOB → Hermes native chat | `HermesSessionBridge.rpc(profile, method)` | direct |
| I7 | HOB bot identity | `HermesBotRegistry.token/list` + `bots.json` | direct |
| I8 | HOB viewer auth | cookie gate in `app.mjs` + `X-Hob-Profile` | direct |
| I9 | Atrium control plane | `createAtrium` handlers | reuse |
| I10 | Atrium viewer | `RemoteBrowser` (`@atriumjs/react`) | reuse |
| I11 | Atrium worker | `startWorkerServer`, internal REST | reuse for process/stream/input/takeover |
| I12 | HOB persistence | `HermesBotRegistry` JSON pattern | reuse pattern |

---

## 6. Required adapters and their responsibilities

### A1 — `BrowserRegistry` (persistent per-bot browser metadata)
- **Exists:** nothing. **Build:** new module mirroring `HermesBotRegistry` (same atomic-write,
  0600, single-writer, `HOB_STATE_DIR` conventions).
- **Responsibilities:** assign `browserProfileId` (stable, opaque) per bot on first use; store
  `{bot, browserProfileId, profileDir, state, createdAt, lastActiveAt, controlLease}`; survive restart;
  no secrets.
- **Why not SQLite:** HOB has no SQLite **[V]**; Hermes owns per-profile `state.db` and must remain
  unmodified. Keep HOB metadata in JSON next to `bots.json`.

### A2 — `BrowserManager` (lifecycle + leases)
- **Responsibilities:** lazy start (no Chromium until first agent action or viewer), per-bot single
  Chromium (advisory lock on `profileDir`), idle shutdown, restart reconciliation, control lease
  (agent|human|idle), spawn/stop the Atrium worker session or a per-bot Atrium worker, expose state.
- **Reuses:** the `deploy/start.mjs::supervise` child-supervision idiom for the worker process; the
  Atrium worker internal REST for session bootstrap/control/destroy.

### A3 — `BrowserController` (Hermes wire ⇄ Chromium)
- **Responsibilities:** register (I1) with `controller_id` (per HOB boot) + `browser_profile_id`
  (A1) + `session_id` (the Hermes session) + requested capabilities; attach (I2); answer
  `browser.controller.command` by (a) translating the action+args into CDP/Playwright operations
  against the bot's Chromium and (b) returning the tool-shaped result; heartbeat; handle
  cancel/timeout; re-register on reconnect.
- **Must implement tool semantics:** `browser_snapshot` (AX tree → numbered `@eN` refs + text),
  `browser_click{ref}`, `browser_type{ref,text}`, `browser_press{key}`, `browser_scroll{direction}`,
  `browser_navigate{url}`, `browser_back`, `browser_tabs`, `browser_tab_activate{tabId}`,
  `browser_screenshot`. This is the hard part; see §7 Q7/Q13.

### A4 — HOB browser REST/WS routes
- **Responsibilities:** `POST /api/browser/:bot/start|stop`, `GET /api/browser/:bot`, viewer-session
  issuance (wrap Atrium `viewerToken`), control grant/release, frame stream relay (WS or SSE).
- **Insertion:** add to the `server/app.mjs` route table **after** the `if (hermes) return 409`
  guard's *predecessors* so it is reachable on Hermes — i.e. wire it like `hermesChat`/
  `canonicalChat` (an early, capability-checked handler), **not** like the legacy OpenClaw routes.

### A5 — React viewer
- **Build/reuse:** a `BrowserViewer` wrapper around `@atriumjs/react` `RemoteBrowser`, mounted in
  `RightPanel.tsx` (`activeTab==='browser'`, line 783) replacing `HermesBrowser`'s stub, styled with
  `chrome` presets + `style` to match HOB's theme, using HOB's cookie auth for the WS (upgrade must
  be authenticated).

---

## 7. Recommended files to create / existing files to modify

**Create (HOB):**
- `server/browser-registry.mjs` — A1.
- `server/browser-manager.mjs` — A2.
- `server/browser-controller.mjs` — A3.
- `server/browser-routes.mjs` — A4 (HTTP + WS upgrade).
- `web/src/components/BrowserViewer.tsx` — A5 (thin wrapper on `RemoteBrowser`).
- `server/test/browser-{registry,manager,controller,routes}.test.mjs` — mirror existing test style.
- Possibly `deploy/browser-worker.mjs` or a config stanza if the Atrium worker is a 4th supervised child.

**Existing files likely to modify (minimal, additive):**
- `server/index.mjs` — construct A1–A3 and pass into `createApp`.
- `server/app.mjs` — add the A4 route hook + WS upgrade; leave `234` guard and legacy routes untouched.
- `web/src/components/RightPanel.tsx` — swap `HermesBrowser` for `BrowserViewer` at `:783`.
- `web/src/pages/HermesWorkspace.tsx` — replace/retire the `HermesBrowser` stub (`:157`).
- `deploy/bootstrap-hermes.mjs` — optionally add the Atrium worker child + env (`ATRIUM_*`).
- `deploy/seed-hermes-config.mjs` — add `browser.extension_control.enabled: true` to the **Main**
  default config, and per-bot on `finishSetup` via `hermes-bots.mjs` `PUT /api/config`.
- `Dockerfile` — only if the Atrium worker is co-located (add Playwright/Chromium/Xvfb or reuse the
  in-image Chromium); otherwise `compose.yaml`/`compose.standalone.yaml` get a new service.
- `web/package.json` — add `@atriumjs/react` (+ `@atriumjs/protocol`).
- `README.md` / `web/API_INTEGRATION.md` — document the new surface.

**Do NOT touch:** anything under `hermes-agent/` (reference only), the Hermes image, or the legacy
OpenClaw browser routes.

---

## 8. Suggested "SQLite schema changes"

**Correction to the PRD [V]:** HOB has **no** database and no migrations. Hermes owns all
persistence (per-profile `state.db`, SQLite). The correct analogue is a JSON sidecar owned by the new
`BrowserRegistry`, using the exact `HermesBotRegistry` conventions (`server/hermes-bots.mjs`).

`<HOB_STATE_DIR>/browsers.json` (mode 0600, atomic tmp+rename, single writer, `version:1`):
```jsonc
{
  "version": 1,
  "browsers": [
    {
      "bot": "default",                 // Hermes profile id (FK to bots.json)
      "browserProfileId": "br-<16hex>", // stable id sent as browser_profile_id
      "profileDir": "/opt/data/.hob/browsers/default/chromium",
      "state": "idle",                  // idle|starting|active|takeover|stopping|failed
      "controllerId": "hob-<uuid>",     // current HOB controller generation (restart ⇒ new)
      "controlHolder": "agent",         // agent|human|idle
      "controlSince": "2026-…Z",
      "sessionId": null,                // Hermes session currently bound, if any
      "createdAt": "…", "lastActiveAt": "…"
    }
  ]
}
```
Recovery after restart: any `state` ≠ `idle` is reset (Chromium died with the process); `controlHolder`
→ `agent`; `controllerId` regenerated; the registry is reconciled against live child PIDs and the
Atrium worker's session list.

---

## 9. WebSocket and event protocol mapping

| Concern | Hermes side | Atrium side | HOB adapter duty |
|---|---|---|---|
| Controller control | WS `/v1/browser-control/ws`, `browser.controller.*` | — | A3 speaks it |
| Agent actions | `browser.controller.command{action,arguments,…}` | internal REST / CDP | translate + return tool JSON |
| Screencast | — | viewer WS binary JPEG (`frame`) + `t:"frame"` meta | relay to browser; gate on viewer present |
| Cursor | — | `t:"cursor"{cursor}` (protocol/viewer; worker emission **[?]**) | synthesize `cursor` from agent action coords if absent |
| Tabs/nav | `browser_tabs`, `browser_tab_activate`, `browser_navigate` | `t:"tabs"`, `navigate` | map both ways |
| Input | — | `input{kind,payload}`, `ime`, `resize` | forward only when `holder==="human"` |
| Takeover | — | `request_control`/`release_control`, `POST /sessions/:id/control` | A2/A4 own the lease; A3 rejects agent cmds while human holds |
| HOB live events | existing SSE `/api/events` (`gateway{…}`) | — | optionally push browser lifecycle over SSE |

**Collision note [V]:** HOB currently has **no** WS server. The natural reuse is Atrium's own viewer
WS path (`/atrium/sessions/:id/stream`) mounted on HOB's `node:http` server via
`express`-less wiring — Atrium core exposes `handleNodeViewerUpgrade(req,socket,head)` for exactly
this (`core/src/create-atrium.ts`, `express/src/middleware.ts:124`). Authenticate the upgrade with the
HOB cookie **before** delegating to that handler.

---

## 10. Browser lifecycle state machine

```
        ┌──────────────────────── restart / reconcile ────────────────────────┐
        ▼                                                                     │
   [idle] ──agent action or "watch" click──▶ [starting] ──chromium ready──▶ [active]
     ▲                                          │  fail                        │  ▲
     │                                          ▼                              │  │
   [stopping] ◀── idle timeout / stop ─────────┴──────── [failed] ──retry──▶ [starting]
     │                                                                       
     └── human clicks "Take control" ──▶ [takeover] ──"Return control"──▶ [active]
```
Rules **[A]**: lazy start ONLY on an agent `browser_*` action or an explicit viewer open (never on bot
creation) — satisfies "assign identity without launching Chromium" (Workflow A). Idle → `stopping`
after `idleTtlMs` with no viewer **and** no in-flight command. During `takeover`, A3 returns
`{ok:false,error:{code:"human_control"}}` for agent commands (never silently acts); on return, agent
resumes against the live page (state is preserved because the Chromium was never torn down).

---

## 11. Human takeover sequence

```
User            HOB (A2/A4)                    Atrium core/worker          Hermes A3/agent
 │  "Take control"│                                 │                          │
 ├───────────────▶│ POST /api/browser/:bot/control  │                          │
 │                │  {grant, human}                 │                          │
 │                ├──── POST /sessions/:id/control─▶│ holder=human             │
 │                │                                 ├─ broadcast control ─────▶ (viewer)
 │                │ set controlHolder=human          │                         │
 │                │                                 │        browser_click ────▶ A3
 │                │                                 │◀─── {ok:false,error:human_control}
 │  type/click ──▶│ (viewer WS input enabled) ──────▶ worker injects input     │
 │  "Return" ────▶│ {release} → holder=agent ───────▶ │                        │
```
**[?]** `assert_agent_may_act` semantics (Hermes `bot_desktop/lease.py:238`) exist only for Hermes's
own Bot Desktop; the extension-control broker has **no** pause concept, so HOB's A3 is the sole gate.
Decide: reject-with-error (simplest, agent sees failure) vs hold-until-release-with-deadline (better
UX, more code). Recommend reject-with-error first.

---

## 12. Persistent storage and Docker topology

- **Single container, single volume [V]:** `Dockerfile` CMD `deploy/start.mjs`;
  `compose.yaml` mounts `hermes-data:/opt/data`; env `HERMES_HOME=/opt/data`,
  `HOB_STATE_DIR=/opt/data/.hob`, `shm_size: 1gb`, uid drop to 10000.
- **Where per-bot browser profiles should live [A]:** `HOB_STATE_DIR/browsers/<bot>/chromium`
  (`/opt/data/.hob/browsers/<bot>/chromium`). **Do NOT** reuse Hermes's `AGENT_BROWSER_PROFILE` or
  Bot Desktop `profile_dir()` — a Chromium `user-data-dir` can only be locked by one process
  (avoids Workflow-G/H lock conflicts).
- **Atrium worker placement — two options:**
  - **(A) Co-located 4th child** in `deploy/start.mjs` processes. Needs Chromium + Xvfb available in
    the Hermes runtime image; the image already ships a Chromium for agent-browser
    (`PLAYWRIGHT_BROWSERS_PATH=/opt/hermes/tools`, `deploy/probe-browser.mjs`), so point Atrium at it
    (`ATRIUM_WORKER_HEADLESS=1`, and/or a Playwright `executablePath`). Cheapest, no new infra.
  - **(B) Separate compose service** using `docker/worker/Dockerfile` (Playwright jammy + Xvfb).
    Cleaner isolation, but adds an image/service and a second Chromium stack (disk/RAM).
  - **Recommend (A)** per the PRD's "no unnecessary new infrastructure", and reuse the in-image
    Chromium to avoid a second copy.
- **Persistence caveat:** Atrium's store is in-memory and its contexts are ephemeral. "Logins survive
  restart" therefore CANNOT come from Atrium as-is; it must come from either (i) an on-disk
  `user-data-dir` (a worker patch / `launchPersistentContext`) or (ii) HOB persisting
  `storageState`/cookies per bot and re-bootstrapping each session (`session-snapshot`). See Q5/Q12.

---

## 13. Security and authorization boundaries

- **Browser-control registration is safe by construction [V]:** identity is a digest of
  `profile + expected API key`; a client-supplied `principal_id` is ignored; `transport_family` is
  derived from the peer address (`local-api` for loopback); the session must exist in the profile's
  SessionDB; capabilities are filtered to an allowlist; developer capabilities need Developer Mode.
- **HOB-side:** the controller must use **that bot's** `registry.token(bot)` (never the Main key) so
  the principal matches the run's principal. HOB's `HermesClient` already does per-profile key
  resolution (`profileAccess`).
- **Viewer auth:** HOB cookie gates the app; the WS upgrade must validate the cookie + `X-Hob-Profile`
  before handing to Atrium. Atrium's own `authorize(input)` must be implemented to check the HOB
  session and map `tenantId=bot`, `userId=operator`.
- **No per-user bot ACL [V]:** if takeover should be restricted, HOB must define it; do not assume
  Hermes enforces it.
- **Artifacts:** only server-minted ids travel; bytes under a controlled per-profile root; TTL 300 s.
- **Do not proxy raw CDP/eval to viewers.** Keep `developer_mode` off unless a concrete need exists;
  the PRD's "no full desktop/VNC" constraint aligns with the non-developer allowlist.

---

## 14. Performance considerations

- **RAM:** Atrium = one Chromium per session. Per-bot persistent profiles mean up to N Chromiums on a
  VPS. Enforce `maxConcurrentSessionsPerTenant` and a HOB-side cap (e.g. 2–4 live browsers), idle
  shutdown, and `ATRIUM_TRANSPORT_IDLE_MS`.
- **CPU:** headless (`ATRIUM_WORKER_HEADLESS=1`) avoids Xvfb cost; screencast adaptive quality already
  reduces load (`worker/index.ts:630–641`). Consider `everyNthFrame` > 1 for background viewers.
- **Glass-to-glass:** keep the controller (HOB) and worker on loopback; stream JPEG at a modest
  viewport; only stream to a present viewer (Atrium already destroys Chromium when no viewer attaches,
  `transportIdleMs` — good default, but see Workflow G: HOB may want to KEEP the browser alive for
  agent actions with no viewer, so `ATRIUM_TRANSPORT_IDLE_MS` must be raised and HOB must own idle).
- **Startup:** lazy launch keeps steady-state RAM near zero for unused bots.

---

## 15. Confirmed compatibility issues

1. **Transport/identity binding for native sessions [V]/[?] — BLOCKER.** `HERMES_BROWSER_CONTROL_*`
   is stamped only by the **api_server** request middleware (`api_server.py:1632`). HOB submits turns
   through the **native session authority** (`hermes-canonical-chat.mjs` → `prompt.submit`). Unless a
   native path also stamps these (via `gateway/session_api_turn.py` / `methods_browser_control.py`),
   `routed_browser_handler` will never see the identity and will fall back to Hermes's local browser.
   **Must verify before any code is written.**
2. **`session_id` existence requirement [V].** Register requires the session in the api_server's
   SessionDB (`db.get_session`, `api_server.py:2541`). **[?]** Are native session ids present there?
3. **Tool-semantics gap [V].** The controller must implement snapshot/`@eN` refs/click-by-ref; neither
   Hermes nor Atrium provides this to HOB. Largest hidden cost.
4. **Atrium has no persistent context [V].** `chromium.launch` + `newContext`, not
   `launchPersistentContext`; in-memory store; no restart survival. Conflicts with "logins survive."
5. **Atrium cursor emission [V]/[?].** Protocol + viewer support `cursor`; worker emission unconfirmed.
6. **No WS server in HOB [V].** New upgrade path; must not collide with SSE `/api/events`.
7. **Docker filesystem/volume [V].** Single volume; adding Atrium means image/service changes; avoid a
   second Chromium copy (reuse in-image Chromium).
8. **Headless vs headed [V].** Atrium defaults headed (needs Xvfb/`DISPLAY`); HOB's runtime user is
   unprivileged with `cap_drop: ALL` + a chromium sandbox seccomp profile (`deploy/chromium-seccomp.json`).
   Confirm the sandbox flags/`--no-sandbox` precedent (`browser_tool_session.py::_apply_chromium_sandbox_args`).
9. **Profile locking [A].** Two Chromiums on one `user-data-dir` deadlock; HOB must own distinct dirs.
10. **Duplicate-browser conflict [V] resolved by design.** With `extension_control.enabled` and a bound
    controller, Hermes's local/cloud browser is bypassed (fail-closed) → single browser. But if the
    feature is enabled **without** a registered controller for a session, the lane fails closed too —
    so enabling it globally without HOB's controller running would break browsing. Enable it **only
    when HOB's controller is ready** for that bot, or rely on the `lane_registered` fallback
    (`browser_extension_router.py:87–89`) which keeps legacy for unregistered lanes **[V]**.
11. **Two session id vocabularies [V].** HOB wraps native ids (`hermesNativeSessionKey`); the
    api_server uses its own ids. Bridging them is required for register/`session_id` consistency.
12. **PRD DB assumption wrong [V].** "Existing SQLite" does not exist in HOB; use JSON sidecar (§8).

---

## 16. Unresolved questions and assumptions

- **Q1 (blocker):** Does a run submitted through the native session authority carry
  `HERMES_BROWSER_CONTROL_PRINCIPAL`/`..._TRANSPORT_FAMILY`? If not, HOB must route browser-using
  turns via the api_server (`/api/sessions/{id}/chat/stream` or `/v1/runs`) — verify with a live
  probe (start Hermes, enable the flag, register a controller, submit a turn both ways, observe
  whether `browser.controller.command` arrives).
- **Q2:** Do native session ids appear in the api_server SessionDB (`db.get_session`)? If not, register
  must use an api_server-created session.
- **Q3:** Does the dashboard RPC transport (`methods_browser_control.py`) bind identity for native
  sessions, making it the better lane for HOB?
- **Q4:** Where exactly are per-profile Hermes homes (`get_hermes_home()` / `get_profile_dir`) under
  `/opt/data`? (Confirm before choosing `browser_profile_id`/profile dir paths.)
- **Q5:** Will HOB accept a **minimal Atrium worker patch** (persistent context + a command endpoint)
  or must everything stay unpatched? (Determines the whole build strategy.)
- **Q6:** Does the Atrium worker emit `{t:"cursor"}`? If not, does HOB synthesize synchronized cursors?
- **Q7:** Exact result JSON shapes each `browser_*` tool expects (read `tools/browser_tool.py` handlers
  and `browser_tool_snapshot.py`) so the controller's results are accepted.
- **Q8:** Exact Chromium binary/args available in the Hermes runtime image for Atrium to reuse
  (`deploy/probe-browser.mjs` shows how to find it).
- **Q9:** Does enabling `browser.extension_control.enabled` in Main's seeded config apply to all
  profiles, or must it be set per profile (multiplex scope rules)?
- **Q10:** Approval interaction: are `browser_*` tool calls subject to Hermes approval, and how does
  that surface in HOB? (Read `tools/approval*.py`.)

---

## 17. Design — minimum-change integration (recommended)

**Architecture (all in HOB; Hermes unmodified):**
```
HOB React (BrowserViewer) ── cookie-auth WS ──▶ HOB Atrium mount (core) ──▶ Atrium worker ──▶ Chromium(bot)
        ▲                                                            ▲
        │ cursor/frame/tabs/control                                  │ internal REST/CDP
HOB A4 routes ── A2 BrowserManager (lease, lifecycle, registry) ── A3 BrowserController
                                                                      │ register + WS
                                                                      ▼
                                              Hermes api_server /v1/browser-control/*  (per-bot key)
                                                                      │ routes browser_* tools
                                                                      ▼
                                                                    agent turn
```

**Priorities mapping:** minimal HOB edits (A4 hook + one component swap + index wiring) [1]; zero
Hermes source changes (config opt-in only) [2]; maximum Atrium reuse for viewer/input/takeover/
screencast [3]; low RAM via lazy start + headless + idle stop [5]; persistence via HOB-owned
`user-data-dir` [6]; smooth viewing via loopback JPEG screencast [7]; safe handoff via the A2 lease +
A3 reject-on-human [8]; per-bot ownership via `browser_profile_id` + per-bot key [9]; no new
infra (co-locate the worker) [10].

**The one Atrium gap and its smallest fix.** Atrium's worker creates a fresh context per session and
offers no command API. The smallest change that preserves the PRD's constraints is to **fork only
`packages/worker`** to (a) accept a `userDataDir` and use `chromium.launchPersistentContext` for
bots that need durable logins, and (b) expose one authenticated internal endpoint
`POST /internal/session/:id/command` that runs a Hermes `browser_*` action via CDP and returns the
tool JSON. Reuse `@atriumjs/core`, `protocol`, `react`, `express` unmodified. If a fork is forbidden,
the fallback is: keep Atrium's worker **only** for the browser process + screencast + input, and have
A3 open a **second CDP connection** to the same Chromium (like `browser_tool_real_profile.py` does) to
implement the tool semantics — no Atrium change at all.

**Estimated complexity:** **Large.** New HOB subsystem ≈ 1.5–3k LOC (registry ~200, manager ~400,
controller ~500–900 incl. AX-snapshot/ref logic, routes ~250, viewer ~150, tests ~600) plus an Atrium
worker patch (~150–300 LOC) if chosen, plus Docker/compose changes. Highest risk: Q1/Q2/Q3 identity
binding, and the AX-snapshot/ref tool semantics (Q7).

---

## 18. Exact implementation order

1. **Verify Q1–Q3** with a live read-only probe against the running runtime: `GET /v1/capabilities`,
   enable the flag, `POST /v1/browser-control/register` for a known session, attach the WS, submit a
   turn both through `prompt.submit` and `/v1/runs`, and record whether a
   `browser.controller.command` frame arrives. This decides the chat-transport strategy.
2. Decide the Atrium strategy: **fork worker** (Q5) vs **CDP sidecar**.
3. Implement `BrowserRegistry` (A1) + tests.
4. Implement `BrowserManager` (A2) with lazy start/idle/lease + tests.
5. Implement `BrowserController` (A3): register/attach/frames/heartbeat/reconnect + tool semantics +
   tests (with a fake Hermes broker).
6. Implement `browser-routes.mjs` (A4) + WS upgrade, wired into `app.mjs` and `index.mjs` + tests.
7. Build `BrowserViewer.tsx` on `@atriumjs/react` `RemoteBrowser`; swap into `RightPanel.tsx:783`;
   retire the `HermesBrowser` stub.
8. Wire the Hermes flag: Main seed config + per-bot `PUT /api/config` on `finishSetup`.
9. Docker/compose + `deploy/bootstrap-hermes.mjs` worker child; verify Chromium reuse.
10. End-to-end Workflows A–H against a real container smoke (extend `deploy/smoke-*.mjs`).

---

## 19. Relevant test files and commands

- HOB server tests: `node --test server/test/*.test.mjs` (`server/package.json:7`). Notably
  `app.test.mjs`, `hermes-routes.test.mjs`, `hermes-bots.test.mjs`, `hermes-canonical-chat.test.mjs`,
  `hermes-recovery.test.mjs`.
- HOB deploy tests/scripts: `node --test deploy/*.test.mjs` (`start.test.mjs`,
  `hermes-session-bootstrap.test.mjs`, `smoke-mcp.test.mjs`, `smoke-model.test.mjs`,
  `prepare-hermes-runtime.test.mjs`); container probes `deploy/smoke-container.mjs`,
  `deploy/probe-browser.mjs`, `deploy/smoke-web.mjs`, `deploy/hermes-smoke-api.mjs`.
- Web: `npm run build` / `npm run lint` in `web/` (no test script).
- Hermes-side references to keep behavior aligned (read-only): `tests/tools/test_browser_extension_router.py`,
  `tests/gateway/test_browser_control_api.py`, `tests/gateway/test_browser_control_broker_hardening.py`,
  `tests/gateway/test_browser_control_artifacts.py` — these document the exact contract HOB must satisfy.
- Atrium: `packages/core/src/dispatch.test.ts`, `streaming.test.ts`,
  `memory-session-store.test.ts`, `url-allowlist.test.ts`; `packages/react/src/RemoteBrowser.test.tsx`;
  `packages/worker/src/index.test.ts`; `packages/express/src/middleware.test.ts`.

---

## 20. Source references for every important claim

**HOB (current tree):**
- `Dockerfile:16` (Hermes digest pin), `:44–45` (seed config init), `:51` (`HOB_STATE_DIR`), `:57` (CMD).
- `compose.yaml` (`hermes-data:/opt/data`, `shm_size`, `cap_drop ALL`).
- `.github/workflows/hermes-runtime-image.yml:34` (`HERMES_COMMIT: 7e9eb8d9…`).
- `deploy/bootstrap-hermes.mjs:40–85` (three processes, env).
- `deploy/start.mjs:7–81` (`supervise`).
- `server/index.mjs:1–28` (composition).
- `server/app.mjs:15–19` (HttpError/PROFILE_FILES/MEDIA), `:200–234` (auth + route fan-out + `409`
  hermes guard), `:356–367` (legacy browser routes), `:231–232` (canonical/chat handlers).
- `server/hermes-client.mjs:21–62` (profile/resource/session-key helpers), `:90–179` (client core),
  `:230–262` (startup/profile status).
- `server/hermes-bots.mjs:13–104` (registry), `:106–164` (bots lifecycle), `:150–155`
  (`API_SERVER_KEY` per bot).
- `server/hermes-session.mjs:8–15` (`SESSION_METHODS`), `:16+` (`rpc`).
- `server/hermes-canonical-chat.mjs:96–117` (sessions), `:129–145` (create), `:233–313` (turns/SSE).
- `web/src/services/api.ts:12–43` (cookie + `X-Hob-Profile`), `:55–68` (turn stream).
- `web/src/components/RightPanel.tsx:40–214` (`OpenClawBrowserPanel`), `:459–463` (`BrowserPanel`),
  `:783–784` (mount).
- `web/src/pages/HermesWorkspace.tsx:157–182` (`HermesBrowser` stub).
- `web/API_INTEGRATION.md:30` (legacy browser endpoints), `:36–40` (SSE contract).

**Hermes (pinned upstream `7e9eb8d9…`, reference tree `hermes-agent/`):**
- `gateway/platforms/api_server.py:48–51` (contextvars), `:64` (protocol v1), `:100–105` (endpoints +
  WS protocol constants), `:1632–1640` (set contextvars), `:1655–1658` (routes), `:1837–1906`
  (SessionDB), `:2453–2497` (capabilities), `:2501–2578` (register), `:2580–2633` (ws), `:2635–2697`
  (frames + principal + transport family + developer mode), `:2699–2732` (artifact store),
  `:4064–4080` (`_bind_api_server_session`).
- `gateway/browser_control_broker.py:19–24` (defaults), `:41–42` (`FRAME_COMMAND/CANCEL`), `:50–79`
  (flag/developer/capability filters), `:150–349` (broker core: mint/consume/attach/select/dispatch),
  `:510` (`get_browser_control_broker`).
- `gateway/browser_control_artifacts.py:1–28` (TTL/size/MIME), rest (ArtifactStore).
- `gateway/session_context.py:34–44` (`_SESSION_VARS` incl. browser-control).
- `gateway/session_api_turn.py:75–129` (`_valid_browser_control`, `_request_browser_control`).
- `tools/browser_extension_router.py:29–137` (identity, availability, route).
- `tools/browser_tool.py:1–150` (backend overview), `:1315–1349` (registry + routed table).
- `tools/browser_tool_session.py:273–301` (local/real-profile session), `:661` (`AGENT_BROWSER_PROFILE`),
  `:694` (sandbox profile dir), `:849–883` (Bot Desktop CDP port / headed args).
- `tools/bot_desktop/browser.py:27` (`profile_dir`), `:118` (`running_instance_cdp_port`),
  `:170–178` (`env_for_agent`); `tools/bot_desktop/lease.py:56–249` (human-control lease).
- `agent/browser_provider.py:1–57` + `agent/browser_registry.py:1–61` (cloud provider ABC/registry).
- `hermes_cli/config_defaults.py:470–495` (`browser.*`, `extension_control`).
- `tui_gateway/methods_browser_control.py:1–218` (dashboard/RPC registration lane).
- `website/docs/user-guide/features/api-server.md:294–381` (browser-extension control contract).
- `hermes-agent/AGENTS.md`, `gateway/AGENTS.md`, `tools/AGENTS.md`, `agent/AGENTS.md`,
  `hermes_cli/AGENTS.md` (architecture + profile-scope invariants).

**Atrium v0.3.0 (temp clone):**
- `package.json` (MIT), `packages/*/package.json` (versions/exports).
- `packages/protocol/src/index.ts:3–188` (schemas; `cursor` at 44; `input`/`request_control` at
  94–120).
- `packages/core/src/{create-atrium.ts (1–117), dispatch.ts (1–417), streaming.ts (1–411),
  memory-session-store.ts (1–236), types.ts (1–82), worker-client.ts (1–39)}`.
- `packages/worker/src/index.ts:118` (transport idle), `:150` (`pendingBootstraps`),
  `:594–670` (screencast/tabs), `:1240–1287` (client messages/control), `:1307–1424` (session build,
  `chromium.launch` at 1349, `newContext` at 1355/1360); `run.ts:4–27` (env/headless/idle);
  `stealth-chromium.ts:1–103`.
- `packages/react/src/index.tsx:14–138` (props/handle/chrome presets), `:172–319` (connect, frame/
  control/tabs/cursor handling).
- `packages/express/src/middleware.ts:37–126` (`atrium()`, mount, SSE streaming, upgrade).
- `docker/worker/Dockerfile:1–25`, `docker/worker/entrypoint.sh:1–8` (Xvfb, headed).

---

## Appendix — Part 9 summary (as requested)

- **Repositories inspected:** 3 (HOB, official Hermes, Atrium).
- **Relevant source files inspected:** ~45 (HOB server/deploy/web; Hermes gateway/tools/agent/config/
  docs; Atrium protocol/core/worker/react/express/docker) — see §20.
- **Is Atrium suitable for HOB?** **Partially.** Strong fit for screencast viewer, input relay,
  tabs, control-holder takeover, and the Playwright worker process. **Not** suitable as-is for
  per-bot persistent profiles, lazy agent-driven launch, restart survival, or Hermes's
  snapshot/`@eN`-ref tool semantics. Requires either a **minimal `packages/worker` fork** or a
  **CDP sidecar**; the other packages can be reused unmodified.
- **Best Hermes extension mechanism:** the built-in **browser-extension control** over the runtime
  api_server (`POST /v1/browser-control/register` + `GET /v1/browser-control/ws`), gated by
  `browser.extension_control.enabled=true`. Zero Hermes source changes; versioned wire; fail-closed
  per-session identity; result-is-authoritative. Alternative lane: the dashboard RPC
  (`browser.controller.register`) — verify which binds identity for HOB's native chat transport.
- **Estimated implementation complexity:** **Large** — new HOB subsystem (~1.5–3k LOC) + optional
  Atrium worker patch (~150–300 LOC) + Docker/compose; serviceable in phases.
- **Major integration risks:** (1) whether the native session transport stamps
  `HERMES_BROWSER_CONTROL_*` (blocker); (2) api_server `session_id` existence vs native ids;
  (3) implementing accessibility-snapshot/`@eN`-ref tool semantics in HOB; (4) Atrium's lack of
  persistent context vs the "logins survive" requirement; (5) enabling the flag globally without a
  live controller (mitigated by the `lane_registered` legacy fallback).
- **Exact path to the handoff document:**
  `D:\code\github-projects\Mused - OpenMuse\BROWSER_INTEGRATION_CONTEXT.md`
  (repo-relative: `BROWSER_INTEGRATION_CONTEXT.md`).

*No implementation performed. No existing source modified.*
