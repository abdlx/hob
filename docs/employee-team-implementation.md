# Employee-team implementation checkpoint

30 October 2026. Implementation after the [specification review](employee-team-spec-review.md). Foundations (`f307d479`), the runtime adapter (`a1dbab3f`), Activity provenance (`f55402b0`) and nominated handoffs (`a38c0388`) have been pushed to `main`. Production deployment is unverified; the employee team is not qualified as live. The original [supplied spec](employee-team-spec-original.md) remains unchanged as a historical input.

## Operator decisions

The user confirmed these initial defaults during implementation:

- Requested native session window: 20 complete turns. **Stored as a requested setting; not enforced by this patch.**
- A dormant native adapter now implements this requested window on supported API wire requests. `nativeContext` remains false and cannot be enabled through the dashboard/API yet; ordinary chats retain their existing native behavior.
- Injected team core budget: 4,000 Unicode code points, including its managed wrapper. Enforced at proposal and approval time.
- Every core promotion requires an authenticated operator approval. No autonomous ordinary-fact promotion.
- No paid lane. This patch enables none, but does not yet enforce restrictions on existing configured providers/tools.

Role-to-bot mapping and messaging channel remain unset. No bots were created, renamed, assigned roles, connected to accounts, or given provider keys. No private memories were imported into core.

## Implemented locally

- Private app-owned SQLite state for immutable approved core revisions, pending proposals, settings revisions, owned document manifests, and per-bot distribution status. It is separate from native private memories and session histories.
- Core proposals from the authenticated coordinator relay identity or the dashboard operator. Workers cannot propose direct core edits through this API; they return PROMOTE suggestions to the coordinator. Bot credentials cannot call the dashboard approval endpoint.
- Approval binds one pending proposal ID, full content digest, and expected core revision. Replays and stale approvals fail. Rejected identical promotions need new evidence. Historical restore prepares a new proposal and requires a fresh approval; it never rewinds the revision counter.
- Core content/control-character/known-credential checks; complete Essential-section budget checking without truncation. An optional Reference section is retained in the full approved source and shared copy, but excluded from the injected block.
- Approved core materializes into coordinator TEAM_CORE.md and generated shared/team-core.md. A concurrently edited source draft is preserved and staged separately; it is not automatically approved. Approved blocks are repaired in AGENTS.md while preserving authored operator notes. Malformed managed delimiters fail that bot's pass.
- Opt-in shared Markdown/plain-text/JSON/CSV/TSV distribution, bounded to 2 MiB per source file, 128 eligible files and 16 MiB aggregate. Markdown gets the required synced-copy warning; other text formats retain their exact bytes. Source deletions prune only owned manifest paths. Edited managed copies are repaired; unmanaged collisions fail rather than deleting private files.
- Sensitive paths, known credential canaries, unsupported/linked files, opaque binary documents, and malformed/non-UTF-8 text are excluded with bounded, safe reasons. This is not a claim of infallible secret detection. Binary documents require a later content-admission path and are currently excluded, not silently copied or corrupted.
- Directory/file validation with production Linux directory-FD pinning, independent regular-file checks, bounded reads, per-file atomic replacement, pre-write destination validation, an owned-path recovery manifest and best-effort rollback on document write failure.
- Core and documents synchronize through the existing serialized network path on roster changes, manual dashboard action, and a 30-second reconciliation pass after explicit opt-in. Reconciliation covers restart/missed source events and worker edits even when source bytes are unchanged. An invalid unapproved core draft does not stop repair of approved data.
- Per-bot failure reporting retains the last successfully installed core revision and separately records the requested revision. One failed bot does not stop the others. A global source-read error marks distribution stale rather than inventing deletions or leaving a false current-success indicator.
- Optional coordinator-only relay authorization, applied before exchange/run creation and resolved by stable identity, including display-name aliases. Normal Hob peer relay remains unchanged by default.
- Exact ordered assignment/reply formats and task-ID binding in coordinator-only mode. Completed native work with missing/malformed verification is explicitly unproven. A valid DONE reply is only self-reported, never independently verified. Relay CLI output and background result notifications preserve this distinction. Known credential canaries are refused in outgoing team messages and withheld from shared results.
- Coordinator Settings → Memory & history controls for settings, full core before/after review, explicit approval, history restore-as-proposal, manual synchronization, safe exclusion reasons and per-bot status. Controls load only when opened.

The fresh database has both document sharing and coordinator-only relay disabled. Saving those options is an explicit dashboard operator action, not a consequence of creating a bot or reading this spec.

## Native adapter in progress

The exact upstream commit pinned by the Docker image (`7e9eb8d9a30f4a9bb9f8ecaf816b4b0ffdf47357`) was fetched and inspected separately from the older ignored local Hermes snapshot. `deploy/apply-hermes-team-compat.py` checks all seven target source digests before modifying them. Unknown, partial and repeated installations are refused. The image's compatibility manifest includes the installed hook/helper digests.

The disabled adapter adds trusted profile/session metadata in app-owned state. Chat admission binds the native profile and session before submitting a prompt; relay admission binds the receiver, new session and original assignment before starting its run. A later dashboard follow-up cannot replace a relay binding. Public roles remain unassigned: existing bot descriptions are not implicitly published as group role cards.

Startup creates this authority before launching scheduled native work. Only the runtime receives its exact database path; dashboard credentials and the app state-directory environment remain excluded. A configured authority that disappears is refused even by a fresh agent. Corrupt SQLite bytes stop startup and are preserved for repair.

On supported direct/relay turns, hooks bypass cached prompts and rebuild roster, approved Essential core, own role notes, own USER.md and MEMORY.md under their configured native budgets. Reference-only core content stays excluded. Missing/revoked authority, profile changes, unbound sessions, oversized required context and unknown budgets produce an explicit refusal. The current adapter refuses Codex app-server and MoA transports rather than claiming their alternate request builders are covered.

Wire requests retain at most 20 complete user turns, reducing whole turns further under the native model budget. Tool calls/results remain paired. A bounded extractive excerpt of the older prefix is reconstructed from the same supplied session history; it is not saved into private memory or a shared summary cache. Canonical archived messages remain unchanged. This excerpt is an interim summary implementation and does not yet capture all decisions, artifacts and open items required for useful long-running task handoff.

Hosted groups are recognized by Hermes' bound room execution policy, never a message label. They cannot reuse a known private session binding. Group prompt construction skips private files, private skill indexes, plugin context, cached/ephemeral prompt additions and injected API sidecars. Those renderer contracts are tested independently; actual group execution is refused at turn entry until a separate public workspace and tool scope are implemented. Private MCP schemas and native side effects need isolation too; filtering prompt text alone is insufficient.

The adapter suppresses automatic background memory/skill review at both enqueue and execution, external provider retention/recall, and external context engines. Ordinary mode remains unchanged. Explicit builtin private-memory writes are **not yet classified or gated for session-only facts**, so this work does not establish A7. Native compaction/rotation, alternate inference paths, title helpers, middleware and actual process/tool permissions still need qualification before activation. No user-facing activation control or native-qualified status has been added.

## Nominated worker-output handoffs

Coordinator-only team tasks can now hand off their single nominated `OUTPUT`. The relay derives that path from the stored original assignment and requires a matching structured worker reply. Only the authenticated coordinator can request or review the handoff. Caller-supplied path overrides and worker review attempts are refused. The service reads only the active worker's assigned workspace file; private paths, links, hardlinks, changed reads, known credential canaries and files above 25 MiB are refused.

The coordinator receives a copy under its own `.hob/team-inbox/<exchange>/` directory. An app-owned immutable receipt binds the exchange, task, original assignment, worker reply and content hash. It records byte count, source modification time and receipt time. Repeated requests use the same snapshot. A missing local copy can be restored only from identical worker bytes; changed bytes need a new task. Copies are installed through pinned directories with inherited user-mode ACLs and production directory sync. No broad Main-to-worker filesystem read permission was added.

The generated relay helper exposes `artifact`, `artifact-status` and `review` commands. Main reads the received file with its own tools and records its actual findings against the exact SHA-256. Reviews have stable request IDs, immutable audit entries and separate passed/failed verdicts. A worker's partial/blocked result cannot acquire a passed-completed verdict. A changed assignment, reply or copy invalidates a new review. Checks stay private to the coordinator; other participants receive only public outcome/hash metadata. Missing exchange-cache updates can be reconstructed from the protected receipt/review without rerunning the worker.

The relay exposes `nativeCompleted` separately. For team assignments, `completed` requires a coordinator-reviewed completed result. The inspector distinguishes worker-reported completion, received output, passing review and failed checks. Hash integrity is checked by the service; semantic review findings are coordinator-authored evidence, not a guarantee that arbitrary claims were machine-verified. No-file task review and comprehensive native-agent/live qualification remain pending.

Local tests exercise a real relay plus the handoff service, a worker falsely claiming a missing file, exact nomination, copy integrity, stale/tampered inputs, credential/path denial, durable/idempotent reviews, failed/partial results, revocation, exchange-cache recovery, and mobile inspector states. A new disposable Linux image probe creates the output as the worker's actual SSH user, reads the received copy as Main's SSH user, checks its hash/content, and tests denied cross-workspace reads and snapshot writes. That probe is wired into the user-isolation first-run job; it has not been executed locally because Docker is unavailable here.

## Scheduler Activity provenance

The authenticated timeline now combines its existing session feed with a separate, profile-scoped native scheduler-history projection. The native session store supplies job/execution identity; a bound execution-ledger terminal outcome takes precedence over native message-lifecycle classification. Unclosed runs with no authoritative terminal result remain unknown. A conflicting scheduler response cannot turn a recorded failed outcome into success.

Job existence is checked against the same profile's complete on-disk inventory, including disabled jobs. This path uses bounded independent-file reads and strict canonical validation instead of invoking native job-list auto-repair. A verified absent job, an unavailable/corrupt/linked inventory, and a legacy record without a usable job ID remain distinct. The observed UTC time and status source accompany each record. Reading Activity never acknowledges a failure or rewrites native history.

The main timeline and agent inspector show these labels and any incomplete-history warning. Only a historical failure with a verified deleted job leaves the current-attention list; its original failed row remains in history. Existing, unlinked and unavailable failures stay discoverable. An unavailable empty feed says Activity is incomplete, rather than claiming there was no work.

The initial scheduler page is bounded to 100 runs; its native endpoint exposes offset pagination. The timeline response includes the next scheduled offset, but UI pagination remains pending. This is a bounded recent-history view, not proof that every historical run was inspected. The two original orphan entries have not been located on the user's deployment, so that specific incident is not claimed resolved.

The local integration probe uses the actual pinned native `SessionDB`, cron-store router and profile ContextVars with temporary scheduler failures. It checks that browsing leaves session/inventory bytes unchanged, including during inventory corruption, and that a second profile with the same job ID reads its own inventory. The web database opener is an explicit seam; HTTP scope is checked separately. Full live/Linux scheduler acceptance remains pending.

Full-suite validation also exposed a shutdown race: async observers could still atomically replace the journal after HTTP close while a replacement app opened it. The app now tracks request/poller cleanup, closes viewer resources, and exposes a drain barrier; shutdown joins queued journal writes before the process exits. The journal's file identity and hardlink checks remain intact.

## Remaining qualification work

The backend deliberately reports `qualification.live: false`. Current local evidence does not establish all twelve acceptance tests:

| Acceptance area | Status |
| --- | --- |
| A1 independent artifact verification | Nominated snapshot transfer, exact-hash coordinator reviews, private/public metadata boundaries and crash-cache recovery are tested. The actual-user SSH probe passed through the mandatory Linux user-mode first-run step at `a38c0388`. Full native-agent/live acceptance remains pending; no broad private-workspace read exception was added. |
| A2 core distribution | Approved on-disk propagation/repair and disabled-adapter prompt refresh are tested, including replacement of a cached prompt. Live open-session runtime acceptance is pending. |
| A3 approval enforcement | HTTP/relay approval boundaries are tested. Native process access to app-owned state still requires qualification under actual OS isolation. |
| A4 shared documents | Bounded text copying, repair, pruning, exclusions and failure isolation are tested. Opaque binary admission and truly atomic core-plus-doc generation visibility remain pending. A bot can observe a per-file transition during sync; `synced` describes completed on-disk distribution, not a native prompt-generation guarantee. |
| A5 privacy | Existing dashboard jail remains. Full native filesystem/terminal/provider isolation must be proven against the shipped Linux runtime. |
| A6 coordinator-only relay | Covered locally, including aliases, pre-admission denial, normal-mode compatibility, and coordinator-bound requests. |
| A7 session-only memory/context | Disabled native adapter has local contracts and source-level hook probes for prompt refresh, bounded wire history, group prompt filtering and automatic retention suppression. Explicit memory writes, native compaction/rotation and full group process/tool isolation remain pending. |
| A8 shared media | Not implemented. Existing per-bot media boundaries remain. |
| A9 delayed results | Existing durable exchanges and wait/reconciliation behavior remain; team-specific live/restart qualification is still required. |
| A10 reminders/phone | Pending channel selection, explicit account connection, and actual device evidence. |
| A11 orphan job failures | Local native-store, HTTP, UI and mobile contracts now cover scheduler IDs, verified deletion, unavailable/unlinked states, preserved failures and read-only annotation. Full Linux/live acceptance and identification of the two original deployment records remain pending. |
| A12 external facts | Source/time/staleness instructions are included. Consistent native result metadata and real answer acceptance remain pending. |

Paid-execution restrictions must also be enforced at the actual model/tool execution owners before team tasks qualify under the confirmed no-paid-lane policy. Roles and messaging require the remaining operator choices. Production version/image verification and deployment are separate work; no production writes or deployment were performed here.

## Verification

Use `npm test` in server/, `npm test`, `npm run lint`, `npm run build`, and `npm run test:e2e` in web/. The new team tests cover exact approvals, unauthorized bot actions, persistence, source/destination isolation, repaired edits, safe pruning, stale status, rollback-as-new-proposal, and explicit UI review. Browser tests use declared API fixtures; they do not execute live bot tasks or establish native/device acceptance.

`python deploy/test-team-context.py` runs adapter contracts with explicit native prompt/estimator stubs. Set `HOB_QUALIFIED_RUNTIME` to a clean checkout of the pinned commit to additionally execute critical patched upstream function bodies and the complete image compatibility installer against the verified source. CI includes that source-level probe using the pristine digest-pinned base image. These probes are not full native Linux execution or live-device evidence.

Local evidence for this runtime checkpoint: full backend suite 482 passed / 2 platform skips; deployment suite 38 passed; existing native-control unit suite 11 passed; team adapter suite with the exact pinned source 9 passed. Focused chat/relay admission, team-state and startup checks also passed after the final edits. No web UI changed in this checkpoint. Docker/Linux and live device acceptance remain unexecuted locally.

The Activity projection supplements canonical `session.list`, which deliberately excludes scheduler histories. The pinned native `SessionDB.cron_run_identity()` supplies authoritative job/execution IDs; plain session absence is never used to establish job deletion. `deploy/test-native-activity-pinned.py` exercises the projection against that native store, using only temporary fixture state. CI runs this probe against the pristine digest-pinned base image.

Activity checkpoint evidence: full backend suite 488 passed / 2 platform skips; web unit suite 64 passed; browser suite 51 passed; deployment suite 38 passed; native-control unit suite 17 passed / 1 Windows symlink-creation skip. Web lint/build passed. The actual pinned native-store probe passed locally with independent profiles, and its equivalent is wired into Linux image CI. The initial full backend run exposed the journal restart race described above; it passed after the drain fix. No live production records were changed by these checks.

The pushed `f55402b0` checkpoint subsequently passed GitHub's supported-runtime server/web checks, both Linux image first-run modes (`shared` and `users`), and mobile validation. The handoff changes are subsequent work and require their own image evidence.

Handoff checkpoint evidence: 499 backend tests passed / 2 platform skips; 64 web unit tests, 52 browser tests and 38 deployment tests passed; web lint/build passed. A Windows browser crash/recovery load test timed out during an unrestricted parallel build/test run, then passed unchanged in isolation and in the complete two-worker run. The standard server test command now uses the same two-worker limit as CI. Linux image evidence is recorded below; the team still lacks full native-agent/live acceptance.

The pushed `a38c0388` handoff checkpoint subsequently passed [Linux image/server/web validation](https://github.com/abdlx/hob/actions/runs/41089604124) and [mobile validation](https://github.com/abdlx/hob/actions/runs/41089604473). The successful user-mode first-run step invokes the new mandatory actual-SSH-user handoff probe, including Main's independent digest/content read and denied cross-workspace reads/snapshot writes. Raw job-log download returned HTTP 403 in this environment; the verified evidence is the exact checked-in smoke command and its successful CI step/job. Full native-agent/live employee-team acceptance remains incomplete.
