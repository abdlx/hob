# Employee-team implementation checkpoint

30 October 2026. Local implementation after the [specification review](employee-team-spec-review.md). Not deployed, not qualified as a live employee team. The original [supplied spec](employee-team-spec-original.md) remains unchanged as a historical input.

## Operator decisions

The user confirmed these initial defaults during implementation:

- Requested native session window: 20 complete turns. **Stored as a requested setting; not enforced by this patch.**
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

## Remaining qualification work

The backend deliberately reports `qualification.live: false`. Current local evidence does not establish all twelve acceptance tests:

| Acceptance area | Status |
| --- | --- |
| A1 independent artifact verification | Assignment/reply correlation exists; nominated cross-bot artifact transfer and Main's independent verification are still pending. No private-workspace read exception was added. |
| A2 core distribution | Approved on-disk propagation and repair are tested. Effective next-turn native prompt refresh, including open sessions, is pending. |
| A3 approval enforcement | HTTP/relay approval boundaries are tested. Native process access to app-owned state still requires qualification under actual OS isolation. |
| A4 shared documents | Bounded text copying, repair, pruning, exclusions and failure isolation are tested. Opaque binary admission and truly atomic core-plus-doc generation visibility remain pending. A bot can observe a per-file transition during sync; `synced` describes completed on-disk distribution, not a native prompt-generation guarantee. |
| A5 privacy | Existing dashboard jail remains. Full native filesystem/terminal/provider isolation must be proven against the shipped Linux runtime. |
| A6 coordinator-only relay | Covered locally, including aliases, pre-admission denial, normal-mode compatibility, and coordinator-bound requests. |
| A7 session-only memory/context | Pending native enforcement. The managed instructions describe the rule but cannot enforce native memory writes, external recall, cached system prompts, session compaction or private group context. |
| A8 shared media | Not implemented. Existing per-bot media boundaries remain. |
| A9 delayed results | Existing durable exchanges and wait/reconciliation behavior remain; team-specific live/restart qualification is still required. |
| A10 reminders/phone | Pending channel selection, explicit account connection, and actual device evidence. |
| A11 orphan job failures | Pending authoritative scheduler-job provenance. No historical failures were dismissed or relabeled without that evidence. |
| A12 external facts | Source/time/staleness instructions are included. Consistent native result metadata and real answer acceptance remain pending. |

Paid-execution restrictions must also be enforced at the actual model/tool execution owners before team tasks qualify under the confirmed no-paid-lane policy. Roles and messaging require the remaining operator choices. Production version/image verification and deployment are separate work; no production writes, deployment, or push were performed here.

## Verification

Use `npm test` in server/, `npm test`, `npm run lint`, `npm run build`, and `npm run test:e2e` in web/. The new team tests cover exact approvals, unauthorized bot actions, persistence, source/destination isolation, repaired edits, safe pruning, stale status, rollback-as-new-proposal, and explicit UI review. Browser tests use declared API fixtures; they do not execute live bot tasks or establish native/device acceptance.
