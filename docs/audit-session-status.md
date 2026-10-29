# HOB audit implementation status

29 October 2026. Starting commit: `8326bf6c`. This working-tree implementation follows the [audit plan](audit-remediation-plan.md). Work is ordered by dependencies and evidence, with no engineering-day estimates. Historical audit inputs and benchmark scores are preserved.

## Product coverage

“Implemented” below describes repository behavior and local verification. It does not close a requirement that depends on a deployed image, physical device, or real model/provider evaluation.

| ID | Implemented behavior | Evidence and remaining acceptance |
| --- | --- | --- |
| U01 | Locale-aware conversation dates; full timestamp tooltip; bounded title/date layout | Date regression and Chromium drawer test pass. |
| U02 | Deduplicate repeated image URLs within each message, preserving distinct images and code examples | Chromium covers MEDIA/Markdown/@image repetition plus two distinct results. Alternate URLs for identical bytes are not content-hash deduplicated. |
| U03 | Primary navigation labels the actual scope “Search chats” | Drawer search remains scoped to the selected bot's conversations; global full-text search is outside this implementation. |
| U04 | Focus search on opening the conversation drawer | Chromium focus assertion passes at tablet widths. |
| U05 | Escape closes the drawer; Tab stays inside it; focus returns to its opener | Chromium keyboard regression passes. |
| U06 | Separate no-conversation and no-match messages with Clear search | Browser regression retained from the previous fix. |
| U07 | Inspector starts closed below 1280px; explicitly opened tablet inspector is an overlay | Chromium verifies initially visible chat at 768, 820 and 1024px. Physical tablet rotation/device acceptance remains. |
| U08 | Direct Settings entry in the phone dock | Browser navigation and history regression pass. |
| U09 | Dock tracks the actual route, including browser Back and same-tab navigation | Prior regression retained and extended to Settings. |
| U10 | Coarse-pointer buttons and download controls receive 44px minimum touch dimensions | Chromium touch emulation at 320px verifies dock target dimensions. Complete spacing, screen-reader, motor-accessibility, and physical-device review remains. |
| U11 | Removed maximum-scale and user-scalable restrictions | Viewport changed; physical pinch zoom, high zoom/reflow and keyboard checks remain. |
| U12 | Coarse-pointer text inputs use 16px; reusable form inputs use 16px on phones | Build and phone browser regressions pass. Actual iOS keyboard/focus behavior remains. |
| U13 | 1024px no longer starts with three competing panes | Chromium tablet layout check passes. |
| U14 | Explicit record/stop/cancel, separate consent to transcription, editable draft, no auto-send; one minute / 1 MB limits | Browser uses synthetic recording bytes to verify permission/action sequencing, cancellation, denied permission and editable output. Server tests cover 20 synthetic requests, consent, byte validation, profile scope and transcript-only projection. No real speech-quality score or mobile microphone acceptance is claimed. |
| U15 | Shared input rejection plus authoritative native parser preview before any schedule create/edit | Server invalid-input/no-write regressions and browser save gating pass. Rebuilt Linux image must qualify the real native extension. |
| U16 | Daily/interval/one-time/advanced choices; native next-run and effective timezone preview; preview invalidates when input changes | Browser flow passes. Native timezone/DST, missed-run and lifecycle acceptance on the image remains. |
| U17 | Profile-scoped native memory queue, exact pending payload, revision-bound approve/reject and durable decision metadata | Native helper tests cover stale revisions, exact-once acknowledgement, precondition rejection, uncertain outcomes and hard-link refusal. Full-image memory/provider acceptance and operator reconciliation of uncertain writes remain. |
| U18 | Effective policy On/Off, saved/inherited source, bot scope and existing-conversation applicability | Existing authoritative learning adapter tests retained. Real model foreground/background policy fixtures remain. |
| U19 | Selectable skill queue and complete native diff; search and pagination; old unversioned mutation endpoint refuses decisions | Chromium verifies a diff beyond 3000 characters and stale-decision recovery. Native owner, not a chat-truncated command, applies changes. Image acceptance remains. |
| U20 | Per-bot language preference applied to native reply hint and title-generation configuration; explicit revision-checked title correction | Server tests preserve existing hints, reject invalid settings and bind titles to their owner/revision. Browser save/reload/scoping checks included. The required labelled Roman Urdu/mixed-language model evaluation remains unrun. |
| U21 | Supported local result links publish independent copies to the existing workspace `artifacts/`; checksummed delivery receipts, visible failure notices, scoped binary downloads and restart observation of retained completion receipts | 20 controlled files survive publisher restart and a copied workspace/state restore; cross-bot/hard-link rejection and receipt recovery without model replay pass. This is not proof of arbitrary scratch locations, complete machine backup, power-loss durability, or 20 live model-generated deliverables. Sources outside assigned roots must first be copied by the owning bot. |
| U22 | Optional role during bot creation; existing native role/identity synchronization and editable About retained | Existing role round-trip/browser tests retained; onboarding has an explicit role field. Real deployed restart acceptance remains. |

## Naming and upgrade behavior

The product, supported source, deployment service, examples and CI names use `hob` / `HOB_*`. Old names remain only for migration, defensive secret filtering, historical source/volume references and migration tests. Supplied audit filenames, private operator configuration, third-party reference trees, and this IDE checkout's directory name are not rewritten.

`server/hob-config.mjs` migrates old environment names without overriding canonical values and moves a single local legacy data directory without losing contents. Ambiguous dual directories stop startup. Browser preference migration preserves canonical values and tolerates disabled storage. Both have regressions. Cookie renaming requires a new login. Existing Coolify secrets must be copied into the new generated-variable names, and its proxy assigned to `hob`; see [the concrete upgrade procedure](../deploy/COOLIFY.md#upgrade-to-the-hob-namespace).

## Runtime ownership and recovery

The pinned runtime remains Hermes commit `7e9eb8d9a30f4a9bb9f8ecaf816b4b0ffdf47357`. The application adds a checksum-qualified native JSON router for schedule previews and proposal reviews, alongside the existing heartbeat fix. Both source hashes must match at image build; an unknown upstream router fails the build. A complete image rebuild is required.

The review extension reads the native pending store and delegates application to native memory/skill appliers with their preconditions. Decisions claim a proposal before applying it. A crash or audit failure after application leaves an unresolved claim; another request cannot blindly apply it again. Decision history is metadata, not automatic rollback. Preserve native state, claims and audit together for manual reconciliation. The audit is not an independently tamper-proof security boundary against a process with the same filesystem identity.

Delivery recovery observes retained native terminal receipts in bounded batches; it never resubmits a turn. Expired receipts cannot manufacture results or erase a known terminal outcome. Publication keeps original files, requires independent bounded files under assigned roots, and uses atomic destination links to avoid overwriting a different artifact. Workspace files and private receipt metadata must be backed up together. The file format/path allowlist is not a general secret-classification system.

## Verification record

- Full server suite after delivery-recovery refinement: 455 passed, two platform-specific skips.
- Web unit suite: 55 passed. Production build and lint passed.
- Browser suite: 34 passed in the full run. The subsequently added 320px touch-target/input-size test passed separately, for 35 passing cases. Its CSS refinement also passed build and lint.
- Deployment unit suite: 28 passed, including source qualification and smoke fixtures. Native review helper: eight passed, including store-path and malformed-decision refusal.
- Mobile: TypeScript check and three tests passed. No physical Android/iOS build or microphone test is claimed.
- Existing full server checks exercise real local Chromium human leases, raw CDP gating, persistent per-bot cookies, viewer load and crash recovery. These are local regressions, not production latency or Linux isolation certification.

## Open acceptance and implementation scope

Docker is unavailable in this Windows session. The rebuilt Linux image, qualified native router integration, OS-user ACLs, deployment TLS/front-door authentication, and container crash/recreation checks have not been run here. CI smoke coverage now exercises native schedule previews, revision-bound skill decisions and artifact download, but those results remain pending until the workflow runs against this revision.

Native model-turn and wall-clock limits are configurable per bot. An aggregate hard currency cap across provider, tool, background and delegated calls is **not implemented**; the UI says so. Release scope requiring that cap remains open. Existing browser metrics/load evidence does not establish the audit's broader stage-level latency/cost instrumentation or optimization targets.

The original 12-case benchmark is unchanged. No paid inference, expanded 100-task/300-attempt evaluation, live speech corpus, 40-case locale score, competitor run, or independent production review occurred. Those acceptance gates remain explicit in the plan rather than being marked passed from fixtures. The application remains a beta; this session does not certify production readiness.
