# Agent platform transformation

Investigation started 2026-10-26. This is a staged implementation record, not a claim that the full mission is finished.

## Verified references and boundaries

* [Grok Bot overview](https://docs.x.ai/grok-bot/overview), [101](https://x.ai/bot/guides/grok-bot-101), [work](https://prod.cursor.com/docs/grok-bot/work), [skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations): document durable named bots, conversations, computer access, approval boundaries, reusable instructions, and scheduled work. Demonstration-to-skill is described as available in some contexts. These are product behaviors; the model routing, scheduler implementation, memory algorithms, and recovery internals are not public contracts.
* [Hermes v0.22.5](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.5) is the latest non-prerelease returned by the official releases API during this investigation. Published 2026-10-23. Release notes mention delegation backends and Desktop plugin installation; this does not establish compatibility with hob's session protocol.
* Deployed Hermes is pinned to `7e9eb8d9a30f4a9bb9f8ecaf816b4b0ffdf47357` (2026-10-17), image digest `sha256:18633293b436b15b8fb306cc065f9b86b21ddf4a9ac60601e07520044b6c00bc`. Authority: `Dockerfile`, `.github/workflows/hermes-runtime-image.yml`. The ignored `hermes-agent/` directory is reference source, not the deployed artifact. GitHub's compare API reports 2,183 commits from this pin to v0.22.5; an untested image replacement is inappropriate.
* [Pinned dashboard plugin routes](https://github.com/NousResearch/hermes-agent/blob/7e9eb8d9a30f4a9bb9f8ecaf816b4b0ffdf47357/hermes_cli/web_routers/dashboard_ui.py) were fetched independently of the reference checkout. They expose catalog, hub, install, enable, disable, update, and remove. **Catalog and mutations use the dashboard launch profile**, not an arbitrary query profile. hob must restrict these operations to Main until upstream supports a bound profile. It must not advertise per-bot installation for these endpoints.
* [Hermes plugin catalog](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugin-catalog) uses reviewed SHA pins, declared capabilities, version requirements, and a removal list. Review is not a security guarantee. Use the native catalog-name installer, never a new arbitrary shell/repository installer. [Plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins), [skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/), [sessions](https://hermes-agent.nousresearch.com/docs/user-guide/sessions), and [cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron) remain runtime-owned.
* [hermes-bot-kit](https://github.com/thomasbek3/hermes-bot-kit), inspected at `4bfdd1bf3c7ad20458e4793666550af760b76d97`: MIT; standalone Desktop SDK plugins, shell/PowerShell installers, remote computer helpers, and one Python agent plugin. `task-dock/plugin.js` snapshots DOM task widgets and labels restored snapshots stale; `bubble-mode/plugin.js` changes Desktop presentation; `computer-viewer/plugin.js` and remote helpers bind computers to bots; `texting-style/__init__.py` injects instructions for Bot Chats. These are not a complete Grok Bot runtime. Its Desktop DOM selectors and SDK are inappropriate dependencies for this React web app. Reuse progressive disclosure and explicit stale-state labeling as design patterns, not the installer scripts or DOM scraping.
* [Playwright actionability](https://playwright.dev/docs/actionability): waiting for actionable state is preferable to fixed sleeps. Existing hob precision input and native browser ownership should be preserved; adding another browser automation owner would create conflicting sessions. No new orchestration service or paid dependency is required for the first stage.

## Execution map traced

| Boundary | Implementation and ownership |
| --- | --- |
| Boot / deployment | `server/index.mjs`, `deploy/start.sh`, bootstrap scripts, Docker/Compose; Node front door, private Hermes services |
| Authentication | `server/app.mjs`: login, signed HttpOnly cookies, origin checks, rate limits, authenticated API dispatch |
| UI | `App.tsx` -> AuthGate -> RuntimeProvider -> ChatProvider -> ChatScreen; chat, roster, contextual right panel and WorkspaceViews |
| Request lifecycle | ChatContext / profile-bound `api.ts` -> canonical chat route -> HermesSessionBridge RPC `prompt.submit` -> native events -> SSE translation -> conversation store/history reconciliation |
| Persistence / recovery | Hermes owns sessions/messages/receipts/approvals; `HermesRunJournal` atomically stores correlation and unknown-admission information. Boot does not replay work. Refresh observes native receipts. A new orchestration database must not compete with this authority. |
| Bots | `hermes-bots.mjs`, workspace enrollment, per-profile credential binding; browser manager assigns per-bot profiles. These are logical boundaries, not an OS sandbox. |
| Delegation / groups | Native Hermes tools and group RPCs, with adapters in `hermes-groups.mjs`, `hermes-bot-network.mjs`, `hermes-bot-relay.mjs`; no replacement multi-agent framework |
| Browser | browser manager -> per-bot BrowserSession -> Chromium pipe/CDP gateway -> mutation admission + human lease; viewer WebSocket, persistent profile, precision input, challenge tracker |
| Setup / secrets | Explicit allowlisted routes in `hermes-routes.mjs` and `hermes-setup.mjs`; native config/env APIs; secrets remain server-side |
| Skills / memory / jobs | Native workspace APIs exposed by `hermes-workspace.mjs`, Workshop and goals; native proposal decisions and learning/memory adapters |
| Tests | Node server tests (including real Chromium gateway tests), TypeScript service tests, deployment checks, separate model/runtime end-to-end harness |

This traces the central paths. A complete line-by-line security audit of every legacy and deployment module remains outstanding.

## Integration map and priority

| Requirement | Existing capability | Action |
| --- | --- | --- |
| Coherent conversation / durable sessions | Already native Hermes + hob adapter | Preserve; test recovery and correlation; do not build another execution engine |
| Persistent bots, tools, channels, MCP, memory | Existing backend and UI | Improve navigation, asynchronous ownership, and honest persistence feedback |
| Discover/install plugins | Native pinned catalog + installer not exposed in hob | Add narrow Main-only adapter and working catalog UI; validate source/pin, preserve native validation and consent |
| Skills / schedules | Existing native Workshop and cron surfaces | Reuse; richer discovery and skill dependency UI remain later work |
| Settings organization | One long Hermes page | Searchable category navigation; retain drafts during category switches; persist navigation preference separately from native configuration |
| Human interruptions | Tracker/lease/gate already exist, but default detects without parking | Add explicit human mode; gate until observed resolution, notify operator immediately; no new solver or evasion mechanism |
| Visual system | Existing semantic tokens, light palette | Add theme preferences and coherent dark tokens; progressive disclosure in settings; further chat/workspace design refinement remains |
| Upstream update | Immutable image and compatibility checks exist | Keep pin in this stage; validate target protocol in Linux deployment suite before upgrading |

## State boundaries

Native Hermes owns bot configuration, provider credentials, conversation history, prompts/approvals, skills, memory, schedules and job outcomes. hob owns enrolled-profile routing, authentication, browser ownership, run correlation and UI preferences. Browser cookies remain in per-bot Chromium profiles. In-memory streams and transport connections are not restartable tasks; native receipts/snapshots, not a cached spinner, establish execution status. Settings category and theme are browser preferences, never runtime configuration. Plugin catalog and installed-state responses must come from Hermes, never optimistic local installation records.

## First-stage findings

| Finding / reproduction | Root cause / components | Severity / fix |
| --- | --- | --- |
| Save invalid config, then inspect the editor's save indicator | HermesSettings catches a failed mutation without rethrowing; HermesConfigEditor interprets fulfilled promise as saved | Medium: propagate failure to editor; success only after native acknowledgement; keep edited draft when saving fails |
| Change the selected bot while setup reads/writes are pending | Some form state and callbacks share a mounted component across identities | High: key settings contents by profile, capture profile headers, invalidate stale requests, serialize writes |
| Plugin request names a non-default profile | Upstream launch-profile mutation ignores that selector | High: reject unsupported profile before any upstream plugin call; show boundary explicitly in UI |
| Agent encounters confirmed challenge in default mode | Detection-only mode doesn't gate subsequent mutations | Medium: add human mode with immediate operator notification, preserve waiting admission, release only on observed resolution |
| Open settings with many integrations | Every subsystem appears together and loads at once | Medium: progressively mounted categories, retained drafts, search, persistent selected category |
| Connect to the external-computer VNC path without a dashboard cookie or from a different Origin | `agent-computer-routes.mjs` handled upgrades outside the HTTP auth boundary | Critical: authenticate and verify Origin before config access/upgrading; bind enrolled profile; regression tests cover the production app wiring and real sockets |
| Request a named bot's computer when only Main is configured | Shared config paths were consulted before the selected home; a literal fallback credential and remote endpoint were embedded in code | Critical: remove embedded defaults; read only the selected profile; Main-only explicit environment fallback; reject home aliases/traversal; no connection is reported or contacted without configuration |
| Remote wake/sleep executes but its reply is lost | Catch-all protocol/URL fallback could replay the mutation via another endpoint | High: one bounded, non-redirecting request; no mutation retry; return an uncertain-result error and require status observation |
| Computer status contains a different ID than its preceding list | Unchecked result association | High: reject the mismatched identity and never expose a stream credential for that response |
| Open inspector on desktop or mobile | Two RightPanel trees were mounted and merely hidden with CSS | Medium: one responsive inspector tree; prevents duplicate viewers/polling and independent control state |
| No live activity is returned | RightPanel inserted hardcoded sample task groups and claimed full tool access | Medium: actual empty/disconnected states, no fabricated actions/capabilities; connect View all to activity navigation |
| Replace a noVNC socket, then receive its late disconnect / leave while retry is pending | Shared close flags, recursive callbacks and stale closures could clear the newer connection or keep retrying after unmount | High: isolated typed stream owner, per-connection identity checks, bounded retries, cancellation on teardown, explicit reconnect, and tests of failure/replacement sequences |
| Run Docker's `npm ci` rather than the local pnpm build | npm lockfile was missing optional dependency entries; Vite in that lock was still vulnerable | High: repair npm locks, synchronize the pnpm lock from npm, bump the Vite minimum to 8.3.4 (resolved 8.3.5), validate clean npm installs |

## Validation and remaining work

Baseline: 367 server tests passed, two skipped; 41 web service tests passed; frontend build passed. Repository lint initially reported 15 errors plus warnings; all are fixed in this stage.

Final stage checks:

| Check | Evidence / limit |
| --- | --- |
| Server regression suite | 388 passed, two skipped, zero failed under Node 24.21.0; real Chromium gateway, isolation, crash/restart and challenge tests are included |
| Frontend service regressions | 49 passed under Node 24.21.0, including socket replacement, bounded retry, teardown, settings, stream and conversation ownership cases |
| Frontend lint | `npm run lint` passed after a clean npm install |
| Frontend build | `npm run build` passed after a clean npm install; 694.42 kB main JS, 196.11 kB gzip. Baseline main JS was 899.45 kB / 258.16 kB gzip. The 25.39 kB shared chunk and deferred 199.98 kB computer chunk are separate; this is bundle size, not a measured latency benchmark. Vite still warns that the main chunk exceeds 500 kB. |
| Browser UI checks | Four tests passed against the production bundle in installed Chrome: settings draft retention, failed save feedback, saved values after reload, persisted theme/navigation, mobile layout/focus, native install request/pin contract, named-profile restrictions and deferred inspector availability. APIs are explicit fixtures, not a live Hermes installation. Screenshots are under ignored `web/test-results/`. |
| VNC integration | Real local WebSockets verify anonymous/cross-origin refusal and early-frame forwarding through a configured bot's proxy; no external computer account was contacted |
| Human intervention | Real Chromium with a local challenge fixture: gate parks an agent action, operator input clears the fixture, action remains blocked while human control is held, handback resumes the same action; no solver is used by human mode |
| Packaging | Both `server` and `web` clean `npm ci --ignore-scripts` installs passed; CI now includes web tests, lint, build and Chromium UI checks. CI itself was not run here. |
| Linux container / live runtime | Not executed: Docker is not installed in this environment. No model/provider credentials, live channel connections or production plugin installation were used. |

### Operational notes and remaining risks

* **Rotate the previously embedded external-computer credential at its provider.** Removing it from current source does not revoke it or erase Git history. Provider-side revocation was not performed here.
* `npm audit` still identifies [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) through Atrium's `zod@3.25.76` dependency (two affected package entries on the server, three on the web). Atrium 0.3.0 requires Zod 3; the advisory points to a fix in Zod 4.6.6+. No unsupported major override was applied. Qualify an updated protocol dependency or a compatible upstream backport; payload bounds and authentication are not a patch for the advisory.
* External computer setup now requires an explicit `mcp_servers.agent_computer` or `agent-computer` HTTP endpoint in the selected native `config.yaml`, with literal Bearer credentials where needed. The Main bot also supports explicit `AGENT_COMPUTER_URL` / `AGENT_COMPUTER_TOKEN` environment configuration. Disabled connections stay disabled. Unresolved credential expressions are rejected. The adapter supports the existing JSON-RPC tool interface; it no longer guesses endpoints, identities, credentials or alternate REST mutations. General MCP management remains native Hermes functionality.
* `yaml` 2.9.1 (ISC, no external dependencies) replaces ad-hoc YAML/JSON regular expressions for this boundary. Config size, alias expansion, profile paths, request deadlines and response sizes are bounded.
* Plugin operations are serialized in this server process and never retried automatically. They are **not** durable installer jobs. If the process dies or a request times out, observe native installed state before retrying. Live native installation, updates with expanded capabilities, restarts and credential setup still need the deployed Linux Hermes runtime. Catalog-name/manifest-name aliases may not offer update controls until their mapping is exposed by upstream inventory.
* The default challenge mode is `human`; `detect`, `off`, and the pre-existing legacy `solve` opt-in remain. This stage adds no new automated solving/evasion.

### Next independently verifiable stages

1. Qualify v0.22.5 against the pinned runtime's session/receipt/approval/group/browser contracts in an isolated Linux image; run `deploy/phase4-validation.mjs` before changing the digest. Adopt profile-scoped plugin operations only when the upstream endpoint demonstrably binds them.
2. Validate catalog install/enable/update/remove and credentialed model/channel flows against that runtime; finish native skill registry discovery, dependencies and updates without another installer/config owner.
3. Audit delegated task conflicts, cancellation and ownership across network loss/restarts; expand bot lifecycle and attachment workflows with migrations only for state the adapter genuinely owns.
4. Complete the remaining application/deployment security audit and whole-product responsive/accessibility review, then measure real streaming/tool latency and resource use under representative tasks.

Remaining mission work includes a complete security/deployment audit, target-release upgrade qualification, richer bot lifecycle controls, skill registry installation/updates, delegation conflict analysis, attachment workflows, accessibility testing throughout the entire application, and credentialed model/channel/plugin end-to-end validation. Do not mark these complete based on adapter tests or a mock backend.

## Persistent bot identities and inspectable coordination — October 26, 2026

This stage implements the requested editable labels, automatic personality identity updates, direct team coordination, individual exchange notices, and additional browser isolation/recovery checks. It preserves Hermes as the execution, approval, scheduling and transcript owner. No Hermes source patch or additional agent framework is introduced.

### Research and observed boundaries

The official [launch announcement](https://x.ai/news/introducing-grok-bot), [Bot 101](https://x.ai/bot/guides/grok-bot-101), [bot management guide](https://docs.x.ai/grok-bot/bots), and [collaboration guide](https://docs.x.ai/grok-bot/chat-and-collaboration) describe persistent identities, coordinator/specialist roles, visible handoffs and asynchronous messages. The collaboration guide was updated October 22. These are product behaviors, not evidence of proprietary orchestration internals.

The official launch video was located at [Introducing Grok Bot](https://www.youtube.com/watch?v=F1_0Lkp16Rc), with a 106-second public metadata result. Both the announcement's media download and the YouTube video download returned HTTP 403; the web player fetch was throttled. The video was **not watched**. Implementation decisions use the published documentation and inspected local Hermes contracts.

The official [computer guide](https://docs.x.ai/grok-bot/computer-and-apps) describes shared browser cookies between bots. HOB deliberately uses independent persistent browser profiles, following this user's explicit requirement. Separate directories, credentials and Chromium cookie databases are application isolation; the shared operating-system user and terminal are **not a security sandbox against a malicious bot**.

### Fixed defects and resulting behavior

| Reproduction / severity | Root cause | Result |
| --- | --- | --- |
| Send two unrelated relay requests to one worker; high context/correctness risk | A receiver-wide cached session accumulated every exchange | Each exchange has a UUID, a fresh native session, sender/receiver snapshots, ancestry, status and its own transcript. Replies cannot inherit another exchange's conversational context. Native per-profile memory still follows Hermes settings. |
| Ask a worker to contact a specialist; medium functionality gap | Relay rejected every worker-to-worker send | Any active bot can contact a peer. The full roster includes names, labels, stable IDs and roles; Main owns coordination. Known ancestry cannot repeat a bot or exceed eight participants. The generated helper accepts `--parent` for explicit chained handoffs and also uses the current native session when available. |
| Retry after a lost relay response; high duplicate-work risk | A random admission key was regenerated for every HTTP request | Sender-scoped request IDs deduplicate concurrent and later retries. Reusing an ID for different work is rejected. The helper prints its request ID before sending and explains how to reuse it. Ambiguous admission is recorded as unknown and never replayed automatically. |
| Restart after accepting a handoff; high observability gap | Exchange correlation lived only in memory | `exchanges.sqlite` uses indexed records, unique sender/request keys, durable writes and per-chat deliveries. Read-time reconciliation observes native run status without dispatching work. The native run journal also tracks relay admissions, so approval, clarification and stop controls address the exact receiver/run. |
| Open a bot's chat after a handoff; medium visibility gap | No distinct handoff timeline records | Each exchange appears as a small “A talked with B” row. Expand it for that request/reply, native messages/tools, errors and controls. Notices stay in their assigned conversation across refreshes; they are not copied into every new conversation. An explicit paginated archive makes earlier exchanges reachable; chat timelines bound the visible notices to the most recent 100 and disclose that limit. Routine list reads omit message/reply bodies at the database query. Known source sessions receive their own notices; otherwise the next opened chat claims the inbox notice. |
| Rename a bot or edit labels/role; medium identity drift | UI identity and native personality were unrelated | Up to eight editable labels, each up to 32 characters, persist beside the immutable profile ID. Name, labels and role sync into a marked native `SOUL.md` block, preserving authored instructions. Editor saves retain the block. Every roster refreshes after identity/lifecycle changes. Main may be renamed while its coordinator ID remains `default`. Partial sync errors are reported and remain pending for retry/boot repair. |
| Run the generated relay helper; high functionality defect | A template expanded a newline inside a JavaScript single-quoted string | The helper now uses a raw template; a regression check runs Node's syntax validator on the actual generated file. Credentials remain environment-only. |
| Switch tabs while a previous viewer attachment is pending; medium reliability defect | A superseded attach/snapshot could publish the previous tab's title/session | Attachment revisions discard superseded snapshots and page events; obsolete sessions are detached. Stop invalidates queued attachments. |
| Supply a global CDP URL at deployment; high cookie-isolation risk | An inherited endpoint can override every per-profile browser binding | Deployment removes global `BROWSER_CDP_URL` / `BU_CDP_URL` / `BU_CDP_WS` overrides; dashboard credential edits reserve those managed fields. Bot-specific managed browser bindings remain authoritative. |

The new exchange database contains adapter correlation and bounded reply previews, not a replacement model conversation database. Hermes retains the full native transcript. Distinct exchanges may run concurrently; each recipient accepts at most eight outstanding handoffs. Browser mutations continue through the existing control lease. This is not a general lock manager for arbitrary filesystem edits: bots must delegate independent work and respect ownership in their instructions.

### Operation and verification

Use the bot's pencil action to edit name, comma-separated labels and role. In chat, expand an exchange row or open **Bot exchange history**. A bot can use `node .hob/talk.mjs roster`, `send <bot> <message> [--parent <exchange-id>]`, or `status <exchange-id>`. `HOB_TALK_WAIT_MS=0` returns after admission; an asynchronous caller must check status before treating work as complete. Recurring proactive tasks continue to use native Hermes scheduled jobs, already exposed in Goals; this stage does not invent a second scheduler or claim an unattended model run occurred.

Verification covers request deduplication, direct peer exchange, cycle refusal, distinct native conversations, exact-run approval visibility, source-chat association, archive pagination, restart reconciliation without replay, ambiguous admission, preserved personality text, pending sync/retry, and names/labels/role restoration. Real Chromium tests set different persistent login cookies for the same origin in two bot profiles and verify those exact values after manager/registry restart. UI tests use the production bundle with explicit Hermes API fixtures, including separate expandable exchange notices, restored editable labels, desktop/mobile rendering and console/API error checks. Screenshots are generated in ignored `web/test-results`.

No browser can guarantee access to every site or recovery from every upstream failure. Human CAPTCHA/authentication handoff remains the supported interruption path. Live native model delegation, deployed Linux approval recovery, channel credentials and production upgrades still require the deployed Hermes environment; Docker is unavailable on this host. Changes to external profile `.env` files or runtime configuration outside HOB can override its conventions and require reconciliation. Personality/roster edits are persisted immediately; an already running model turn may need its next instruction load or the live roster helper to observe them.

Final executed results for this stage: **400 server checks passed, 2 skipped; 23 deployment checks passed; 49 web unit/service checks passed; 7 Chromium UI workflows passed.** Web lint, TypeScript/production build and `git diff --check` passed. The final full server run took 52.6 seconds; the last UI run took 11.4 seconds. These are test-suite timings, not production model/browser latency measurements. Vite still reports the existing main-bundle size warning (about 708 KB minified / 200 KB gzip).

## Plugin app grid, relay repair and native proactivity — October 26, 2026

The plugin store now merges catalog and installed apps into responsive tiles, including installed plugins absent from the current catalog. Opening a tile shows a native modal dialog with the actual publisher, description, capabilities, credential requirements, compatibility, commit/version/source metadata and safe documentation links. Install, enable/disable, reviewed-pin updates, additional-capability consent and removal use the existing native endpoints. Selecting an app does not install it. Keyboard focus is contained and restored; Escape and backdrop dismissal work; the mobile modal keeps its action footer visible.

The reported missing relay credential was an environment-boundary defect: the generated helper depended on `API_SERVER_KEY`, which Hermes intentionally strips from terminal subprocesses. Registry version 3 provisions distinct per-bot relay keys, accepts them only for active bots at the relay, and never returns them in roster/configuration views. Boot and bot synchronization write private `.hob/relay.json` files; the helper reads its own file relative to its module, so it also works outside the workspace cwd. Listener keys no longer authenticate to the relay. Existing native listener credentials remain unchanged. Synchronization failures now participate in startup backoff even when browser binding succeeded.

Synchronization refuses linked bot directories and linked or oversized `AGENTS.md` files. On Linux it pins workspace/hidden directory handles while reading and atomically replacing managed files. The deployment's intentional root alias remains supported. These checks reduce privileged synchronization hazards; they do not replace OS isolation.

### Execution ownership and recovery

- **Event wake-up:** a completed, failed, cancelled or interrupted new exchange commits its outcome and result outbox rows in one SQLite transaction. A server-owned sweep observes background runs every five seconds without an open dashboard or waiting helper. The caller and Main receive a native `bot_relay.deliver` result notification, deduplicated when they are the same bot. Main is not re-notified as the recipient of its own completed work. Old historical exchanges are not replayed on upgrade.
- **Native delivery:** follow-ups enter each bot's **Bot Chat**, through the pinned gateway's authenticated, provenance-aware FIFO. They do not reuse the receiving worker exchange's conversation, and do not silently inject a turn into the originating manually opened chat. The original chat retains its exchange notice. Result messages carry the request/result, exchange ID, bounded excerpts and the helper path for retrieving the full result. They instruct the coordinator to continue only approved outstanding work and stop if already handled.
- **Unattended recovery:** outbox state survives restart. Lost acknowledgements reuse the same 64-character native delivery ID and identical payload. Pending delivery, admitted execution and completed execution are distinct states. Retry backoff is bounded; a native ambiguous execution or permanent refusal remains inspectable rather than being replayed with another ID. Native delivery owns its own safe retry policy. Follow-up sessions are watched for ordinary approval/clarification controls. The exchange inspector shows follow-up state.
- **Heartbeat:** Settings → Automation selects an enrolled native conversation and exposes real native goal and heartbeat state. Heartbeat set/pause/resume/clear uses `command.dispatch` / `session.control`; reads use `session.control.read`. Intervals range from one minute to seven days, defaulting to fifteen minutes. Hermes owns its idle/queue priority, persistence, goal judging and timing. HOB does not install another recurring inference timer.
- **Goals:** starting or resuming a goal consumes the native `send` directive through the same canonical durable admission journal as chat. Updating goal state alone is not reported as starting execution. Lost admission responses remain fenced, and the ordinary dashboard approval controls address the native admission.
- **Scheduled tasks:** existing native cron create/edit/pause/resume/run/history controls remain authoritative. `0 9 * * *` means daily 9 AM in the bot's configured timezone; no actual recurring user task is created by opening this screen.

The wire contracts were checked against immutable upstream commit [7e9eb8d9](https://github.com/NousResearch/hermes-agent/tree/7e9eb8d9a30f4a9bb9f8ecaf816b4b0ffdf47357), including `gateway/session_bot.py`, `session_commands.py`, `session_control_actions.py`, `session_viewer_automation.py` and `hermes_cli/heartbeat.py`. The newer reference directory is not evidence of what the pinned image supports. Native errors/tickets are not logged verbatim by the bridge; result notification errors expose bounded typed reasons instead of raw provider replies.

### Verification and remaining goal work

Local verification: **414 server checks passed, 2 skipped; 24 deployment checks passed; 49 web checks passed; 9 Chromium workflows passed**. Lint, TypeScript/production build and whitespace validation passed. Additional targeted checks after the full server run cover goal admission, relay-file safety and multiline goal descriptions. Browser tests use an explicit API fixture; they do not prove a model ran. The generated relay helper was also executed as a real subprocess against a local HTTP server with both listener-key environment variables absent.

The existing container CI smoke had failed after identity synchronization because it expected `SOUL.md` to contain only authored text. It now verifies both preserved authored text and exactly one Main identity block, then checks exact persisted content across recreation. The [Linux image workflow at `e66b05cd`](https://github.com/abdlx/hob/actions/runs/40377004694) passed both web validation and the real pinned Hermes container smoke. It exercised the native terminal/helper/worker/coordinator path, a fired native heartbeat, pause, and retained settled state across container recreation. Its model endpoint uses owned synthetic credentials; this is real Hermes execution, not verification of a production provider account.

The pinned native LOCAL adapter has no legacy message handler. Its heartbeat poll checked that handler before reaching native admission, suppressing dashboard heartbeats. The image now applies one exact-source-checksum compatibility fix to move that legacy check after the native branch. Native provenance checks, scheduling, admission and execution remain upstream-owned; unknown source bytes fail the image build. `/opt/hermes/hob-compat.json` records the applied fix.

**The overall proactive-platform goal is still active.** OS-enforced separation of bot execution/browser users, image-level qualification of the new paths, and live provider/production failure-recovery verification remain. Default deployment still uses a shared OS user. The user explicitly deferred access to the deployed instance until implementation is ready; no real provider credential or live-deployment success is claimed.
