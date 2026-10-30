# Employee team specification review

Status: review and proposed engineering resolutions, 30 October 2026. No team functionality, bot settings, memories, accounts, or deployments were changed. The user requested review before implementation. The six operator decisions below remain unapproved.

Baseline: local Hob commit `56c784b4d11725d1d5dbc7f56add9358e5d6ba87`. The [original supplied specification](employee-team-spec-original.md) is retained verbatim as a historical input. This review corrects its baseline and proposes replacement requirements where it conflicts with itself. Neither document is evidence that the employee team is live.

Subsequent implementation and the initial defaults later confirmed by the user are recorded in the [implementation checkpoint](employee-team-implementation.md). The open-decision table below reflects the original review stage.

## 1. Findings against the current code

| Original assertion | Current evidence | Resolution |
| --- | --- | --- |
| Worker-to-worker relay already returns 403. | [The relay send path](../server/hermes-bot-relay.mjs#L83) allows active teammates, and [a regression test](../server/test/hermes-bot-relay.test.mjs#L99) explicitly requires worker-to-worker communication. The [managed roster instructions](../server/hermes-bot-network.mjs#L130) encourage it. | Coordinator-only relay is a **new policy change**, including server authorization, instructions, and tests. Add it as an explicit employee-team mode; preserve ordinary Hob behavior outside that mode. |
| One dedicated relay session per receiver already exists. | [Each exchange creates a new receiver conversation](../server/hermes-bot-relay.mjs#L111), with [a matching test](../server/test/hermes-bot-relay.test.mjs#L116). | Retain per-exchange isolation. Do not pool unrelated tasks into one receiver session. |
| Main cannot be renamed. | [Identity updates](../server/hermes-bots.mjs#L495) support display names; [tests rename the coordinator to Boss](../server/test/hermes-bots.test.mjs#L361). | Route by immutable `default`, never the display label. Render the configured name/avatar, consistent with the current UI. “Main” in this design means the coordinator role. |
| Appending a core block guarantees the specified context order every turn. | [Network sync](../server/hermes-bot-network.mjs#L253) writes workspace files. [Chat admission](../server/hermes-canonical-chat.mjs#L128) submits text to native Hermes, which owns prompt assembly and session history. | File sync alone is insufficient. Verify effective native prompt ordering and refresh behavior, including already-open conversations. |
| Approximate private-memory budgets and 20 turns are already enforceable contracts. | The current Hob chat adapter does not enforce this proposed context window. Learning settings [map independent native switches](../server/hermes-learning-setup.mjs#L5); they do not implement retention or context budgets. | Treat these as runtime work requiring capability checks, explicit configuration, and tests against the shipped Hermes image. |
| Activity failed entries can be matched to jobs by their existing IDs. | [Canonical Activity](../server/hermes-canonical-chat.mjs#L195) currently projects sessions and journal runs, rather than a job-ID-bearing scheduler audit feed. | Establish authoritative event-to-job provenance before adding “job deleted.” A missing session/run is not proof that a job was deleted. |
| Library files are capped at 2 MB. | [Previews](../server/hermes-workspace.mjs#L224) cap at 2 MB; [downloads](../server/hermes-workspace.mjs#L210) support up to 25 MB. [Artifacts](../server/hermes-artifacts.mjs#L24) already have a separate durable delivery mechanism. | Make 2 MiB a **shared-document sync policy**, not a new global Library/download limit. Keep existing private artifacts and downloads. |
| The dashboard jail also isolates native file/terminal tools. | [Isolation defaults to shared execution](../server/hermes-isolation.mjs#L12). OS-user isolation is separate; the [broker provisions actual workspaces](../deploy/isolation-broker.py#L342). | Require verified native isolation for the strong privacy claims. Dashboard route tests alone cannot establish them. Resolve roots from configured authorities, not hardcoded deployment paths. |

Existing useful foundations remain: active registry identities, immutable IDs and revocation, per-exchange provenance, bounded relay waits, serialized roster sync, atomic file replacement, preserved operator notes, native versioned reviews, and profile-scoped file/media routes. They are building blocks, not proof of the new guarantees.

The old deployment SHAs and the two named reminder failures are historical claims in the supplied document. This review did not inspect a live deployment or confirm those specific records. Before rollout, compare the intended image/commit with `/api/version` using the [existing deployment procedure](../deploy/COOLIFY.md#verify-the-deployed-commit).

## 2. Resolve the memory and privacy contradictions

### Session-only means no durable memory write

Replace Section 3.3's automatic write to episodic memory with this rule:

> A rolling summary belongs to the same native session. It may be retained in that session's durable history, but is never written automatically to USER.md, MEMORY.md, a learning graph, shared docs, or team core. “Transient” describes its scope, not deletion of the conversation archive.

An explicitly session-only fact remains excluded even if it appears in a summary, tool result, or background review. Other sessions of the **same bot** must not receive it either. Promotion must exclude session-only material unless the user explicitly changes that restriction. A user request to remember something privately is distinct from permission to share it with the team.

Private memory can retain that bot's eligible durable task learnings without requiring per-write user approval. It cannot indiscriminately persist everything encountered in chats. Enforce and test this through native memory/background-review paths, external providers, and filesystem tools; an AGENTS.md reminder is not a write barrier. Do not automatically disable existing memory approval settings during a document migration.

### Main does not inspect private memories for weekly review

Replace “Main reviews/prunes every bot's memory” with worker-local maintenance. Main requests a bounded hygiene report: counts, proposed non-sensitive durable facts, stale items, and blockers. Each worker inspects and prunes its own eligible memory through native tools. Main reviews its own memory directly and reviews core changes through the promotion process.

Main cannot correct another bot's USER.md by opening it. It sends a correction referencing the published core revision; that worker applies the correction locally and returns a receipt. Until acknowledged, mark it unresolved. Full private-memory inspection would require a separately authorized exception and is outside this design.

### Fact precedence and durability

Use this precedence when answering: the user's explicit current instruction/fact, then published core, then eligible bot-private notes, then unverified observations. A conflict does not silently modify or delete any source. Surface both claims with provenance; do not act on a contested money or standing-rule claim while approval is pending.

Core holds durable project decisions/facts, not changing task status. Current status, deadlines, and blockers belong in TASKS.md. “Project status” in the original Tier 1 examples must therefore become “durable project facts.” Contact or delivery changes that affect outsiders are approval-required, not automatically ordinary facts.

## 3. Promotion needs a real commit boundary

Main remains the logical author of core. A trusted Hob mutation service performs the physical commit; bot processes must not be able to bypass it by writing or replacing the source file or its parent directory. Protect both directory and file authority in the actual execution backend. Do not put a dashboard user credential in a bot workspace.

Proposed lifecycle:

`proposed → checked → awaiting-user-approval / eligible-autonomous → committed → distributed`

`conflicted`, `rejected`, and `distribution-incomplete` are explicit outcomes. A promotion record binds the task/exchange ID, proposing bot, fact ID/type, minimal shareable evidence, source/observation time when applicable, expected core revision, proposed diff hash, and approval identity. Private transcripts are not distributed as evidence; share a necessary excerpt or a sanitized artifact receipt.

Only an authenticated user action can satisfy a user-required approval. An assistant message saying “approved,” a relay field, or a worker-provided classification cannot satisfy it. Approval applies to one exact diff/base revision; changed content, replay, or concurrent edits require revalidation. Restoring an old version is also a new reviewed change, so rollback cannot reintroduce revoked rules or secrets silently.

Keep Tier 1 autonomy **off until decision 6 is answered**. If enabled, allow only a narrow typed ordinary-fact schema. Free-text instructions, policy changes, preferences, deletion, conflicts, money, outsider actions, or uncertain classification go to the user. A model's label of “ordinary fact” does not establish permission. Core deletion always requires user approval, including deletion performed by restoring a version.

Use `main/TEAM_CORE.md` as the sole editable logical source, with explicit Essential and Reference sections. The published managed block contains the complete Essential section, never a prefix selected by truncation. Measure the agreed budget in Unicode code points, with metadata/wrapper overhead accounted for in the actual model context limit. If Essential exceeds the approved budget, refuse publication and ask Main to propose a smaller section. Generate `main/shared/team-core.md` from the full published source for retrieval; it is a read-only projection, not another editable master.

Archive each committed revision using a unique revision/hash identifier as well as a UTC timestamp. A date-only filename would collide on multiple edits in one day. Archive approval/author metadata separately from the model-facing text. Every core edit also refreshes the managed blocks; operator notes survive and malformed/duplicate managed delimiters cause a repairable failure rather than ambiguous injection.

## 4. Shared Library: publication, verification, and sync

### Keep private artifacts; add an explicit handoff

The shared shelf is the canonical collection of **published team deliverables**, not every file any bot has produced. Existing private artifacts, scratch files, and drafts remain private and usable in Library.

A worker cannot create a final file directly in Main's shared source. The default `OUTPUT` is a path under that worker's assigned workspace. To publish, it supplies an explicit handoff request referencing that output. A trusted transfer operation revalidates the originating bot, allowed path, regular-file identity, size, content policy, and current hash, and copies only the nominated artifact into Main's own `incoming/` area. Main reads that copy, checks the claimed result, and publishes the selected bytes through the shared-source service. It never gains general access to the worker's workspace or memory.

The receipt binds owner, task, original relative path, destination, byte length, hash, and publication revision. Existence and hash establish which bytes were checked; they do **not** establish correctness of a spreadsheet, report, or external claim. Main must record the task-appropriate verification too. Revalidate bytes before commit to prevent a worker changing the file after review. A failed delivery remains failed/partial; never replace it with a made-up link.

### Safe, predictable sync contract

1. Resolve Main/worker workspaces through existing configured authorities, including OS-user mode. Do not assume `workspaces/` is below the Hermes home.
2. Enroll and revalidate active identities. Implement source-change observation with debounce plus boot/manual reconciliation; a filesystem watcher alone misses restarts, atomic replacements, and dropped events. A reconciliation pass must repair edited worker copies even when the source hash is unchanged.
3. Snapshot one published source revision. Track an owned manifest of relative paths, hashes, sizes, and revision per bot. Never follow source or destination symlinks, hardlinks, linked directories, or special files. Reuse the existing bounded/pinned-file approach and cover path swaps during sync.
4. Publish a generation atomically per bot, or provide an equivalent rollback/recovery transaction. Only mark a bot updated after core and docs match that generation. One bot's failure does not block others. A worker edit to a managed copy is overwritten; a source deletion removes only a manifest-owned copy. Never recursively clean unrelated worker files. Conflicting pre-existing unmanaged `shared/` content requires migration rather than silent adoption or deletion.
5. Keep the exact warning line from the original spec in Markdown copies. Do **not** prepend Markdown to PDF, DOCX, JSON, CSV, or other formats. Preserve their bytes; show the synced-copy warning through sidecar metadata/UI and the folder README. Allow only declared document formats; exclude media from document sync even when small.
6. Apply the stricter shared-document eligibility policy: sensitive paths, safe filenames, regular-file checks, 2 MiB limit, and content admission. Existing guards differ across file routes and artifacts, so do not assume one regex covers all routes. Path filtering cannot establish that an innocently named document contains no secrets. Reject detected secrets before distribution, log only safe identifiers/reasons, and test both filename and content cases. Do not claim arbitrary secret detection is infallible.
7. An intentional source deletion or newly ineligible file removes its previously managed copies and reports the reason. A read error, failed scan, or unavailable source is **not** proof of deletion: preserve the previous generation, report failure, and retry. Source changes during snapshotting retry without publishing mixed revisions.
8. Retain `{ updated, failed }` compatibility, with safe per-bot revision, skip reasons, and freshness metadata. Persist pending retries across restart. The dashboard manual action is authenticated and rechecks active bot membership; bots cannot invoke operator-wide synchronization using their relay credentials.

Use lowercase kebab-case for new ordinary docs. Explicitly exempt reserved native/control filenames such as `AGENTS.md`, `TEAM_CORE.md`, and `TASKS.md`. Existing valid legacy filenames need a reviewed migration, not a surprise rename.

The application tracks shared revision/freshness, rather than trusting a potentially edited local core block. Policy-critical failures prevent new delegated work until the recipient has the required published revision. Ordinary private chat can remain available with an explicit stale-team-state warning. “Live” requires all enrolled team members synchronized.

## 5. Context and native runtime work

Keep the requested logical order: roster, published core, permitted role card, allowed private memory, bounded session history/summary, worker assignment. Retrieved files enter only when opened and remain data, not new instructions. For group mode, omit private memory entirely and use only a public role card, roster, core, and that room's public history/assignment.

The runtime must identify `direct-user`, `relay-exchange`, and `group-room` contexts using trusted session metadata. A sender cannot obtain a broader context by writing a different chat-type label in its message. Group context must also disable private-memory retrieval, cross-session search, external-memory recall, and background persistence of session-only facts. A shared-message-only HTTP payload does not prove a native group agent has no profile-memory injection. Verify the shipped native group driver; if it cannot supply the required context, employee-team groups remain unavailable.

Check how Hermes caches workspace instructions/memory. A core sync must affect the next eligible turn in an already-open conversation without mixing revisions during an in-flight turn. At admission, validate the managed block against the trusted published revision and verify what the native runtime actually loads; a stored sync-success flag cannot detect a bot editing AGENTS.md afterward. Repair or block on mismatch, and never treat bot-authored bytes as approved core. If the shipped runtime cannot refresh safely, expose a required new-session/reload state and block delegated work until refreshed; do not silently claim per-turn freshness. Implement the needed native extension through the existing pinned-runtime compatibility workflow, rather than maintaining a second competing chat/history engine in Node.

Define a turn as one user/task input plus its complete assistant/tool exchange. Keep whole tool call/result pairs together. Bound context by both the selected turn window and the model token budget, reserving room for instructions, tool results, and the response. Count roster, role cards, memory wrappers, external-provider blocks, and retrieved content too. The complete archived history remains available to the authorized operator; the context window is not a retention policy. Session summaries stay session-scoped, including after restart.

No user chat auto-loads relay transcripts. Main receives the minimal verified result and shareable evidence through an explicit delivery. Main can summarize across tasks only from information legitimately returned to it. Merely switching the bot selector grants no transcript access and triggers no automatic cross-bot handoff; a needed handoff is a deliberate summary publication by the coordinator.

## 6. Delegation, permissions, and failure states

Preserve the original TASK/OUTCOME/CONSTRAINTS/OUTPUT/DEADLINE/CORE REFS and TASK/RESULT/FILES/VERIFICATION/BLOCKERS/PROMOTE text formats verbatim. Define continuation lines for multiline fields, reject duplicate/missing fields, and bind parsed task IDs to trusted exchange metadata. A request for Main to coordinate is a distinct worker-to-coordinator message type; it does not let a worker impersonate a Main-issued assignment. Worker completion returns through the existing exchange reply, not a new circular send.

In employee-team mode, authorize `default → active worker` and `active worker → default`; deny worker-to-worker sends with 403 **before** creating an exchange or native run. Keep replay protection, cycle checks, queue bounds, revoked-bot checks, and participant-only exchange inspection. Update the generated roster and relay prompt together so they do not instruct workers to use a now-forbidden path.

Malformed or unverified replies remain inspectable. Missing VERIFICATION means unproven; a textual DONE marker never overrides a failed, cancelled, unknown, or still-running native run. Do not discard a completed run's raw output because it missed a formatting field, and do not rerun work automatically to repair formatting. Main can request clarification without duplicating side effects.

Separate these states:

- Waiting: the HTTP observation deadline elapsed while admitted work remains active. Preserve the exchange/run IDs and reconcile the same work; never resubmit merely because a wait timed out.
- Unknown: native admission/outcome cannot be established. Inspect before retry; never map it to waiting or done without evidence.
- Failed/cancelled/interrupted: the native execution actually reported that state. Keep the failure visible even if the job was subsequently deleted.
- Completed but unverified: output exists, but required evidence/verification is missing.
- Verified: the completed result passed Main's task-appropriate checks and its referenced artifact revision is recorded.

For orphan Activity entries, add typed origin metadata (`session`, `relay`, `scheduled-job`, `group`) and authoritative job/run IDs where available. Mark a historical scheduler failure “job deleted” only after a successful lookup of that same bot's job inventory proves absence. On lookup failure show “job status unavailable”; on legacy events with no job ID show “unlinked historical entry.” Preserve the original historical failure, distinguish it from current failures, and store any acknowledgment separately from native execution status. The original spec's suggested acknowledge/resolve UI is not established by this review.

The permissions matrix needs enforcement across HTTP, native tools, terminal/filesystem, groups, scheduled work, and external-memory/provider paths. Shared-UID mode cannot establish hard bot privacy. Merely instructing a bot not to contact outsiders, change credentials, or use a paid provider is also insufficient when it has tools/credentials that can bypass that instruction. Restrict capabilities at their actual execution owners and test denial paths. Workers' cron permission is limited to bot-local work; it does not grant a messaging-channel or paid-lane bypass.

Until a user supplies and enables a paid policy, employee-team paid execution is disabled. A numerical cap must define currency, time period, covered providers/tools, and concurrency reservations; document estimation versus actual billed cost and fail closed when the enforcement backend is unavailable. A core file is not a spend ledger. Account/channel connections, bot lifecycle, and provider changes remain operator actions through their existing authority.

## 7. Phase 2 remains separate

A shared-media root needs independent read authorization, trusted MIME/size handling, native tool access, and OS/broker rules. Adding it only to dashboard routes does not grant workers' native tools legitimate read access or prevent native writes. Existing inline media is raster-image-only; video/audio support is additional work, not a consequence of adding a root.

Require active membership on reads, revocation checks, no traversal/link escapes, read-only access for every worker, and no broad Main-home permission changes. If the native boundary cannot pass A8, retain explicit nominated-file transfers into each worker's own workspace. Do not claim the common media shelf is live in that fallback mode.

Reminder delivery must wait for the selected channel and user account connection. Verify recipient, timezone, device arrival, retries/deduplication, disabled/revoked jobs, and separate in-chat fallback. Calendar connection remains an operator choice; a shared calendar document can be the initial local representation without silently enabling OAuth or reminders.

## 8. Revised implementation sequence

1. **Review/configuration:** approve this design, resolve the six operator decisions, inventory actual enrolled bot IDs/roles, and record current deployed image/commit and isolation capabilities. Do not assume there are eight enrolled bots or that a missing role draft was supplied.
2. **Authority and privacy foundation:** employee-team policy mode, coordinator-only authorization, trusted chat-type metadata, native context/memory capability tests, and protected core/shared-source mutation boundaries. Implement cross-bot nominated-artifact transfer and promotion approvals before relying on Main's verification or core policy guarantees.
3. **Core and docs:** versioned approved core, manifest/generation sync, source-change/restart/manual reconciliation, safe deletion/content eligibility, and persistent per-bot freshness reporting. Preserve and migrate existing artifacts/operator notes.
4. **Context and Activity:** runtime-owned turn limits/session summaries, group-private-memory exclusion, next-turn core refresh, exact delegation parsing, and provenance-aware historical failure annotations.
5. **Phase 1 qualification:** run unit/integration tests plus deployment-image native-tool/context tests. Report which acceptance cases are demonstrated locally and which require live/device evidence. An incomplete phase does not qualify the whole team as live.
6. **Phase 2:** shared media, operator-connected messaging, calendar choice, phone delivery/fallback, and all remaining live checks. Deployment/production writes require a concrete test report and the user's separate deployment instruction; this review grants neither implementation nor deployment permission.

Phase 0 from the original document can create **drafts** after implementation authorization. It cannot safely enable free memory writes, assemble a shared user profile, connect accounts, dismiss historical failures, or claim a functioning core distribution before the relevant controls exist.

## 9. Preserve A1–A12, strengthen the evidence

| Test | Required positive and negative evidence |
| --- | --- |
| A1 — delegation/verification | Authenticated coordinator sends the exact assignment; worker produces its own result; nominated artifact is transferred and independently checked; configured bot label is attributed. Missing reply, missing file, changed bytes, malformed verification, and partial output never become verified completion. |
| A2 — ordinary promotion | With the selected Tier 1 policy, commit one eligible fact at the reviewed base revision; all active bots receive the same core hash; operator notes survive. Test concurrent edits, over-budget core, local block tampering, source change, boot refresh, and next turn of an already-open session. |
| A3 — approval boundary | A standing-rule/money/conflicting/deletion change is refused without an authenticated exact-diff user approval. Reject worker writes, terminal replacement, forged approval text, stale/replayed approvals, and attempts to disguise instructions as ordinary facts. |
| A4 — shared docs | Repair an edited managed copy even with unchanged source; propagate edits and deletions; preserve unrelated worker files and binary bytes; reject unsafe links, content/filename secrets, oversized documents, and source/destination races. One failed bot and a restart must not corrupt successful generations. |
| A5 — private workspace/memory | Deny cross-bot reads/writes through dashboard, native file tools, terminal, provider recall, and shared-copy path tricks. Verify actual isolation mode. Nominated artifact handoff transfers only the explicit authorized file. Main's hygiene review receives no private-memory dump. |
| A6 — relay authority | In team mode, workers can ask the coordinator but cannot message another worker, including through a display-name alias, parent exchange, replay, or background task. Refusal creates no exchange/run. Preserve normal-mode behavior and revoked-identity denials. |
| A7 — session scope/context | An explicitly session-only canary survives only within its own session and summary. It is absent from a later session of the same bot, every other bot, group context, private memory, core, provider recall, and background-review outputs. Verify ordered bounded effective prompts and intact tool pairs against the shipped runtime. |
| A8 — media | An active worker reads the exact shared-media object through dashboard and native tools, cannot mutate it, cannot reach Main-private/other-bot media, and loses access when revoked. Include symlink/hardlink/path races and permitted MIME/size cases. Fallback copying is recorded separately, not a shared-media pass. |
| A9 — delayed results | Timeout observation returns the same admitted exchange without declaring failure/success; later completion reaches the correct coordinator/task once. Restart, actual native failure, unknown admission, and out-of-order replies do not trigger duplicate work or false verification. |
| A10 — reminder | The actually selected channel delivers the nominated reminder to the intended phone at the configured time; demonstrate separate in-chat fallback, idempotent retries, and disabled-job handling. Requires device/live evidence after operator connection. |
| A11 — historical failures | Reproduce typed scheduler failures with a real job ID, then delete the job and annotate historical failure without rewriting it as success. Lookup outage and unlinked legacy events are labeled differently. Current failures remain discoverable and cannot be summarized as “no failures.” Locate the original two records before claiming that specific incident resolved. |
| A12 — external facts | Carry source URL/reference, observed/fetched UTC time, and freshness policy through worker reply, verified result, and any eligible promotion. Stale cached data remains labeled stale; missing source/time remains unverified. Check the rendered human answer as well as machine metadata. |

Cross-cutting rollout conditions: no secrets in distributed snapshots/relay payloads or diagnostics; no unauthorized provider/channel/spend actions; approved core deletion/rollback only; recoverable sync failure; complete per-bot freshness; and trusted runtime/image provenance. These are required cases under the relevant A-tests, not promises inferred from a green JavaScript test suite. No A-test was executed during this source review.

## 10. The six operator decisions remain open

| Decision | Proposed starting point | Still needed from the user |
| --- | --- | --- |
| Role mapping | Use actual enrolled immutable IDs and their configured display names; do not create or rename bots implicitly. | The eight-role draft is absent from the supplied material. Supply/confirm the ID-to-role mapping, including which bot owns reminders. |
| Messaging channel | Telegram is the original recommendation, with no connection performed. | Select the channel and explicitly connect/authorize its recipient/account. |
| Paid lane | Disabled pending a complete policy. | Either no paid lane, or cap + currency + period + covered providers/tools; enable only after enforcement is demonstrated. |
| Session window | 20 complete turns as a proposed maximum, additionally bounded by model context; session-local summary only. | Confirm or change the window. |
| Core budget | 4,000 Unicode code points as a proposed injected-core limit; reject oversized Essential sections. | Confirm or change the budget. |
| Ordinary promotions | All promotions require user approval until a policy is selected. Typed ordinary-fact autonomy can be enabled later. | Permit coordinator-only Tier 1 promotion, or require user approval for every promotion. |

These are configuration decisions. The engineering resolutions above do not answer them on the user's behalf.

### Subsequent user confirmations

The user approved the proposed 20-complete-turn window, 4,000-character injected core budget, user approval for every core promotion, and no paid lane. They later clarified that existing subscriptions with no per-call charges are allowed. Role mapping and messaging may remain unset until supplied. These confirmations supersede the corresponding open choices above; they do not establish runtime isolation, billing enforcement or live acceptance. Current implementation and qualification evidence are tracked in the [implementation checkpoint](employee-team-implementation.md).
