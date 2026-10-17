# Hermes integration checkpoint

Updated 2026-10-17. The full migration remains incomplete and is not production-ready.

## Product goal

Use unchanged upstream Hermes behind the custom hob dashboard. Ship one Main bot
by default; only operator-created entries become permanent dashboard bots. Each
bot owns its memory, sessions, credentials, configuration and work. Collaboration
requires explicit operator-created groups. Provide setup, learning controls and
normal operation through the custom UI.

## Source and deployment identity

The parent Git repository owns the application. The user's archived OpenClaw
sources and pre-existing moves/deletions remain preserved. No Hermes or archived
OpenClaw source has been edited by this integration. The integration milestone is
prepared for the user's requested commit/push from parent baseline
`99a7f4fabe7eeb12409eec79b7787f1befd17a11` (`testing is left`). That commit is
preserved. Deployment has not been performed; Git identifies the milestone commit
containing this checkpoint.

The imported `hermes-agent/` has no independent Git identity proven in this
workspace. The local baseline manifest covers 19,825 files; comparison found no
changed or missing baseline files and no new reference files under the same
exclusions. Its SHA-256 is:

`c85e5b64f51727857324aaca0bc28fb7f16be862c68b375a1b5b3cec9f6922d8`

This is a local source fingerprint, not proof of an upstream commit. The manifest
and comparison receipts are in the ignored verification evidence directory.

Docker extends the official multi-architecture image:

`nousresearch/hermes-agent@sha256:36099926da316742423544e055d4734777105ffe6341873af5459b957d0c2919`

The publisher registry supplied that digest. Image labels did not prove its source
commit, and the local reference snapshot has not been proved identical to it.
There is no running Docker daemon here, so image build/boot claims remain unverified.

## Implemented application seams

- `server/hermes-client.mjs`: separate authenticated loopback runtime/settings
  transports, bounded JSON/SSE, profile-bound session identifiers, redirect refusal,
  no automatic write retries, native capabilities readiness and per-profile credentials.
- `server/hermes-routes.mjs`: authenticated operation allowlist for profiles,
  native configuration/schema, credentials, models/custom endpoints, sessions,
  runs/events, approvals, steering and stop. Profile selectors are bound; managed
  deployment variables and stored-secret placeholders cannot be written as keys.
- `server/hermes-chat.mjs`: retained HTTP task/history/control translation.
  EOF does not mean success. Lost streams retain run identity/duplicate protection;
  approvals bind exact native request IDs. Canonical IDs are explicitly refused
  here if their native adapter is unavailable; there is no HTTP fallback.
- `server/hermes-canonical-chat.mjs`: production dashboard chat now creates and
  resumes native GUI sessions with `follow_profile_config`, submits through the
  owner FIFO, reads durable admission receipts, projects only UI fields and
  preserves generation-bound controls. New Conversation omits native title-as-
  identity lookup, so repeated generic titles never reopen the same session.
  Custom titles use native revision-checked metadata mutation. Native and old
  API IDs are distinct even if their underlying identifiers match. Existing API
  conversations remain read-only history with their original active task controls;
  the frontend chooses a native conversation or creates one on first use.
- `server/hermes-bots.mjs`: persistent operator roster in `.hob/bots.json`.
  Main alone is enrolled on first boot. Native directory discovery never enrolls
  another bot. Named bots receive unique API keys and independent working
  directories under `workspaces/bots/<name>` through native credential/config
  owners before activation. A bot named `main` cannot collide with Main's
  `workspaces/main`. Partial setup survives restart and requires an explicit
  operator recovery action. Revoked enrollment cannot be reactivated by an
  earlier setup operation. One application writer owns this registry.
- `server/hermes-settings.mjs`: masks inline credentials, arrays, sensitive headers
  and key previews. Stored placeholders cannot become new saved credentials.
- `server/hermes-session.mjs` and `deploy/hermes-session-bootstrap.py`: native
  session transport foundation. Bootstrap uses Hermes' committed dependency
  activation, validated owner discovery and OS-authenticated ticket client. It
  discovers only; it never starts another Gateway. Single-use tickets stay in
  private child stdout/WS subprotocols and never go to HTTP or the browser. Each
  enrolled bot gets a separate profile-scoped canonical connection. The transport
  requires the negotiated native protocol and `session_authority: true` before
  any RPC, rechecks enrollment, freezes request parameters before discovery,
  bounds requests/responses, maintains heartbeat and never retries uncertain
  writes. This transport is now wired into production startup and dashboard chat.
- `server/index.mjs`: native Hermes is the default runtime; private registry and
  per-profile transport access are always wired in production startup.
- `web/src/pages/HermesSettings.tsx`: bot selection/creation, explicit incomplete
  setup recovery, provider credentials, model selection, custom endpoint identity
  and key entry, native model-warning confirmation and config editing. Old bot's
  async settings response cannot populate another bot's editor.
- `web/src/services/hermes-settings.ts`: edited-fields-only config patches,
  prototype-safe construction, preserved placeholders, no ambiguous deletions,
  and explicit interpretation of native model confirmation results.

`server/hermes-run-journal.mjs` now persists HTTP run and native admission references in private
`.hob/runs.json` before dispatch. Accepted native run IDs survive adapter restart;
unknown acceptance remains fenced. HTTP recovery uses the original body and
idempotency key only within Hermes' advertised durable retention window and
the same credential scope. Native pending acceptance is recovered by observation
of its `input_id` and original text. If an acceptance is lost and no longer appears
in the pending projection, the adapter does not invent a lookup or replay authority:
it keeps the submission fenced while history remains readable. This is a remaining
recovery limitation. Nothing is replayed at startup. Original prompt text
is removed after admission confirmation; native stores retain normal history.
The file is bounded, refuses corrupt/hard-linked state, and fails before dispatch
when persistence is unavailable. One application writer owns this journal.

Background reconciliation performs native status reads. Native `unknown` is not
terminal and cannot grant a new turn. Resolution requires an explicit operator
confirmation bound to the displayed revision; the adapter forwards only the exact
native admission ID and execution generation. Stale stream/poll callbacks cannot
overwrite a newer submission. The journal covers custom HTTP and native submissions,
not arbitrary external clients' runs. Native pending work from another attached
viewer is also observed and fences conflicting UI input.

Approval/question maps remain presentation caches rebuilt from native controls,
not approval authority. Current prompts bind ID plus execution generation. Old
approval IDs cannot resolve a new generation. `HermesRunPanel` adds status, stop,
explicit recovery/unknown-work resolution and question-answer presentation. Its
question support now passes real native/custom-server verification. Raw API-agent
clarification remains unsupported upstream; that path is no longer used for new
dashboard conversations.

## Bootstrap and container ownership

`deploy/bootstrap-hermes.mjs` exclusively seeds absent config and reuses private
listener credentials. Corrupt credential state fails closed without rotation.
New configuration disables adoption of unrelated external CLI logins. Existing
operator config is preserved; native owners handle later migrations/writes.

The settings server starts first. `deploy/prepare-hermes-runtime.mjs` waits for
health and writes Main's listener key through Hermes' credential lifecycle before
starting the agent runtime. Process environment keys alone are ignored in routed
secret scopes; the first real-runtime check exposed this mismatch and the fix
uses upstream persistence rather than weakening isolation.

The explicit default profile is used for both services. Gateway runs with native
`--no-supervise --external-supervisor` flags; our supervisor owns restarts. Docker
preserves the stock `02-reconcile-profiles` hook outside automatic init so persisted
s6 autostart cannot create a competing Gateway. Upstream init, UID/volume setup,
package tools and privilege drop remain. This image packaging choice is still
pending actual Linux boot/restart verification.

Runtime child environment excludes application login/session and dashboard admin
credentials. This is environment separation, not OS security isolation. A local
execution backend sharing the host user can still reach sibling files/processes;
strong execution isolation is not proven by profile paths or distinct API keys.

Only custom port 3000 is exposed. New `hermes-data` storage is independent of the
old OpenClaw volume, which is neither mounted, deleted nor implicitly migrated.

## Real-runtime findings and evidence

Hermes PM provisioned supported Python 3.14 and Node 26 plus locked `web` and
`messaging` dependencies in isolated verification stores. No raw pip/uv changes
were made. The initial web-only environment lacked aiohttp; the declared messaging
extra corrected that. A disk-full verification attempt was recorded as an
environment failure, not hidden. Later verification uses an owned isolated C: store.

Native checks use synthetic credentials, temporary ports, a private test home and
an in-process deterministic OpenAI-compatible model simulation. No actual provider
account or paid model has been used. Existing unrelated port 3000 was not touched.

The completed native check passed 21 checks, including:

- Application health/setup before provider configuration; login and HttpOnly cookie.
- Native config and masked credential persistence through the custom API.
- Operator-created bot and native hot-profile reconciliation without a Gateway restart.
- Same raw session ID in two profile stores retaining distinct state.
- Custom session creation and native named-endpoint setup.
- Selecting the correct endpoint when an older endpoint serves the same model ID.
- Actual Hermes run admission/stream completion, a real `write_file` tool side effect
  in the isolated workspace, a tool-result round trip to the simulated model,
  and persisted assistant history read through the custom chat adapter.

A bare `custom` selection initially reused an older saved endpoint with the same
model. The custom UI now registers a named endpoint through the native
`/api/providers/custom-endpoints` owner before model selection. It does not copy
provider resolution logic or silently override warning/confirmation behavior.

A later live check passed 28 checks including an owned adapter-process restart
while Hermes kept an active worker, recovery of that same run ID, refusal of a
duplicate task, canonical completion after restart and persisted history. Only
the adapter was restarted in that proof (the verifier opts its app process into
restart); this is not certification of the production container's all-service
shutdown/restart policy.

The expanded question test then FAILED: no native clarification prompt appeared
for an ordinary API-created session. This failure remains visible. Source confirms
`gateway/platforms/api_server.py::APIServerAdapter._create_agent()` omits
`clarify_callback`, and `tools/clarify_tool.py::clarify_tool()` returns unavailable
when no callback is supplied. The HTTP endpoints can project/control canonical
prompts, but their presence does not make raw API agents interactive.

The replacement seam is the canonical native session interface, without a Hermes
core patch. `gateway/run_api.py` owns a separate local HTTP/WS listener bound to
the Gateway's session authority; its ticketed `/api/ws` dispatches through
`gateway/session_controls.py::AuthorityConnection` and managed workers.
`agent/managed_worker.py` installs `controls.clarify`. The standalone settings
`serve --isolated` socket must not be used as a fallback legacy session writer:
`tui_gateway/ws.py` falls back to its old dispatcher without an attached authority.
The production adapter now discovers and authenticates that actual listener and
routes dashboard conversations through it.
Do not fake this by renaming every session to the special singleton `Bot Chat`.

A separate native session proof PASSED 25 checks with the real unchanged local
runtime and the deterministic model. In addition to setup/profile checks, it
verified separate Main/named-profile authorities, canonical `session.create`,
durable `prompt.submit`, an actual managed-worker clarification callback, pending
question recovery after closing and reopening the viewer, exact-generation
`clarify.respond`, durable terminal admission receipt, the selected `Report`
answer in the model's parsed tool result (not just a tool-call ID), and persisted
conversation history. The receipt is `evidence/live-session-proof.json` under
the owned C: verification root. This tests the native transport directly; it
was followed by the full custom-server migration proof below.

The full custom-server/native proof now PASSES 31 checks, repeated after production
wiring and native readiness were added. It enters through the authenticated custom
HTTP routes rather than invoking the bridge directly. It verifies a real tool side
effect, adapter restart while the native worker remains active, the same durable
admission ID after restart, duplicate rejection, canonical completion/history,
question projection into `/api/sessions/<key>/run`, and the actual selected answer
in the model's parsed tool result. Its receipt is `evidence/live-canonical-chat-proof.json`.
The model is deterministic; this is not a real-provider or Linux lifecycle claim.

Contract details that the chat migration must preserve: native submissions use
`submission_id` (not create-time `request_id`); `session.create title=` resolves
an existing titled conversation and must not accidentally reuse a generic title
for every New Conversation action. Native snapshots can contain detailed policy
inventory, so project only UI fields rather than proxying complete snapshots.

The live verifier and private receipts are under ignored test evidence directories;
they are development evidence, not a shipped production certification. Test child
cleanup targets only PIDs returned by that verifier's own spawn calls. Windows
forceful cleanup causes native unclean-exit warnings on subsequent test restarts;
it does not prove production graceful shutdown.

## Dashboard actions and concurrent conversations

The Hermes runtime now selects native dashboard components for Goals, Library,
Workshop, Daily goals, Browser and Agent identity. The old OpenClaw components
remain in the legacy branch; they must not mount while Hermes is selected or
while the initial runtime/bot is unresolved. Settings already selects its native
Hermes component. Changing an error string is not a migration.

`server/hermes-workspace.mjs` supplies an authenticated, allowlisted adapter for:

- Native cron list/create/edit/pause/resume/trigger/history/delete. Delivery is
  local for tasks created by this UI. Per-item access first checks membership in
  the selected profile's job list because the upstream desktop endpoint treats
  `profile` as an owner-discovery hint. This preflight is not an atomic upstream
  ACL or an OS tenant boundary; hostile concurrent manipulation of native state
  is outside the logical-profile guarantee.
- Native skill inventory/content/create/edit/toggle, and canonical
  `command.dispatch` restricted to `/skills pending|diff|approve|reject`. Review
  uses an exact profile-bound native conversation. Decisions require a specific
  proposal ID and explicit confirmation; bulk approval and arbitrary commands
  are not exposed. Native chat diffs retain Hermes's truncation notice.
- Native fingerprinted memory entries, edited/deleted through
  `agent.learning_mutations` and the locked, budget-enforcing memory store.
- Native profile SOUL reads/writes. Named profile directories are never renamed
  as a cosmetic identity action. Native operator skill/SOUL editors have no CAS
  precondition; the UI does not claim otherwise.
- Workspace listing and bounded file downloads through native managed-files
  endpoints. The adapter pins each bot's assigned dashboard workspace, resolves
  paths locally before forwarding, excludes sensitive files and cross-bot
  links, and accepts Windows redirection of the trusted deployment root.
  Remote provider filesystems and larger/streaming downloads remain future work.
- Browser toolset status and an explicit agent browsing request through chat.
  Hermes's tools own browser execution and approvals. This is not a transplanted
  OpenClaw remote-tab controller or a claim that a browser action already ran.

Workshop has an explicit control to enable native `skills.write_approval`.
Existing configuration is not silently rewritten. Hermes's own defaults and
limitations still apply, including the skill gate's import-error fail-open
fallback; this integration does not constitute a new Trust Engine.

`ConversationWork` and captured profile API clients allow concurrent bot turns,
independent replies/errors/busy state and per-conversation unsent drafts.
Conversation creation disables sending until native creation completes. Distinct
React keys for controls/composer prevent orphaned run panels across bot switches.
The prior browser concurrency proof has seven positive assertions and one
indeterminate timing observation; a later atomic DOM sample verified creation
disable behavior. Do not describe that receipt as zero failed observations.

The native workspace verifier completed 44 checks against unchanged local Hermes
and a simulated provider, including real scheduled execution/history, skill
create/edit/toggle, durable fingerprint-changing memory edits and native pending
reads. Its first run caught a Windows root-alias rejection, which was fixed and
covered by a junction regression before the successful rerun. The expanded
verifier then completed 51 checks, including a real managed-worker `skill_manage`
call that staged a skill, kept it absent from active inventory, exposed its diff,
refused an unconfirmed approval and activated it only through an explicit native
approval. This proves that flow, not every background-learning path.

The rebuilt dashboard passed nine browser checks against that real native owner:
bot selection remaining on the workspace page, goal creation/pause, file download,
pending reads, memory edits, SOUL edits, native browser configuration and
cross-bot library separation. Artifacts are the ignored
`ui-native-workspace.json`, `ui-native-workspace.jpg` and `ui-native-goals.jpg`.
The browser test does not prove actual browser-tool execution. The verifier exited
with code 0 after its private finish endpoint was invoked; only its owned local
processes and test tab were closed. No production deployment was restarted.

## Guided model, tool and channel setup

`server/hermes-setup.mjs` is a second explicit adapter surface, under the same
application login/origin checks and enrolled-profile credential binding. It uses
the native model inventory, tool/provider configuration, messaging-platform and
OAuth owners. It supplies no arbitrary RPC, shell command or upstream URL proxy.
Model choices and account/channel status are projected to omit inline credentials,
token fragments, external disconnect commands and managed listener fields.

`HermesModelPicker` reads native provider choices and per-provider model suggestions.
Choosing a provider fills an unactivated form; `Select model` retains the existing
native warning-confirmation contract. Provider changes clear the secret entry and
credential-name hint instead of carrying another provider's credential authority.
Settings initially selects the current chat bot; its explicit configuration
selector can configure a different bot without moving an in-flight chat.

`HermesIntegrations` adds toolset enable/disable, provider matrix/credential forms,
per-capability web provider selection and explicit native dependency setup. Enabling
a toolset requires confirmation because Hermes can install dependencies as part of
that action. Starting an install is never displayed as installation completion.
Native post-setup keys must belong to that toolset's own provider matrix.

Messaging setup reads each native platform's declared fields, displays only
credential presence and non-secret allowlist IDs, and separates field persistence
from confirmed channel enablement. Managed API/webhook listener cards cannot be
mutated through this surface. Saving/enabling does not assert a live connection;
the native status check owns that observation.

Provider accounts expose supported native device-code sign-in, profile-bound poll
and cancellation, and confirmed disconnect. The UI never receives access/refresh
tokens. Profiles that require their provider's external CLI are explained, not
executed by a shell workaround. Actual vendor OAuth completion has not been run;
its adapter contract is covered with synthetic sessions. Native status/cancellation
must not be interpreted as proof that an already-completed credential was revoked.

The real guided-setup verifier passed 66 checks (the prior 51 plus 15 native setup
checks), including real native provider/model catalogs, tool disable/enable,
credential metadata and channel fields/status. No messaging channel or external
OAuth account was connected, and no real model provider was used. An initial
browser model-selection observation hit the owned fixture's 10-minute shutdown;
the process exited code 0 and the environmental observation was retained. The
remaining browser selection check then passed in a fresh owned fixture, without
replaying the uncertain write against the stopped instance. Ten positive browser
checks now cover the guided catalog/model selection, device/external-flow display,
tool enable confirmation and native inventory, tool credential presence/cleared
input, per-capability search selection, channel allowlist persistence and saving
without enablement. Their ignored receipt is `ui-guided-setup.json`, with
`ui-guided-model.jpg` and `ui-guided-tools.jpg`. The first environmental observation
is preserved in `ui-guided-setup-first-observation.json`.

The fresh browser fixture's process handle and listeners were absent after a host
continuation. Its final runtime receipt was not found; do not claim a clean exit
for that fixture or use it as graceful-shutdown evidence. The earlier 66-check
native fixture did return exit 0 and has its receipt. Browser results are the
observed rendered outcomes, not an inference from backend test totals.

## Explicit native groups and dashboard routing

`server/hermes-groups.mjs` uses the native canonical `groups.*` controls through
the authenticated session bridge. A fresh installation creates no group. An
operator selects two to six enrolled bots explicitly. Native roster membership
is frozen; changing membership requires a new group. Main coordinates the room;
only the selected native profile homes are registered. Each member runs in its
own hidden room session. Private chat transcripts are not copied into the room.
Group actions include shared messages/history, rename, stop, explicit disband
and current-generation approval/recovery controls. Approval cards display the
full command. Bot removal waits for native room cancellation before revocation.
Disband retains read-only native history. This remains logical profile separation,
not an adversarial process or filesystem security boundary.

The initial native group receipt contains 32 passing checks and supervisor exit
0. The expanded portable group-control receipt contains 59 passing checks and
supervisor exit 0. It proves real member workers, two replies, independent
canonical-memory injection, absence of private transcript markers, adapter restart
while work continues, native approve-once/deny with full command display, stale
decision refusal, in-flight stop without late publication, active-member removal
waiting for cancellation, and retained read-only group history. Seven positive
built-browser checks cover explicit membership, both member replies, rename, idle
stop and disband confirmation/cancel. The first expanded fixture used PowerShell
in a Bash terminal and failed; the preserved failure was corrected by choosing
a harmless portable command, without changing approval policy. Full runtime
restart remains unverified. Native result checking logs a `RoomActor`
schema mismatch for `actor.profile`; usable results were returned, but upstream
contract alignment needs verification. Hermes source was not changed to hide it.

`RuntimeProvider` now resolves the authenticated `/api/runtime` before mounting
the dashboard. Settings, workspace, browser, identity, goals and run controls
share that runtime identity rather than optional `agentRuntime` metadata. Missing,
unknown or unreachable runtime responses display a retry/error and cannot choose
OpenClaw implicitly. After native route dispatch, the Hermes server rejects stale
legacy routes with `DASHBOARD_RUNTIME_MISMATCH` before any OpenClaw RPC. This does
not implement legacy APIs by renaming errors; native adapters own active controls.
An existing deployment must rebuild/restart both app and frontend to use the fixes.

Eight saved browser observations against a rebuilt real-runtime fixture cover
the corrected routing for Settings, goals, Library, Workshop, memory/SOUL and
browser configuration. The fixture's process handle/listeners were missing after
host continuation and its final receipt was not found. These observations do not
prove graceful shutdown.

## Native MCP setup

`server/hermes-setup.mjs` routes MCP inventory/create/enable/test/remove to native
Hermes owners with the selected bot bound to each request. Inventory omits URLs,
argument values and credentials. Input rejects managed environment variables,
stored-secret placeholders, profile overrides and invalid transports. Creation,
enable, probing and removal require explicit confirmation; disabling does not
delete setup. Probe failure messages do not echo upstream secrets.

`HermesMcpSettings` supplies HTTP/SSE with optional bearer authentication and local
stdio with argument/environment fields, masked credentials and separate review
confirmation. The native probe lists tools. Existing sessions may need restarting
for changes. MCP OAuth onboarding remains incomplete. Local executables use the
Hermes host and are not isolated by this form.

The real MCP SDK fixture saved 71 passing checks before its UI wait, including
native HTTP initialization/tool listing with a scoped synthetic bearer, isolated
bot configuration, explicit enable/remove and the 59-check group-control flow.
The first environment lacked optional MCP dependencies; its failed receipt is
preserved. A separate frozen environment provisioned by Hermes PM with the MCP
extra supplied them. A Windows long-path failure during provisioning was also
retained before the shorter destination succeeded. No Hermes source was edited.
After host continuation, the final fixture's process handle and listeners were
missing. Its checkpoint has `completed=false` and `awaitingUi=true`; clean shutdown
and a rendered MCP form/probe round trip are not claimed. The SDK and adapter
checks recorded before that wait passed, using only an owned local endpoint.

## Verification

Commands used explicit supported Node 24.16.0 rather than the machine's default
unsupported Node 25.3.0.

| Check | Current result | Scope |
| --- | --- | --- |
| `node --test deploy/*.test.mjs server/test/*.test.mjs web/tests/*.test.mjs` | 202 passed, 0 failed/skipped | Bootstrap, native chat/recovery, profile concurrency, groups, MCP/workspace/setup operations, runtime selection, security boundaries and legacy regression contracts |
| `npm run build` in `web` | Passed | TypeScript and production Vite build; nonfatal plugin timing notice |
| `npm run lint` in `web` | Passed, no warnings | Frontend source |
| Standalone Compose config with public template/synthetic values | Passed | Parsing only; no daemon/build/start |
| Native Hermes + custom server + simulated model verifier, recovery expansion | 28 checks passed | Real control plane, active-worker/adapter restart, run/tool/history; simulated model |
| Further expanded native clarification check | FAILED: prompt was not projected for a raw API session | Source-confirmed missing clarification callback; canonical session bridge required |
| Separate native canonical session verifier | 25 checks passed | Real profile-scoped native owner, question/answer, viewer disconnect/reconnect, durable receipt/history; simulated model |
| Full custom-server canonical chat verifier | 31 checks passed, repeated | Real native chat/tool/question through custom routes, adapter restart, durable admission/history, no duplicate work; simulated model |
| Native workspace verifier | 44 checks passed | Real native schedules/execution/history, skills, file reads, memory edits, personality and pending-review reads; simulated provider |
| Expanded native workspace/staging verifier | 51 checks passed | Includes real agent-generated staged skill, native diff and explicit activation; simulated provider |
| Built dashboard browser verification | 9 checks passed | Native goals/library/pending/memory/SOUL controls, browser status and bot scoping; screenshots saved |
| Expanded native guided-setup verifier | 66 checks passed | Real catalogs, native tool settings/credential storage, channel allowlists and disabled status; no external account/channel connection |
| Built guided-setup browser checks | 10 positive checks; first timing/environment interruption retained | Native catalog/model save, tool confirmation/credential/provider writes and channel allowlist/status; no real vendor OAuth |
| Expanded native group verifier | 59 checks passed; supervisor exit 0 | Separate workers/memory, private history excluded, adapter restart, approvals/denial, stale decisions, in-flight stop, active-member removal and retained history; simulated model |
| Built group browser checks | 7 positive checks | Explicit two-bot creation, independent member replies, rename, idle stop and disband confirmation/cancel |
| Rebuilt runtime-routing browser checks | 8 saved positive observations; final runtime receipt missing | Native actions selected without optional bot metadata; no graceful-shutdown claim |
| Native MCP SDK fixture checkpoint | 71 checks passed before UI wait; final receipt incomplete | Real SDK initialize/tool listing/auth, per-bot config and group controls; rendered MCP round trip and clean exit unverified |
| Source fingerprint comparison | 19,825 unchanged files; none added under exclusions | Local reference source integrity |

The former full-server baseline had two source-reading failures pointing at moved
OpenClaw schemas. Those obsolete source comparisons were replaced with behavioral
forwarding/rejection tests; assertions were not skipped or disabled.

Tests do not establish real vendor compatibility, adversarial OS isolation,
container lifecycle, complete setup UX, complete group control coverage or full runtime recovery.

## Remaining requirements — keep full goal active

1. Prove Linux image build/boot/restart, initializer ordering, privilege drop,
   capabilities, browser sandbox, graceful stop, backup/restore and candidate upgrades.
2. Finish interactive chat coverage on the now-connected canonical owner: verify
   actual dangerous-command approval, learning hooks, and full runtime restart.
   Preserve HTTP task recovery. Finish native unknown-acceptance lookup, retention/cleanup policy,
   pagination, partial-output recovery, attachments and steering. Concurrent bot
   switching/streaming and unsent draft isolation have now been browser-verified.
3. Expand verification of the implemented native groups with full runtime restart
   and actual provider tasks. Tool approval/denial, in-flight cancellation and
   active-member revocation now have real native verification. Preserve
   native bounded discussion, room sessions and owner/generation checks. Resolve
   the observed native `RoomActor` result-schema mismatch through compatibility
   testing or an upstream fix rather than editing the reference runtime.
4. Finish connector/channel setup, larger/remote filesystem artifacts and richer
   browser observation/control. Goals, Library, Workshop, memory entries and SOUL
   now use native Hermes owners and have browser verification. Add real rejection,
   concurrent proposal review and background-learning coverage beyond the proven
   staged-create/explicit-approve path. Keep legacy OpenClaw RPC components out of
   the Hermes render branch.
5. Finish setup beyond the native catalog/tool/channel/device-flow forms now added:
   QR onboarding, MCP OAuth/external-memory configuration, richer model/backend controls,
   learning history and actual vendor device-login verification. External CLI-only
   OAuth flows remain an upstream interface limitation; do not simulate support.
   Complete rendered MCP create/probe checks against a live owned endpoint; the
   backend SDK proof does not substitute for that UI verification.
6. Verify actual API-turn learning behavior and persistence. Memory/skill evolution
   is not model training or a guaranteed improvement in quality.
7. Add browser-rendered end-to-end checks and an actual provider conversation/tool
   task when credentials are deliberately configured. Review the whole scoped diff
   while preserving user changes before making any release commit/deployment.

These gaps prevent completion. Adapter tests and the successful local simulation
must not be used to claim that the complete product is finished or production-ready.
