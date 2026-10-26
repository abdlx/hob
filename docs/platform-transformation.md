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
