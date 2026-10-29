# HOB audit remediation plan

Prepared: 29 October 2026. Repository baseline: `8326bf6c` on `main`.

This plan covers all 22 product findings, the benchmark's evidence gaps, and the HOB infrastructure risks raised in the accompanying assessment. The user subsequently requested HOB naming and implementation in this session, without engineering-day estimates. See [the session status](audit-session-status.md) for implementation and validation evidence. This plan does not certify the deployed application or authorize benchmark spending, production configuration changes, or external actions.

## Outcome and order

Deliver an assistant whose actions remain within the selected bot's authority, whose results survive restarts, and whose controls explain what the runtime will actually do.

Work in this order:

1. Establish the deployed baseline and prove security and execution boundaries.
2. Repair result delivery, browser reliability, cancellation, and resource limits.
3. Complete native memory/skill decisions, scheduling, and everyday navigation.
4. Validate on real devices and the deployed Linux image, then expand capability testing.

UI work can proceed alongside the boundary investigation. Broader autonomous operation remains gated on the boundary and recovery evidence.

Keep Hermes as the owner of sessions, scheduling, memory, skills, and execution. Extend HOB's narrow adapters and existing browser broker. Do not create a competing scheduler, memory database, browser owner, or task orchestrator to work around a missing native capability.

## Evidence and baseline before this session's implementation

The supplied benchmark has 12 cases, one attempt per case, with three cases in each capability area. Recalculation of the CSV agrees with the reported median turn times: reasoning 6.47s, coding 4.40s, browser 75.16s, and research 28.84s. These are small-sample turn timings, not production latency commitments. Browser timings range from 47.82s to 135.73s.

The coding assertions were executed by a separate evaluator. Browser evidence establishes the requested final screenshots, not the full action path. Research earned 9/9 points under its original narrow rubric while W03 contains an additional source-description error. Preserve both facts. No competitor was tested.

The standalone source files match their copies in the stakeholder ZIP. The slide deck and executive PDF summarize the same audit; they are not independent corroborating tests. The benchmark did not freshly retest or fix the 22 UI findings.

The latest repository patch changes the starting point:

| Finding | Repository evidence | Starting status for this plan |
| --- | --- | --- |
| U06: unmatched conversation search | `ChatsDrawer.tsx` now shows no-results text and Clear search; browser regression exists | Implemented; deployment retest required |
| U07: initial tablet panel | `ChatContext.tsx` now initializes the inspector closed below 1024px | Implemented initial-state fix; tablet/orientation coverage remains |
| U09: dock highlighting | `MobileDock.tsx` follows the actual route; browser tests cover navigation and Back | Implemented; deployment retest required |
| U12: chat input size | `ChatComposer.tsx` uses 16px text on mobile | Partial coverage; other inputs and actual iOS behavior remain unverified |
| U14: voice | The current composer has no microphone control | Recheck the stale dead-control report; working voice is still an unimplemented capability |
| Adjacent provider issues | Saved-key reuse, credential metadata loading, confirmed saves, and sidebar model selection were repaired | Keep these regression tests when changing settings/navigation |

Previously reported local verification was 53 web tests, 443 passing server tests with two skipped, and 26 browser tests, plus build/lint. This is useful regression evidence; it does not prove live provider authentication, Linux OS isolation, TLS configuration, or the deployed Hermes API contract.

Existing code already has browser lease/bypass, browser persistence, isolation, and recovery tests. Reuse them and fill deployment coverage gaps rather than assuming those systems have no implementation. The ignored `hermes-agent/` reference directory does not establish the API contract of the pinned deployed runtime.

## Session execution order

The user has requested implementation in this session. Engineering-day estimates and calendar milestones are removed. Work proceeds by dependency, with verification after each meaningful batch.

| Pass | Scope | Completion evidence |
| --- | --- | --- |
| 1 | Canonical hob naming and upgrade migration | Source inventory, compatibility tests, build and configuration checks |
| 2 | All product/UI findings and authoritative native adapters | Per-issue regression and honest unsupported states |
| 3 | Artifacts, memory/skills, scheduling, language, voice, recovery and resource limits | Native contract tests and end-to-end fixtures |
| 4 | Security, isolation, performance and expanded evaluation | Available local/deployment evidence with unavailable external/device checks explicitly recorded |

## Work packages beyond the 22-item UI tracker

### A. Deployed security and isolation evidence

Owner: platform/backend, with an independent reviewer. Start immediately.

1. Record application commit, image digest, pinned Hermes revision, configuration mode, supported native capabilities, and storage ownership. Check both the default and intended isolated deployment modes.
2. Validate the actual HTTPS/proxy path, certificate trust, cookie attributes, login/logout/session expiry, cross-origin mutation rejection, and unauthenticated HTTP/WebSocket rejection. Test through the deployment front door, not only a local mock.
3. Use two synthetic bots with distinct canary credentials, memories, workspaces, browser cookies, and files. Attempt cross-profile access through HTTP APIs, terminal execution, native tools, file/media downloads, browser sockets, and shared/messaging surfaces. Test deliberate sharing separately from private state.
4. In the intended Linux isolation mode, verify OS-user/container and filesystem boundaries. Profile routing under one OS identity must not be described as protection against terminal-level file reads. If shared mode is retained, document its trust assumptions and do not claim an isolated-hosting release.
5. Revoke a bot while work and sockets are active; verify that new admissions fail and that in-flight control follows the defined native revocation semantics. Exercise restart with a revoked profile present.

Acceptance: every declared forbidden-access fixture is denied on the candidate deployment. Logs and error responses contain no secret values. Any unexplained boundary failure blocks the isolated/production release scope until repaired and retested.

Reuse `server/test/hermes-isolation.test.mjs`, browser/auth route tests, `deploy/isolation-proof.py`, `deploy/isolation-acl-test.py`, and the deployment validation workflow. Confirm which tests actually run on the candidate's Linux environment; a platform skip is outstanding evidence, not a pass.

### B. Browser broker, fallback paths, and latency

Owner: browser/backend, supported by the agent integration owner. Instrument in the contract pass; repair in the implementation pass; harden through the verification pass.

1. Capture one correlated trace from turn admission through model calls, browser startup/connection, tool admission, page/action waits, verification, artifact publication, and final response. Record warm/cold state and errors without recording secrets.
2. Reproduce B01-B03 using the exact deployed Hermes tool chain. Establish whether the reported high-level integration failure exists and where a fallback is selected. An assistant's claim about direct CDP is a lead, not proof of a bypass.
3. Require every supported tool and raw-CDP mutation path to pass the existing broker's authorization, selected-bot ownership, and human-control lease. Unknown effectful commands must not obtain authority through an alternate transport.
4. During human takeover, attempt navigation, scripting, keyboard/mouse input, new targets, and other supported mutation paths. Verify the page remains unchanged by the agent until handback. Confirm legitimate observation and operator input still work.
5. Test active-tab following, closing the watched tab, persistent logins, browser crashes/restarts, lost viewers, and reconnect storms. Repair waits and integration faults before attempting latency optimizations.
6. Run each of the three fixtures ten times cold and ten times warm: 60 runs per build. Compare the baseline and candidate with the same model/tool configuration and end-to-end timing definition. Keep failures and timeouts in the report.

Acceptance: all mutation paths honor the lease and bot identity; persistence/reconnect scenarios pass. Freeze performance thresholds after the repeated baseline in the contract pass. An initial proposed product target is a warm simple-action median at most 30s and p95 at most 60s, including the complete turn and fixture waits. Treat these as proposed targets, not measured results or an existing SLA.

Reuse `browser-policy`, `browser-lease`, `browser-takeover-bypass`, `browser-gateway`, `browser-pipe`, `browser-load`, and `server/e2e/hermes-tools-e2e.py`. The latter requires the actual Hermes tool chain and is separate from ordinary `npm test`.

### C. Cancellation, recovery, idempotency, and spending

Owner: native adapter/backend. Feasibility in the contract pass; delivery by the implementation pass; fault injection by the verification pass.

1. Define observable states for admitted, running, waiting for approval, stopping, completed, failed, and unknown outcomes. Keep native receipts and run identity authoritative.
2. Inject failures before admission, after admission but before acknowledgement, mid-stream, during approval, and around worker/server restart. Observe an uncertain result before retrying; never interpret EOF as completion or replay a write blindly.
3. Test repeated submits, stop requests, scheduled triggers, and resume requests against the native idempotency contract. Verify one admitted action in each supported fixture. Do not promise universal exactly-once external effects when the remote result is unknown.
4. Inventory native limits and usage signals before adding controls. Define per-run and per-bot limits for model/tool calls, elapsed time, concurrency, and tokens or reserved spend where the provider exposes them. Charge delegated/background work to the originating budget.
5. Enforce limits at the authoritative admission/execution boundary, including after restart and concurrent calls. A dashboard estimate or warning alone is not a hard stop. Separate conservative reservations, reported usage, and later provider billing.
6. Where the pinned runtime cannot enforce a required cap or expose reliable usage, record the missing contract and keep the affected autonomous mode restricted. Do not invent a second execution owner to simulate enforcement.

Acceptance: supported duplicate/unknown-result fixtures produce no blind replay; stop acknowledgement and actual stopping are distinguishable; no new effectful admission proceeds after a tested cap is exhausted. Results identify any in-flight request that cannot be cancelled and any cost that remains unmeasured.

### D. Durable artifacts and Library delivery: U21

Owner: backend/artifacts + frontend. Depends on A's file-authorization contract and C's run identity.

1. Trace normal agent, scheduled, delegated, and scratch-generated outputs to their actual owners. Preserve the existing per-bot workspace Library and native file ownership.
2. Define a result manifest or native equivalent: bot, conversation/run, artifact identity, relative approved path, format, size, checksum, publication state, and retention policy. Add metadata to existing storage where possible.
3. Give supported final outputs a deliberate publication path into the authorized workspace/artifact store. Stage writes and publish atomically; make repeated publication idempotent. Do not expose arbitrary scratch directories or all host files to make Library listings work.
4. Report pending/failed publication honestly. A success message must link to the durable result. Show download, preview limitations, retention, and recovery clearly; preserve the original output if promotion fails.
5. Test authorization, traversal, links, secret exclusions, interrupted publication, storage-full behavior, retention, and backup/restore. Cover worker restart, application restart, and a fresh authenticated session.

Acceptance: 20/20 supported synthetic outputs reopen with the correct content/checksum after the restart and restore fixtures; unauthorized and sensitive paths are refused. Keep U21's original classification: a delivery/scope gap is not proof that source data was lost.

### E. Effective permissions and native review: U17, U18, U19

Owner: native adapter/backend + frontend. Discover supported APIs in the contract pass, before budgeting the full UI.

1. Build a contract matrix for the pinned runtime: read pending items, retrieve exact diff/preimage, identify revision/version, decide once, reject stale decisions, and inspect history. Separate built-in memory, external memory providers, agent skill writes, operator edits, and ordinary tool approvals.
2. Resolve effective policy using authoritative runtime semantics. Display the effective value, explicit/inherited source, bot/provider scope, and whether an existing run has adopted a configuration change. Do not infer consent from absent configuration or replace unknown defaults with a hard-coded answer.
3. Replace manually entered proposal IDs with a selectable queue and searchable/paginated skills. Bind detail and decision requests to the same bot, item, revision, and authorized operator.
4. On confirmation, send a native decision with its concurrency/idempotency requirements; reconcile the native result. Handle concurrent reviewers, changed/deleted items, reconnects, and expired sessions without applying a stale diff.
5. Expose memory edit/forget/history and rollback only where native semantics support them. Unsupported rollback remains documented; it is not simulated by overwriting files behind the runtime.
6. If the deployed runtime lacks a required memory decision API, leave U17 blocked, provide an honest unavailable state, and pursue a narrow upstream-compatible API change or separately validated runtime upgrade. A fake queue or a link to another tool does not close U17.

Acceptance: every seeded decision targets the correct bot and version; unauthorized/stale decisions are denied; decisions have an audit record and survive refresh. Effective-policy fixtures match the execution owner, including inheritance, overrides, restart, and resume. No silent policy escalation.

### F. Scheduling and timezone behavior: U15, U16

Owner: scheduler/native adapter + frontend. Native parser feasibility in the contract pass; validation by the implementation pass; lifecycle evidence by the verification pass.

1. Use Hermes's authoritative scheduler/parser. Validate create and update on the server before persistence; client hints improve UX but do not establish validity. If a validation-only operation is unavailable, determine a compatible native contract rather than creating trial jobs.
2. Offer common schedules, advanced expressions, an explicit IANA timezone, and a next-run preview generated with the same semantics as execution. Explain interval versus wall-clock schedules.
3. Cover malformed expressions, impossible dates, invalid zones, past one-time dates, interval bounds, DST gaps/overlaps, pause/resume, missed runs, native delivery rules, and restart.
4. Use the authoritative job/run identity and receipt contract for duplicate-trigger and retry handling. Preserve the selected bot, approvals, and budget when scheduled work runs unattended.

Acceptance: invalid fixtures return a useful error and create/update no job; valid fixtures match the preview and declared DST/misfire semantics. Test exactly-once admission where supported and report unknown external effects separately.

### G. Phone, tablet, accessibility, onboarding, and output rendering

Owner: frontend + UX/device QA. Most product fixes by the implementation pass; real-device acceptance by the implementation pass.

Use a shared navigation schema for desktop, mobile dock/More, headers, and sidebar actions. Make global Settings discoverable within two taps from phone home and from an open conversation. Preserve bot scope and unsaved settings drafts. Agent-side model settings are useful, but they do not replace global Settings.

Use the 22-item matrix below as the acceptance list. Test at 320, 375, 390, 768, 820, 1024, and 1440 CSS pixels; include orientation changes, browser Back, fresh login, panel persistence, keyboard-only use, zoom/reflow, and a screen-reader pass. Add actual iPhone Safari and Android Chrome checks; a desktop emulation is not proof of mobile keyboard or microphone behavior.

For media, normalize to a safe source identity per message and bot. Deduplicate equivalent image representations across Markdown, MEDIA directives, and attachments without collapsing distinct artifacts or breaking text, alt text, loading, retry, and error states.

### H. Language consistency and voice: U20, U14

Owner: agent/native integration + frontend; audio/backend support for voice.

For language, apply a clear user preference to replies and titles through supported native configuration/hooks. Keep it scoped to the bot/conversation as appropriate. Include Roman Urdu, English, mixed-language text, short ambiguous greetings, explicit overrides, and unrelated-project isolation. Do not silently rewrite historical titles; offer an explicit correction path. Target at least 38/40 labelled locale fixtures and respect an explicit override in every fixture.

For voice, distinguish removal of an unwired control from delivery of a working feature. Design the recording/transcription flow after HTTPS, supported provider capabilities, credential scope, cost limits, and retention are established. Support explicit permission, visible recording, stop/cancel, transcript editing before send, denied permission, unsupported devices, offline/error states, and clear audio retention behavior. No recording or upload begins before the relevant user action and consent.

Acceptance for delivered voice: 20 approved short audio fixtures produce editable transcripts; cancellation and denied permissions stop capture/upload. Define a transcription-quality rubric before testing rather than claiming that any returned transcript is accurate. If voice is deferred, keep U14's capability scope open and show honest availability.

## Complete 22-item product coverage

Statuses below are planning classifications from the current source inspection and prior patch verification, not a fresh deployed audit.

| ID | Finding and current disposition | Planned work and acceptance | Phase / owner |
| --- | --- | --- | --- |
| U01 | Raw conversation timestamps; still rendered directly in the drawer | Use readable locale-aware dates and full timestamp tooltip; long titles/dates do not collide | the implementation pass / frontend |
| U02 | Duplicate image sources; no message-level deduplication found in inspected renderer | One image for equivalent source per message; preserve distinct files and retry/error behavior | the implementation pass, harden the implementation pass / frontend + artifacts |
| U03 | Search scope remains unclear in primary navigation | Label the actual conversation-search scope consistently; implement global search only as separately defined scope | the implementation pass / frontend + UX |
| U04 | Search auto-focus not implemented in inspected drawer | Focus search when opened; avoid stealing focus on subsequent updates | the implementation pass / frontend |
| U05 | Escape/focus restoration missing in inspected drawer | Dismiss with Escape, contain keyboard focus appropriately, return focus to the opener | the implementation pass / frontend |
| U06 | Empty-search state implemented in `8326bf6c` | Retest no matches and no conversations; Clear search recovers; distinguish loading/failure from empty | the contract pass retest / QA + frontend |
| U07 | Initial-state fix implemented below 1024px | Verify 768/820px login, rotate, resize, close/back, and session restoration with chat reachable | the contract pass retest; the implementation pass devices / frontend + QA |
| U08 | No Settings entry in the dock; directory has a settings route, discoverability unverified | Shared Settings/More route within two taps from home and open chat; test models/tools/memory flows | the implementation pass / frontend + UX |
| U09 | Active-dock fix implemented in `8326bf6c` | Recheck Workshop/Goals/Library, history, same-tab Bots, and sidebar navigation in deployment | the contract pass retest / QA |
| U10 | Touch-target finding carried forward | Inventory controls; target 44x44 CSS-pixel touch areas with spacing; record a separate accessibility assessment | the implementation pass; devices the implementation pass / frontend + QA |
| U11 | `web/index.html` still restricts zoom | Remove restrictive viewport settings; verify zoom/reflow, dialogs, dock, and keyboard layout | the implementation pass / frontend + QA |
| U12 | Mobile chat input is 16px; remaining input/device scope open | Review text inputs in chat/settings/search; actual iOS focus/keyboard test without unwanted zoom or obscured input | the implementation pass / frontend + device QA |
| U13 | 1024px uses the desktop inspector; width contention needs retest | Collapse optional pane based on available content width; preserve deliberate user state and readable chat/composer | the implementation pass / frontend + UX |
| U14 | Dead microphone report needs retest; current composer has no microphone | Close dead-control scope only after verification; deliver real consent/transcription flow or explicitly defer voice capability | Availability the implementation pass; capability the verification pass / audio + frontend |
| U15 | Adapter checks schedule text but does not establish parser validity | Native server validation before persistence; invalid fixtures produce no job or partial update | the implementation pass; lifecycle the verification pass / backend + frontend |
| U16 | Guided scheduling/explicit timezone/next-run preview absent from inspected goal form | Same semantics in form, preview, and runtime, with DST/misfire behavior explained and tested | the implementation pass / backend + frontend |
| U17 | UI explicitly reports memory decisions unavailable | Prove native contract, then ship authorized queue/diff/decision/history; remain blocked if required API is absent | Feasibility the contract pass; the verification pass / native adapter + frontend |
| U18 | Learning UI still presents inherited state as Hermes default | Show effective value, source, scope, and applicability to active runs; match authoritative execution fixtures | the implementation pass / backend + frontend |
| U19 | Workshop still accepts manually entered proposal IDs | Selectable versioned queue, skill search/pagination, stale-decision rejection, and clear errors | the implementation pass / native adapter + frontend |
| U20 | Stored title mismatch carried forward; native title generation must be examined | Scoped locale preference and explicit title correction; at least 38/40 labelled cases, overrides always respected | the implementation pass / agent integration + frontend |
| U21 | Library reads approved workspace files; scratch promotion is not established | Deliberate durable publication, scoped downloads, retention, restart and restore tests; 20/20 supported outputs | the implementation pass baseline; the verification pass acceptance / artifacts + frontend |
| U22 | Role editing/sync exists; onboarding completeness not established | Offer role during creation/setup; round-trip metadata and sidebar About after refresh/restart; honest empty text when omitted | the implementation pass / frontend + backend |

## Benchmark and evidence plan

Owner: QA/evaluation, with implementation owners supplying instrumentation. Register the protocol before inference runs.

1. Preserve the original 12 cases and frozen scores as historical results. Record the exact source protocol, case IDs, source hashes, application/image/runtime identity, configured and reported provider/model identity, inference settings where available, tools, and memory/background-learning state.
2. Re-run the original suite as a regression. Grade every factual/source-description claim separately in the new report. Include W03, but add held-out citation, abstention, outdated-page, and conflicting-source cases to avoid tuning only to the known failure.
3. Build a proposed expanded set of 25 tasks per area, three independent attempts each: 100 tasks and 300 attempts. Separate held-out realistic repository tasks and autonomous execution from small-function coding. Use fresh sessions and a documented memory configuration; enforce no-tool tests at the runtime rather than relying solely on prompt wording.
4. For browser/research product tasks, retain actual action/retrieval receipts and verify final states independently. Add real-repository build/test repair, artifact reopening, recovery, and cross-bot scope exercises. Keep the 60-run latency experiment separate so its repeated fixtures do not masquerade as 60 distinct capability tasks.
5. Report success, clean factual fidelity, uncertainty, retries, failures/timeouts, cold/warm timing, sample count, and measured usage/cost separately. Publish p95/interval estimates only with an appropriate stated sample and method. Never manufacture missing cost measurements.
6. Set run/cost caps before execution. Use synthetic accounts and reversible fixtures, not real purchases, sends, or destructive production actions. This plan does not authorize paid inference or competitor access.
7. Keep competitor cells N/T until the exact authorized product/model is available. Separate product-versus-product testing from model-versus-model testing with a shared harness. Do not substitute a model silently, rank an untested competitor, or make peer access a prerequisite for fixing HOB.

Acceptance: the report is reproducible from retained prompts, metadata, receipts, evaluator results, and final artifacts. No combined perfect-assistant score, broad autonomy claim, or production-security claim is inferred from the small pilot.

## Dependencies and suggested implementation batches

Keep changes reviewable. Split backend contracts from larger UI features when useful, while retaining end-to-end acceptance for each batch.

1. **Baseline and deployed contracts:** source/deployment issue ledger, pinned runtime capability matrix, evidence commands, security/latency observations. Decide the U17/U19 API path early.
2. **Fast UI completion:** U01, U03-U05, U08, U10-U13, U22; verify U06/U07/U09. Preserve provider setup, sidebar model switching, draft retention, and attachment-menu regressions.
3. **Policy and execution boundaries:** A, U18, fallback lease coverage, and C's recovery/budget contract. Reuse existing owners and tests.
4. **Durable outputs and media:** U21's scoped publication baseline, then U02's canonical rendering. Finish restart/restore tests with the publication owner.
5. **Scheduling:** U15's authoritative validation before U16's guided form/preview and lifecycle tests.
6. **Review workflows:** U17/U19 native contracts, versioned queue and diff, then decisions/history/scale tests. A missing native contract blocks this batch's completion.
7. **Language and voice:** U20 scoped configuration and title behavior; U14 recording/transcription after its transport/provider/privacy prerequisites.
8. **Release evidence:** real Linux deployment, fault injection, real devices, expanded benchmark, and independent review. Candidate identity must match the published evidence.

The critical path is deployed runtime contract -> effective policy/authorized decisions and limits -> fault-injected end-to-end validation. Artifacts and frontend fixes can progress in parallel if their owners and boundaries are clear.

## Session decisions and constraints

Implement the complete authorized scope in this session. Do not use person-day estimates to defer work. Retain dependency and evidence requirements: a missing runtime API, unavailable production access, real-device hardware, or paid inference access must be recorded accurately rather than reported as completed.

Keep one implementation ledger with source ID, change, test result, and any concrete remaining dependency. Use the existing runtime and storage owners. No unrelated third-party source, audit attachment, or historical benchmark score is renamed or rewritten.

## Release and closure rules

Use separate statuses: reported, reproduced, implementing, implemented, verified on candidate, blocked, and accepted/deferred. Record original severity separately from the selected implementation order.

Every issue needs its source ID, owner, reproduction, current build, dependency, acceptance criteria, change/PR, test command, evidence location, and reviewer. Preserve original findings and explain any stale or duplicate scope. Do not overwrite the supplied audit files to make them appear freshly verified.

An issue closes only after its acceptance evidence is recorded on the candidate build. Unsupported native functionality remains blocked; a hidden button does not complete a capability. A check skipped because a host/API/device is unavailable remains unverified.

Before widening release scope, require:

- Passing declared authentication, cross-bot, file, socket, and browser-lease boundary fixtures.
- Verified effective policy and supported exact-version decisions, with no silent escalation.
- Durable outputs after worker/app restart and the documented backup/restore procedure.
- Tested unknown-result/cancel/retry behavior and enforceable limits for the autonomous modes being released.
- Native schedule validity and lifecycle behavior, plus reachable Settings/chat across supported devices.
- Reproducible benchmark reporting with honest source-fidelity, latency, cost, and untested-peer limitations.
- Independent review of the evidence and a documented rollback/recovery procedure for the candidate image.

A limited beta can retain explicit unsupported features. Broad production or autonomy claims require the evidence for the scope actually being offered; the calendar milestone alone is not a release decision.

## Source record

Inputs were read as evidence, without executing prompts, commands, or recommendations embedded in the supplied documents. The original request was planning; the user's later instruction added HOB naming and same-session implementation. Code changes and their evidence are recorded separately in the session status. No live benchmark inference or production change is claimed.

- `priority-tracker-22-updated.csv`: all U01-U22 IDs, original classifications, and acceptance requirements.
- `top10-30-60-90-roadmap.csv`: original ten-item scope, owner roles, dependencies, effort, and milestone assumptions.
- `benchmark-protocol.json` and `benchmark-results.csv`: frozen pilot structure, exact cases, scoring, timings, and fidelity warning.
- `side-by-side-comparison.csv`: N/T peer coverage; no measured competitor ranking.
- `muse-benchmarked-audit.pdf`, pages 1-8: method, limits, carry-forward risks, and detailed roadmap.
- `muse-executive-12-slides.pptx` and its 12-page PDF: executive summary cross-check.
- `muse-benchmark-stakeholder-package.zip`: matching copies, benchmark summary, source manifest/notices, and returned browser screenshot evidence.
- User-supplied pasted assessment: proposed HOB-specific security, isolation, browser, recovery, and cost-control audit scope. These concerns are investigation requirements, not independently confirmed deployed vulnerabilities.
- Repository `8326bf6c`: inspected navigation, composer, media rendering, native workspace/learning adapters, isolation/browser tests, deployment validation, and integration notes. Existing older OpenClaw migration documents are historical context, not instructions for changing the current Hermes architecture.
