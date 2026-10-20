# HOB Browser Subsystem Integration Context & Technical Reconnaissance

> **Document Type:** Technical Reconnaissance & Architecture Specification  
> **Target Audience:** Implementation Coding Agent / Senior Systems Engineers  
> **Target Artifact:** `BROWSER_INTEGRATION_CONTEXT.md`  
> **Status:** READ-ONLY RECONNAISSANCE COMPLETED — READY FOR IMPLEMENTATION

---

## 1. Executive Architecture Summary

HOB (Home of Bots) is a multi-agent orchestration platform designed to run 24/7 autonomous agents powered by Nous Research's **Hermes Agent**. The goal of this integration is to provide HOB with a native, persistent, multi-tenant browser subsystem based on **Atrium** (`@atriumjs/*`), featuring:

1. **One Persistent Browser Profile per Bot:** Cookies, local storage, indexedDB, and authentication sessions are permanently retained per bot identity under durable container volumes (`/opt/data/browser_profiles/<bot_id>`).
2. **Lazy Chromium Startup:** Chromium is never launched at bot creation or container boot. A headless Chromium process starts on demand when either (a) Hermes requests a browser action (`browser_navigate`, `browser_click`, etc.) or (b) the operator opens the browser panel in the HOB web interface.
3. **Real-Time Screencasting & Sub-Second Latency:** Frame capture driven via Chrome DevTools Protocol (`Page.startScreencast`, JPEG format, dynamic quality/frame-rate auto-tuning), streamed over WebSocket to the `@atriumjs/react` canvas viewer.
4. **Synchronized Cursor & Element Inspection:** Agent clicks, typing, and viewport navigation are mirrored live in the viewer with visual agent indicator overlays.
5. **Bidirectional Human Takeover:** The user can request control from the viewer at any moment. While in human control, agent tool requests pause or yield safely, and DOM pointer/keyboard inputs pass directly to Chromium through Playwright. When control is returned to the agent, Hermes resumes using the updated DOM state.
6. **Zero Upstream Modifications to Hermes:** Official Hermes runtime code remains 100% stock and unmodified. Integration utilizes Hermes's built-in `browser.extension_control` wire protocol over its authenticated Gateway WebSocket (`/api/ws`).

```
+---------------------------------------------------------------------------------------------------------+
|                                              HOB HOST CONTAINER                                          |
|                                                                                                         |
|  +--------------------+         HTTP / SSE / WS Upgrade        +-------------------------------------+  |
|  |     HOB Web UI     | <====================================> |           HOB Node Server           |  |
|  |   (React 19/Vite)  |         Port 3000 (app.mjs)            |            (Node.js 24)             |  |
|  |                    |                                        |                                     |  |
|  |  +---------------+ |   WebSocket: /api/browser/stream/:bot  |  +-------------------------------+  |  |
|  |  | Atrium Viewer | | <------------------------------------> |  |   Browser Manager & Broker    |  |  |
|  |  | (Canvas/JPEG) | |     { t: "frame", seq, mime, data }    |  |     (server/browser-manager)  |  |  |
|  |  +---------------+ |     { t: "input", mouse/key/wheel }    |  +---------------+---------------+  |  |
|  +--------------------+                                                           |                  |  |
|                                                                                   |                  |  |
|                                       JSON-RPC 2.0 (WebSocket /api/ws)           | Playwright CDP   |  |
|                                       "browser.controller.command" / "result"     | / Persistent     |  |
|                                                                                   | Context          |  |
|                                                                                   v                  v  |
|  +-------------------------------------------------------------+     +-------------------------------+  |
|  |                    Hermes Agent Runtime                     |     |       Chromium Instance       |  |
|  |           (Official Unmodified hermes gateway run)          |     |    (--headless=new / CDP)     |  |
|  |                                                             |     |                               |  |
|  |  - Tools: browser_navigate, browser_click, browser_snapshot |     | Profile:                      |  |
|  |  - Router: tools/browser_extension_router.py                |     | /opt/data/browser_profiles/   |  |
|  |  - Broker: gateway/browser_control_broker.py                |     |   <bot_id>/                   |  |
|  +-------------------------------------------------------------+     +-------------------------------+  |
+---------------------------------------------------------------------------------------------------------+
```

---

## 2. HOB Source-Code Map

### 2.1 Technology Stack & Build Architecture
- **Backend Framework:** Plain Node.js standard library HTTP server (`node:http`, `node:crypto`, `node:fs/promises`, `node:stream`). **Express is not used.**
- **Node Engine:** `>=24.16.0 <25 || >=26.1.0` (Pinned in [`server/package.json`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/server/package.json#L6)).
- **Frontend Framework:** React 19 (`react` 19.2.8, `react-dom` 19.2.8, `react-router-dom` 7.18.4) with TypeScript 6 (`typescript` ~6.0.2).
- **Styling & CSS:** TailwindCSS 4 (`@tailwindcss/vite` ^4.3.3) with Lucide icons (`lucide-react` ^1.52.0).
- **Bundler:** Vite 8 (`vite` ^8.3.0) with `@vitejs/plugin-react` and `babel-plugin-react-compiler`.
- **Packaging & Supervised Boot:** Node.js child processes supervised by [`deploy/start.mjs`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/deploy/start.mjs#L7-L76).

### 2.2 Key Backend Source Files & Responsibilities
| File Path | Key Symbols & Exports | Role & Responsibilities |
| :--- | :--- | :--- |
| [`server/index.mjs`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/server/index.mjs#L1-L30) | `HermesBotRegistry`, `HermesBots`, `HermesClient`, `HermesRunJournal`, `HermesSessionBridge`, `createApp` | Server entrypoint: loads state directories, initializes registry, bot manager, gateway client, session bridge, and listens on `MUSE_PORT`. |
| [`server/app.mjs`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/server/app.mjs#L109-L466) | `createApp`, `browserImage`, `SETTINGS_RPC_METHODS`, `sendEvent`, `startEvents` | HTTP request routing, cookie authentication (`muse_session`), origin checks, SSE streaming (`/api/events`), legacy OpenClaw routes, static file serving. |
| [`server/hermes-client.mjs`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/server/hermes-client.mjs#L90-L280) | `HermesClient`, `hermesSessionKey`, `hermesNativeSessionKey`, `parseHermesSessionKey` | Loopback client connecting to Hermes Runtime API (`:8642`) and Hermes Settings Dashboard (`:8080`). Manages SSE event reader (`events()`) and per-profile auth tokens. |
| [`server/hermes-session.mjs`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/server/hermes-session.mjs#L39-L165) | `HermesSessionBridge`, `createSessionBootstrap` | Manages native Gateway WebSocket (`/api/ws`) connections per bot using tickets generated by `deploy/hermes-session-bootstrap.py`. Handles JSON-RPC 2.0 frames. |
| [`server/hermes-chat.mjs`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/server/hermes-chat.mjs#L25-L325) | `createHermesChatRoutes` | HTTP routes for `/api/sessions`, `/api/tasks`, `/api/sessions/:key/turns`, `/api/security/approvals`, handling run reconciliation and approval tracking. |
| [`server/hermes-bots.mjs`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/server/hermes-bots.mjs#L13-L164) | `HermesBotRegistry`, `HermesBots` | Multi-bot registry. Persists bot roster and per-bot API keys to `$HOB_STATE_DIR/bots.json`. Initializes workspace `/opt/data/workspaces/bots/<name>`. |
| [`server/hermes-run-journal.mjs`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/server/hermes-run-journal.mjs#L15-L126) | `HermesRunJournal`, `TERMINAL_RUNS` | Crash-resilient run admission journal (`runs.json`). Records turn submissions, idempotency keys, and recovery states before dispatch. |
| [`deploy/start.mjs`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/deploy/start.mjs#L7-L81) | `supervise`, `bootstrap` | Process supervisor for the container: boots Hermes settings (`:8080`), Hermes gateway runtime (`:8642`), and HOB web server (`:3000`). Handles graceful `SIGTERM`/`SIGINT`. |
| [`deploy/bootstrap-hermes.mjs`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/deploy/bootstrap-hermes.mjs#L40-L85) | `bootstrapHermes`, `listenerCredentials` | Generates listener credentials (`listener-auth.json`), sets up environment variables, seeds default configuration, and defines supervised process list. |
| [`deploy/probe-browser.mjs`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/deploy/probe-browser.mjs#L1-L110) | Direct probe script | Probes Playwright-installed Chromium at `/opt/hermes/tools` inside the Docker image. Verifies `--headless=new`, CDP WebSocket handshake, and Linux namespace/seccomp sandboxes. |

### 2.3 Existing Persistence & Storage Conventions
- **Primary Data Directory:** `$HERMES_HOME` (`/opt/data` in Docker, `.muse-data/hermes` locally).
- **HOB State Directory:** `$HOB_STATE_DIR` (`/opt/data/.hob`).
- **Persistence Pattern:** Atomic write + rename (`writeFile(temp, { flag: 'wx', mode: 0o600 })` then `rename(temp, target)` with `directory.sync()` on Linux).
  - Current files: `bots.json`, `runs.json`, `listener-auth.json`.
- **SQLite Availability:** Node.js 24 provides built-in `node:sqlite` (`import { DatabaseSync } from 'node:sqlite'`). Upstream Hermes uses Python standard library `sqlite3` for its `state.db` files.

### 2.4 Authentication & Session Identifiers
- **Operator Auth:** HTTP cookie `muse_session` (HMAC-SHA256 signed with `MUSE_SESSION_SECRET` or derived hash). Alternatively, HTTP header `Authorization: Bearer <MUSE_ACCESS_TOKEN>`.
- **Bot/Profile Scoping:** HTTP request header `X-Hob-Profile: <profile_id>` sent by frontend on every API request.
- **Session Keys:** Base64URL-encoded JSON tuple:
  - Non-canonical: `JSON.stringify([profile, sessionId])` -> `hermesSessionKey(profile, sessionId)`.
  - Canonical: `JSON.stringify([profile, sessionId, 'canonical'])` -> `hermesNativeSessionKey(profile, sessionId)`.
- **Validation:** Enforced in [`parseHermesSessionKey`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/server/hermes-client.mjs#L48-L62).

### 2.5 Frontend Component Architecture & Insertion Points
- **Entry & Layout:** [`web/src/pages/ChatScreen.tsx`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/web/src/pages/ChatScreen.tsx#L35-L184) manages 3 panels:
  1. *Left Panel:* [`LeftSidebar.tsx`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/web/src/components/LeftSidebar.tsx) (navigation rail) + [`BotsSidebar.tsx`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/web/src/components/BotsSidebar.tsx) (bot selector).
  2. *Center Panel:* [`ChatHeader.tsx`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/web/src/components/ChatHeader.tsx), [`ChatMessageList.tsx`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/web/src/components/ChatMessageList.tsx), [`ChatInput.tsx`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/web/src/components/ChatInput.tsx).
  3. *Right Panel:* [`RightPanel.tsx`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/web/src/components/RightPanel.tsx).
- **Existing Browser Tab:**
  - Tab Definition: `activeTab === 'browser'` in [`web/src/types/chat.ts`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/web/src/types/chat.ts#L61) (`RightPanelTab = 'tasks' | 'security' | 'browser' | 'goals' | 'identity'`).
  - Rendering Seam: [`RightPanel.tsx` line 459](file:///d:/code/github-projects/Mused%20-%20OpenMuse/web/src/components/RightPanel.tsx#L459-L464):
    ```tsx
    function BrowserPanel() {
      if (!agent) return <Notice>Loading browser…</Notice>;
      return runtime === 'hermes' ? <HermesBrowser key={agent.id} profile={agent.id} /> : <OpenClawBrowserPanel />;
    }
    ```
  - Current Placeholder: [`web/src/pages/HermesWorkspace.tsx` line 157](file:///d:/code/github-projects/Mused%20-%20OpenMuse/web/src/pages/HermesWorkspace.tsx#L157-L184): Currently renders an informational message with an "Ask bot to browse" button. **This is the exact component to replace with the Atrium Remote Browser viewer.**

---

## 3. Official Hermes Integration Map

### 3.1 Pinned Runtime Version & Topology
- **Upstream Git Revision:** Commit `7e9eb8d9` (Hermes Agent 0.22+ on default branch, pinned in [`Dockerfile` line 16](file:///d:/code/github-projects/Mused%20-%20OpenMuse/Dockerfile#L16)).
- **Execution Architecture:** Hermes runs as a separate supervised daemon process (`/opt/hermes/bin/hermes gateway run --no-supervise --external-supervisor`).
- **Communication Channels:**
  - *Runtime REST API:* `http://127.0.0.1:8642` (Authenticated with bearer token per bot).
  - *Dashboard REST API:* `http://127.0.0.1:8080` (Authenticated with `X-Hermes-Session-Token`).
  - *Gateway WebSocket:* `ws://127.0.0.1:<dynamic_port>/api/ws` (Authenticated via single-use tickets minted through loopback control socket `/opt/data/gateway.sock`).

### 3.2 Hermes Browser Architecture & Extension Points
Official Hermes contains two major browser automation layers:
1. **Legacy Engine (`tools/browser_tool.py`, `tools/browser_tool_session.py`):**
   - Drives Chromium via local headless subprocess, CDP override (`BROWSER_CDP_URL`), or cloud providers (Browserbase, Firecrawl).
   - Generates compact accessibility tree snapshots with element reference IDs (`@e1`, `@e2`).
2. **Native Extension Control Broker (`gateway/browser_control_broker.py`, `tools/browser_extension_router.py`):**
   - **This is the official, upgrade-safe extension mechanism built into Hermes.**
   - Enabled via configuration: `browser.extension_control.enabled: true` in `config.yaml`.
   - Wire protocol: `BROWSER_CONTROL_PROTOCOL_VERSION = 1`.
   - **How it works:**
     - The tool registry wraps all `browser_*` functions in [`routed_browser_handler`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/hermes-agent/tools/browser_extension_router.py#L112-L138).
     - When an agent calls `browser_navigate`, `browser_click`, `browser_type`, `browser_snapshot`, `browser_screenshot`, `browser_scroll`, `browser_press`, or `browser_tabs`, Hermes checks `gateway/browser_control_broker.py` for a registered controller.
     - If a controller is registered for the current session/principal, Hermes **skips the local browser process entirely** and sends a JSON-RPC frame over the Gateway WebSocket to the controller:
       ```json
       {
         "jsonrpc": "2.0",
         "method": "event",
         "params": {
           "type": "browser.controller.command",
           "session_id": "...",
           "payload": {
             "command_id": "cmd_abc123",
             "action": "browser_click",
             "arguments": { "ref": "@e2" },
             "tool_call_id": "call_xyz789"
           }
         }
       }
       ```
     - The controller executes the action against Chromium and replies via JSON-RPC:
       ```json
       {
         "jsonrpc": "2.0",
         "id": 42,
         "method": "browser.controller.result",
         "params": {
           "session_id": "...",
           "command_id": "cmd_abc123",
           "ok": true,
           "result": { "status": "clicked", "title": "Example Domain" }
         }
       }
       ```
     - If the controller completes the command with `"ok": false`, it provides `"error": "..."`, which Hermes sanitizes and formats for the LLM.
     - If human takeover is active, the controller can reject or pause the command cleanly.

### 3.3 Supported Controller Capabilities
Defined in [`gateway/browser_control_broker.py` line 31](file:///d:/code/github-projects/Mused%20-%20OpenMuse/hermes-agent/gateway/browser_control_broker.py#L31-L38):
- Standard: `"controller.noop"`, `"browser_back"`, `"browser_click"`, `"browser_navigate"`, `"browser_press"`, `"browser_screenshot"`, `"browser_scroll"`, `"browser_snapshot"`, `"browser_tab_activate"`, `"browser_tabs"`, `"browser_type"`
- Developer (optional): `"browser_cdp"`, `"browser_evaluate"`
- Artifact: `"browser_artifact_download"`, `"browser_artifact_upload"`

---

## 4. Deep Inspection of Atrium

### 4.1 Package Architecture & License
- **Upstream Repository:** `https://github.com/ohmaseclaro/atrium`
- **License:** MIT (Verified in [`packages/core/package.json`](file:///C:/Users/Abdullah/.gemini/antigravity-ide/brain/0fd772d5-f352-4798-8646-7cf1b0e01025/scratch/atrium/packages/core/package.json#L5) and root [`LICENSE`](file:///C:/Users/Abdullah/.gemini/antigravity-ide/brain/0fd772d5-f352-4798-8646-7cf1b0e01025/scratch/atrium/LICENSE)).
- **Monorepo Structure (pnpm workspace):**
  - `@atriumjs/protocol` (v0.3.0): Zod schemas for client/server messages, control states, and session bootstrap.
  - `@atriumjs/core` (v0.3.0): Framework-agnostic session dispatch, streaming relay, and in-memory session store.
  - `@atriumjs/express` (v0.3.0): Express router & upgrade middleware wrapper over core.
  - `@atriumjs/react` (v0.3.0): React 18/19 compatible canvas viewer (`RemoteBrowser`), WebSocket relay, and client input handling.
  - `@atriumjs/worker` (v0.3.0): Playwright-based browser launcher, CDP screencast pipeline, and internal HTTP/WS server.
  - `@atriumjs/cli` (v0.3.0): Development CLI runner.

### 4.2 Verified Technical Findings on Atrium

| Question | Verified Finding in Atrium Source | Source Evidence |
| :--- | :--- | :--- |
| **Can Atrium attach to an existing Chromium process?** | **NO.** The worker calls `chromium.launch(...)`. It does not support `chromium.connectOverCDP()`. | [`packages/worker/src/index.ts` L1349](file:///C:/Users/Abdullah/.gemini/antigravity-ide/brain/0fd772d5-f352-4798-8646-7cf1b0e01025/scratch/atrium/packages/worker/src/index.ts#L1349) |
| **Can it use Playwright persistent browser context?** | **NO.** The worker launches a new browser and calls `browser.newContext(...)` with ephemeral in-memory storage. | [`packages/worker/src/index.ts` L1355-L1360](file:///C:/Users/Abdullah/.gemini/antigravity-ide/brain/0fd772d5-f352-4798-8646-7cf1b0e01025/scratch/atrium/packages/worker/src/index.ts#L1355-L1360) |
| **Does it create a new browser per session?** | **YES.** `attachSessionPipeline` invokes `chromium.launch` for every newly attached `sessionId`. | [`packages/worker/src/index.ts` L1330-L1350](file:///C:/Users/Abdullah/.gemini/antigravity-ide/brain/0fd772d5-f352-4798-8646-7cf1b0e01025/scratch/atrium/packages/worker/src/index.ts#L1330-L1350) |
| **Can browser processes be launched lazily?** | **YES.** `POST /sessions` only stores metadata in `pendingBootstraps`. Chromium launch occurs exclusively when the first WebSocket connects to `/internal/stream/:id`. | [`packages/worker/src/index.ts` L972-L993](file:///C:/Users/Abdullah/.gemini/antigravity-ide/brain/0fd772d5-f352-4798-8646-7cf1b0e01025/scratch/atrium/packages/worker/src/index.ts#L972-L993), [L1307-L1349](file:///C:/Users/Abdullah/.gemini/antigravity-ide/brain/0fd772d5-f352-4798-8646-7cf1b0e01025/scratch/atrium/packages/worker/src/index.ts#L1307-L1349) |
| **Can browser profiles survive worker restarts?** | **NO.** Stock Atrium uses in-memory maps (`sessions`, `MemorySessionStore`). All session state and cookie jars are lost on restart. | [`packages/worker/src/index.ts` L106](file:///C:/Users/Abdullah/.gemini/antigravity-ide/brain/0fd772d5-f352-4798-8646-7cf1b0e01025/scratch/atrium/packages/worker/src/index.ts#L106), [`packages/core/src/memory-session-store.ts`](file:///C:/Users/Abdullah/.gemini/antigravity-ide/brain/0fd772d5-f352-4798-8646-7cf1b0e01025/scratch/atrium/packages/core/src/memory-session-store.ts) |
| **How does the React viewer receive screen frames?** | Worker initiates CDP `Page.startScreencast`. Frames arrive via `Page.screencastFrame`, sent as JSON metadata `{ t: "frame", seq, ts, mime: "image/jpeg" }` followed immediately by a raw binary JPEG WebSocket frame (`ArrayBuffer`). React viewer draws to HTML5 `<canvas>`. | [`packages/worker/src/index.ts` L600-L657](file:///C:/Users/Abdullah/.gemini/antigravity-ide/brain/0fd772d5-f352-4798-8646-7cf1b0e01025/scratch/atrium/packages/worker/src/index.ts#L600-L657), [`packages/react/src/index.tsx` L363-L394](file:///C:/Users/Abdullah/.gemini/antigravity-ide/brain/0fd772d5-f352-4798-8646-7cf1b0e01025/scratch/atrium/packages/react/src/index.tsx#L363-L394) |
| **How are mouse & keyboard inputs forwarded?** | React captures pointer/keyboard events, scales by `canvas.width / rect.width`, sends `{ t: "input", kind, payload }`. When `live.control.holder === "human"`, worker dispatches directly to `page.mouse` and `page.keyboard`. | [`packages/worker/src/index.ts` L514-L590](file:///C:/Users/Abdullah/.gemini/antigravity-ide/brain/0fd772d5-f352-4798-8646-7cf1b0e01025/scratch/atrium/packages/worker/src/index.ts#L514-L590), [`packages/react/src/index.tsx` L834-L960](file:///C:/Users/Abdullah/.gemini/antigravity-ide/brain/0fd772d5-f352-4798-8646-7cf1b0e01025/scratch/atrium/packages/react/src/index.tsx#L834-L960) |
| **How does human takeover work internally?** | Viewer sends `{ t: "request_control" }` (or HTTP `POST /sessions/:id/control`). Worker updates `live.control = { holder: "human", since }` and emits `{ t: "control", holder: "human" }`. Client inputs are discarded while `holder !== "human"`. | [`packages/worker/src/index.ts` L515](file:///C:/Users/Abdullah/.gemini/antigravity-ide/brain/0fd772d5-f352-4798-8646-7cf1b0e01025/scratch/atrium/packages/worker/src/index.ts#L515), [L1262-L1271](file:///C:/Users/Abdullah/.gemini/antigravity-ide/brain/0fd772d5-f352-4798-8646-7cf1b0e01025/scratch/atrium/packages/worker/src/index.ts#L1262-L1271) |
| **Does Atrium provide cursor coordinates or animations?** | **NO.** Protocol message `{ t: "cursor", cursor: string }` represents only CSS cursor string (e.g. `"pointer"`), and the worker never even emits it. Cursor coordinates and animated pointers do not exist in Atrium. | [`packages/protocol/src/index.ts` L44](file:///C:/Users/Abdullah/.gemini/antigravity-ide/brain/0fd772d5-f352-4798-8646-7cf1b0e01025/scratch/atrium/packages/protocol/src/index.ts#L44), [`packages/react/src/index.tsx` L306-L308](file:///C:/Users/Abdullah/.gemini/antigravity-ide/brain/0fd772d5-f352-4798-8646-7cf1b0e01025/scratch/atrium/packages/react/src/index.tsx#L306-L308) |
| **Can screencasting stop when nobody is watching?** | Stock worker continues running CDP screencast and discarding frames when the socket closes. However, calling `Page.stopScreencast` on close is a simple 3-line optimization. | [`packages/worker/src/index.ts` L620-L623](file:///C:/Users/Abdullah/.gemini/antigravity-ide/brain/0fd772d5-f352-4798-8646-7cf1b0e01025/scratch/atrium/packages/worker/src/index.ts#L620-L623), [L1282-L1287](file:///C:/Users/Abdullah/.gemini/antigravity-ide/brain/0fd772d5-f352-4798-8646-7cf1b0e01025/scratch/atrium/packages/worker/src/index.ts#L1282-L1287) |
| **Can its viewer be restyled without modifying internals?** | **YES.** Passing `chrome="none"` strips all default UI chrome (toolbar, omnibox, tab strip) and renders only the raw stream canvas. HOB can wrap it with native styling. | [`packages/react/src/index.tsx` L75](file:///C:/Users/Abdullah/.gemini/antigravity-ide/brain/0fd772d5-f352-4798-8646-7cf1b0e01025/scratch/atrium/packages/react/src/index.tsx#L75), [L1057-L1064](file:///C:/Users/Abdullah/.gemini/antigravity-ide/brain/0fd772d5-f352-4798-8646-7cf1b0e01025/scratch/atrium/packages/react/src/index.tsx#L1057-L1064) |
| **Can functionality be implemented without forking Atrium?** | **YES.** By using `@atriumjs/protocol` and `@atriumjs/react` as-is, and implementing an in-tree HOB Browser Manager (`server/browser-manager.mjs`), HOB gets full persistent multi-bot support with zero git forks. | Architectural evaluation (see Section 6 & 7) |

---

## 5. Integration Boundaries & Contract Specifications

### 5.1 Boundary 1: Hermes Gateway ↔ HOB Browser Broker
- **Transport:** Loopback WebSocket connection to Hermes Gateway (`/api/ws`).
- **Initiator:** HOB Browser Broker connects as an authenticated controller.
- **Protocol:** JSON-RPC 2.0 with protocol `hermes-gateway-v1` and ticket `hermes-gateway-ticket.<token>`.
- **Registration Call:**
  ```json
  {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "browser.controller.register",
    "params": {
      "session_id": "<session_id>",
      "controller_id": "hob-browser-manager",
      "browser_profile_id": "<profile_id>",
      "protocol_version": 1,
      "capabilities": [
        "browser_navigate", "browser_click", "browser_type", "browser_snapshot",
        "browser_screenshot", "browser_scroll", "browser_press", "browser_tabs",
        "browser_back", "controller.noop"
      ]
    }
  }
  ```
- **Inbound Command Dispatch:**
  When Hermes dispatches an action, the broker receives frame `browser.controller.command`.
- **Outbound Command Result:**
  HOB executes action on the bot's Playwright instance and calls `browser.controller.result` with matching `command_id`.

### 5.2 Boundary 2: HOB Backend ↔ Chromium (Playwright Persistent Context)
- **Execution Mode:** Native Node.js module [`server/browser-manager.mjs`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/server/browser-manager.mjs) using `playwright-core` (or `playwright`).
- **Persistent Profile Path:**
  `const userDataDir = path.join(process.env.HERMES_HOME, 'browser_profiles', botId);`
- **Launch Command:**
  ```javascript
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true, // or false when DISPLAY/Xvfb present
    executablePath: process.env.PLAYWRIGHT_CHROME_EXECUTABLE || '/opt/hermes/tools/chrome',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-background-networking',
      '--remote-debugging-port=0' // enables CDP for screencast
    ],
    viewport: { width: 1280, height: 800 }
  });
  ```
- **Process Reuse:** Exactly one persistent context per bot. Multiple turns, sessions, or viewer tabs for that bot connect to the same live context.

### 5.3 Boundary 3: HOB Backend ↔ React Viewer (`@atriumjs/react`)
- **Transport:** WebSocket upgraded on HOB Node HTTP Server at `/api/browser/stream/:botId`.
- **Authentication:** Validated via standard `muse_session` cookie or temporary viewer token minted via `POST /api/browser/sessions/:botId`.
- **Protocol:** 100% compliant with `@atriumjs/protocol`:
  - Worker -> Viewer: Binary JPEG frames + JSON control, tabs, navigation, viewport events.
  - Viewer -> Worker: `{ t: "input", ... }`, `{ t: "request_control" }`, `{ t: "release_control" }`, `{ t: "navigate" }`.
- **Synthetic Cursor Extension:** When the agent clicks or moves, HOB emits an extended event:
  `{ t: "cursor_position", x: number, y: number, action: "click" | "move" | "type" }`.

### 5.4 Boundary 4: HOB State & Leases
- **Storage:** Managed via Node 24's built-in `node:sqlite` in `$HOB_STATE_DIR/browser.db` (or atomic JSON in `$HOB_STATE_DIR/browser.json`).
- **Schema Responsibility:** Bot browser records, last active timestamp, current control lease (`agent` vs `human`), and active tab metadata.

---

## 6. Lifecycle Workflow Tracing

```
[User Action / Bot Created]
        |
        v
(Workflow A) Assign bot browser profile path: /opt/data/browser_profiles/<bot_id>
             (No Chromium launch; zero RAM usage)
        |
        +-----------------------------------+
        |                                   |
        v                                   v
(Workflow B: Agent Action)          (Workflow C: User Opens Panel)
Agent calls browser_navigate        User clicks "Web" Tab in HOB
        |                                   |
        v                                   v
Check if Bot Chromium running?      Check if Bot Chromium running?
        |                                   |
        +-----------------+-----------------+
                          |
                          v
        Launch Bot Chromium Persistent Context Lazily
        Attach CDP Session & Page.startScreencast
                          |
        +-----------------+-----------------+
        |                                   |
        v                                   v
Execute Agent Tool via CDP          Stream binary JPEG frames
Return Snapshot & Result to LLM     over WebSocket to React Viewer
        |                                   |
        +-----------------+-----------------+
                          |
                          v
(Workflow D) Synchronized Action:
Agent executes click -> synthetic cursor event emitted -> viewer shows animated click ring
                          |
                          v
(Workflow E) Human Takeover:
User clicks "Take Control" -> control.holder = "human"
Agent browser actions pause -> user DOM inputs drive Playwright mouse/keyboard
                          |
                          v
(Workflow F) Release Control:
User clicks "Release Control" -> control.holder = "agent"
Hermes inspects updated DOM snapshot and resumes work
                          |
                          v
(Workflow G) Idle Shutdown:
No agent runs + viewer closed for 15 minutes -> browser context closes cleanly
Profile cookies and localStorage remain intact on disk
```

### Detailed Lifecycle Analysis:
- **Workflow A (Bot Creation):** User creates a bot `scout`. HOB registers the bot in `bots.json`. HOB assigns browser profile path `/opt/data/browser_profiles/scout`. No Chromium process starts.
- **Workflow B (Hermes Browser Action):** Hermes executes `browser_navigate("https://news.ycombinator.com")`. The broker resolves `scout`, launches Chromium lazily with persistent profile if not running, opens the page, returns accessibility snapshot and title.
- **Workflow C (Live Viewer):** Operator opens HOB right-panel "Web" tab. Frontend connects WebSocket to `/api/browser/stream/scout`. Backend hooks into active page's CDP screencast, sending binary JPEG frames.
- **Workflow D (Synchronized Cursors):** Agent executes `browser_click(ref="@e5")`. Element coordinates are resolved. Broker emits `{ t: "cursor_position", x: 420, y: 310, action: "click" }`. React viewer animates an agent cursor at `(420, 310)`.
- **Workflow E & F (Takeover & Handback):** Operator clicks "Take Control". Control lease becomes `human`. If Hermes requests a browser action while human is in control, the broker returns a structured wait/yield status. Human logs into a service. Operator clicks "Return Control". Hermes receives new snapshot and proceeds.
- **Workflow G (Idle Shutdown):** 15 minutes pass with no viewer connected and no agent turn active. Browser Manager closes Chromium cleanly to free RAM.
- **Workflow H (Crash / Restart Recovery):** Container restarts. Browser Manager reads persisted profile directories. State reconciles cleanly. Chromium launches on next use with all prior cookies intact.

---

## 7. Architectural Conflicts & Mitigations

### Conflict 1: Duplicate Browser Processes & Divergent Profiles
- **Problem:** If Hermes runs default `agent-browser` / local Chromium while HOB runs Atrium, two separate browsers will run per bot. Cookies won't be shared, RAM will double, and the user will not see what the agent is doing.
- **Resolution:** By registering HOB as Hermes's `browser_control_broker` controller, Hermes's local subprocess launcher is completely bypassed. Both Hermes and the user operate the exact same Chromium instance.

### Conflict 2: Headless vs Headed Assumptions in Docker
- **Problem:** Atrium defaults to headed Chromium (`headless: false`). A cloud VPS or headless container lacks an X11 display, causing Chromium to crash unless Xvfb is installed.
- **Resolution:** Launch Chromium with `--headless=new`. [`deploy/probe-browser.mjs`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/deploy/probe-browser.mjs#L28-L95) proves `--headless=new` with CDP sandboxing works out of the box in HOB's Docker environment without needing X11 or VNC.

### Conflict 3: Chromium User-Data-Dir Profile Locking
- **Problem:** Chromium creates lockfiles (`SingletonLock`) in `userDataDir`. Attempting to start two processes on the same directory causes fatal startup errors.
- **Resolution:** Strict in-memory mutex in `server/browser-manager.mjs`. Exactly one persistent context is active per bot.

### Conflict 4: In-Memory Atrium Session Loss on Restart
- **Problem:** Atrium's `MemorySessionStore` and worker map are completely in-memory.
- **Resolution:** HOB's Browser Manager uses durable directory-backed profiles (`/opt/data/browser_profiles/<bot_id>`) so restart reconciliation preserves all authentication state.

### Conflict 5: Missing Cursor Coordinates in Atrium
- **Problem:** Atrium protocol only sends CSS cursor strings (`{ t: "cursor", cursor: "pointer" }`), not coordinate positions.
- **Resolution:** HOB Browser Broker calculates bounding boxes for `@eN` refs or clicks and emits an additive event `{ t: "cursor_position", x, y, action }` over the viewer WebSocket.

---

## 8. Minimum-Change Architecture Recommendation

To achieve maximum stability, low RAM usage, zero modifications to official Hermes, and zero forks of Atrium:

1. **Keep Official Hermes 100% Unmodified:**
   - Configure `browser.extension_control.enabled: true` in seeded bot configuration.
   - HOB connects to Hermes Gateway `/api/ws` as the browser controller.
2. **Reuse Atrium React Viewer As-Is:**
   - Add `@atriumjs/protocol` and `@atriumjs/react` to `web/package.json`.
   - In `web/src/pages/HermesWorkspace.tsx`, mount `<RemoteBrowser chrome="none" />` inside HOB's existing dark/bronze themed panel, augmented with custom takeover controls and a cursor overlay.
3. **Implement HOB Browser Manager in Backend (`server/browser-manager.mjs`):**
   - Implements the Atrium worker WebSocket protocol and Playwright persistent context management directly inside HOB's Node.js process (or a managed lightweight worker).
   - Manages lazy startup, idle timers, screencasting, and human input dispatching.
4. **WebSocket Upgrade in `server/app.mjs`:**
   - Add an upgrade hook on the existing Node HTTP server to handle `/api/browser/stream/:botId`.

---

## 9. Implementation File Map & Changes

### Recommended New Files to Create
| File Path | Purpose & Exports |
| :--- | :--- |
| `server/browser-manager.mjs` | **Core Browser Manager:** Manages per-bot Playwright persistent contexts, lazy startup, idle shutdown, CDP screencast pipeline, and human input forwarding. |
| `server/browser-broker.mjs` | **Hermes Extension Controller:** Connects to Hermes Gateway `/api/ws`, handles `browser.controller.command`, translates actions to Playwright calls, and returns snapshots. |
| `server/browser-routes.mjs` | **Browser REST & WebSocket Routes:** Endpoints for `/api/browser/status`, `/api/browser/control`, `/api/browser/stream/:botId`. |
| `server/test/browser-manager.test.mjs` | Automated unit/integration tests for lazy launch, persistent contexts, and takeover leases. |
| `web/src/components/BrowserViewer.tsx` | Custom React container wrapping `@atriumjs/react` with HOB styling, toolbar, takeover toggle, and cursor overlay. |

### Existing Files Likely to Modify
| File Path | Lines | Modification Rationale |
| :--- | :--- | :--- |
| [`server/index.mjs`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/server/index.mjs) | ~20–30 | Initialize `BrowserManager` and register clean shutdown hooks on `SIGTERM`/`SIGINT`. |
| [`server/app.mjs`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/server/app.mjs) | ~170–235 | Add HTTP routes for browser control and wire `server.on('upgrade')` for browser viewer WebSocket stream. |
| [`server/hermes-bots.mjs`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/server/hermes-bots.mjs) | ~140–155 | Ensure bot configuration seeds `browser.extension_control.enabled: true` and assigns browser profile directory. |
| [`deploy/bootstrap-hermes.mjs`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/deploy/bootstrap-hermes.mjs) | ~45–55 | Ensure `/opt/data/browser_profiles` directory is created with proper permissions. |
| [`web/package.json`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/web/package.json) | ~12–19 | Add dependencies `@atriumjs/protocol` and `@atriumjs/react`. |
| [`web/src/pages/HermesWorkspace.tsx`](file:///d:/code/github-projects/Mused%20-%20OpenMuse/web/src/pages/HermesWorkspace.tsx) | ~157–184 | Replace placeholder `HermesBrowser` component with live `BrowserViewer`. |

---

## 10. Suggested SQLite Schema for Browser Subsystem

If stored in `$HOB_STATE_DIR/browser.db` (via Node 24 `node:sqlite`):

```sql
-- PRAGMA user_version = 1;
-- PRAGMA journal_mode = WAL;
-- PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS bot_browser_profiles (
  bot_id TEXT PRIMARY KEY,
  profile_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_launched_at INTEGER,
  last_active_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('stopped', 'launching', 'ready', 'error')),
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS browser_control_leases (
  bot_id TEXT PRIMARY KEY,
  holder TEXT NOT NULL CHECK(holder IN ('agent', 'human', 'idle')),
  acquired_at INTEGER NOT NULL,
  held_by_session TEXT,
  FOREIGN KEY (bot_id) REFERENCES bot_browser_profiles(bot_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS browser_tabs (
  tab_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (bot_id) REFERENCES bot_browser_profiles(bot_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_browser_tabs_bot ON browser_tabs(bot_id);
```

---

## 11. Step-by-Step Implementation Order for Subsequent Model

1. **Step 1: Dependency Registration**
   - Add `@atriumjs/protocol` and `@atriumjs/react` to `web/package.json`.
   - Add `playwright` (or `playwright-core`) to `server/package.json`.
2. **Step 2: Browser Profile Storage Setup**
   - Update `deploy/bootstrap-hermes.mjs` and `server/hermes-bots.mjs` to provision `/opt/data/browser_profiles/<bot_id>`.
3. **Step 3: Core Browser Manager (`server/browser-manager.mjs`)**
   - Implement lazy persistent context launcher with Playwright.
   - Implement CDP screencast pipeline emitting `@atriumjs/protocol` frame events.
   - Implement idle shutdown timer (15 min inactivity).
4. **Step 4: Hermes Browser Broker Adapter (`server/browser-broker.mjs`)**
   - Connect to Hermes Gateway `/api/ws`.
   - Handle `browser.controller.command` for `browser_navigate`, `browser_click`, `browser_type`, `browser_snapshot`, `browser_screenshot`.
   - Route actions into the active Playwright page.
5. **Step 5: Backend WebSocket & HTTP API (`server/browser-routes.mjs` & `server/app.mjs`)**
   - Implement HTTP upgrade on `server` for `/api/browser/stream/:botId`.
   - Expose control endpoints (`POST /api/browser/control`).
6. **Step 6: Frontend Viewer Integration (`web/src/components/BrowserViewer.tsx` & `HermesWorkspace.tsx`)**
   - Wrap Atrium's `RemoteBrowser` with `chrome="none"`.
   - Add custom HOB dark/bronze toolbar, takeover button, and cursor overlay.
7. **Step 7: Verification & Testing**
   - Run unit tests (`npm test` in `server/` and `web/`).
   - Run container smoke tests (`node deploy/probe-browser.mjs`).
