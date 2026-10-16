# OpenClaw P0a Safety Baseline — Implementation Report

Continuation on the current headless checkout, 2026-10-05. P0a defaults and authority fences were already implemented. This run verified the preserved backend source, corrected three headless administration surfaces, and retried canonical verification. **Canonical tests, typecheck, lint and build remain blocked before execution by missing dependencies. This is not a release-ready result.** No additional phase was implemented or commit created.

## 1. Source Identity

The parent workspace owns Git; `openclaw/` and `hermes-agent/` have no independent Git repository or submodule boundary. Parent HEAD at continuation: `1833b0c6681381d23f220d802e1414ae888f9457` (`removed native openclaw clients`). Parent remote: `https://github.com/abdlx/hob`. Parent status was clean apart from a denied global-ignore-file warning. Both imports and `p0a-evidence/` remain ignored; a clean parent status does not prove an unchanged import.

Every current file was hashed before edits. OpenClaw's 44,056 files exactly matched the recorded post-cleanup manifest. Hermes's 17,257 files exactly matched the original reference baseline. No added/deleted files or unrecorded source changes were found. The baseline is hash-manifest-based; this parent commit is not an upstream OpenClaw source identity.

Continuation baseline OpenClaw manifest SHA-256: `54479650c14fa648626669aa586d4ec7627a09cf4a1d1c78f2e5d61fa824c9bc`. It is in `p0a-evidence/p0a-continuation/openclaw-baseline-manifest.json`. Recovery uses the existing verified original and pre-cleanup ZIPs, the headless patch/manifests, and byte-exact copies of the three new affected files in `p0a-evidence/p0a-continuation/before/`.

Previously proven import correspondence remains historical evidence: OpenClaw commit `306da58672fd412858e5e24d5dde6ad74268010c` matched 52,507/52,509 original blobs, with two pre-existing completion-runtime differences; Hermes commit `1298c8e74baa73e1a2b90124228d017261ac6bc4` matched normalized original content, with 30 CRLF-only differences. Neither current raw-byte identity nor executable modes are claimed. The current OpenClaw tree additionally contains P0a and the user-authorized headless divergence. See the original implementation report for full upstream comparison evidence.

## 2. Pre-Change Test Baseline

The verified continuation tree matches the prior headless source manifest, so recorded pre-continuation toolchain evidence is retained. No canonical test counts were available before this follow-up.

| Command | Result | Passed | Failed | Classification |
| --- | --- | --- | --- | --- |
| Prior `node --import ./scripts/tsx.mjs scripts/test-projects.mts <headless/P0a selectors>` | Exit 1 before collection: dependencies missing | Not collected | Not collected | ENVIRONMENTAL |
| Prior `node scripts/run-tsgo.mjs -p tsconfig.core.json` (cache flags recorded in evidence) | Exit 1: TypeScript missing | Not run | Not run | ENVIRONMENTAL |
| Prior `node --import ./scripts/tsx.mjs scripts/run-lint.mts` | Exit 1 before lint startup | Not run | Not run | ENVIRONMENTAL |
| Prior `node --import ./scripts/tsx.mjs scripts/build-all.mts` | Exit 1 before build startup | Not run | Not run | ENVIRONMENTAL |
| Preserved original resolver, rerun now: `node ../p0a-evidence/config-source-smoke.mjs before` | Exit 1: unsafe original defaults violate safe-default assertions | 5/18 supplemental assertions | 13/18 supplemental assertions | PATCH_RELEVANT original behavior |

Node is still `v25.3.0`, outside `>=24.16.0 <25 || >=26.1.0`. Package-owned pnpm is integrity-pinned to 12.5.1. `openclaw/node_modules` is absent. The previously recorded Device Guard denial was not bypassed or blindly retried. No dependency version, lockfile or toolchain substitution was made. Earlier commands/errors remain in `p0a-evidence/headless/canonical-verification-attempts.json` and the original P0a report.

## 3. Verified Original Behavior

The authoritative original ZIP was inspected again. `src/skills/workshop/config.ts`, `resolveSkillWorkshopConfig()`, original lines 26/28:

```ts
mode: autonomous.mode === "off" || autonomous.mode === "propose" ? autonomous.mode : "auto"
approvalPolicy: raw.approvalPolicy === "pending" ? "pending" : "auto"
```

Both dimensions independently failed open. Current lines 26/28 require exact explicit `auto`; all other unrecognized values fall back to `propose`/`pending`.

Important downstream owners rechecked:

| File / symbol | Authority and side effect |
| --- | --- |
| `src/skills/workshop/experience-review-default.ts`, `scheduleSkillExperienceReview()` | Resolves current runtime config when delayed work is admitted. |
| `src/skills/workshop/experience-review.ts:40`, `prepareSkillExperienceReviewCandidate()`; line 129 and `assertSourceCurrent()` | Off refuses review; propose restricts the reviewer to one pending Workshop mutation. Current mode/source authority is checked during retained execution. |
| `src/agents/tools/skill-workshop-tool.ts:142`, `createSkillWorkshopTool()` | Off rejects autonomous foreground repair; propose stages it; explicit auto follows proposal/apply. Current mode and lifecycle policy are checked at activation. |
| `src/skills/workshop/policy.ts:148`, `resolveSkillWorkshopToolApproval()` | Missing lifecycle config requires allow-once/deny approval. Captured auto cannot skip approval after current policy revocation. |
| `src/skills/workshop/apply-transition.ts:67`, `applySkillProposalTransition()` | Read, evaluate, target hash/lock, scan, write and store commit receive current-authority assertions. Recovery remains available after refusal. |
| `src/skills/workshop/collection-restore.ts:34`, `restoreLatestSkillCollectionBackup()` | Retains forward restore authority; collection rollback fences each forward write without forbidding recovery. |
| `src/cron/skill-collection-review-monitor.ts:214`, `resolveSkillCollectionReviewMonitorSpecs()` | Missing/off/propose produces disabled system monitor rows; explicit auto alone enables eligible weekly review. |
| `src/gateway/server-cron.ts:580`, `runIsolatedAgentJob` | Even an old enabled monitor cannot execute outside current explicit auto. Retained admission checks current mode. |
| `src/gateway/server-reload-utils.ts:42`, `revokeActiveSkillReviewsBeforeConfigPublication()` | Cancels active weekly declarations before publishing a non-auto mode. |
| `src/commands/doctor/shared/legacy-config-migrations.runtime.skills.ts:19`, migration `apply()` | Retired false maps to off; other present retired values map to propose; an existing mode wins. Absence is never auto consent. |

## 4. Implemented Behavior

| Input/action | Autonomous mode | Lifecycle approval |
| --- | --- | --- |
| Missing | propose | pending |
| Explicit off | off | Independent explicit policy, otherwise pending |
| Explicit propose | propose | Independent explicit policy, otherwise pending |
| Explicit auto | auto | Still pending unless separately explicit auto |
| Invalid/unknown field | Safe resolver fallback to propose; authored schema rejects invalid enums | Safe fallback to pending; authored schema rejects invalid enums |
| Retired enabled=false | Doctor maps to off | Unchanged; omitted policy remains pending |
| Retired enabled=true/other present value | Doctor maps to propose when mode absent | Unchanged |
| Existing explicit mode during migration | Preserved, including auto | Explicit policy preserved |
| Normal headless enable | CLI explicitly sets propose | Remains pending by default; docs show explicit pending |
| UI-enable / auto selector | No bundled UI exists after the user's cleanup | External clients use existing validated config APIs; no UI was restored |

The enums and canonical resolver remain existing OpenClaw owners. Propose-mode work remains pending unless an explicit operator action or separately explicit policy authorizes lifecycle activation. Learning off does not prohibit a human from inspecting/applying their own existing proposal.

**Boundary:** explicit-auto background/weekly maintenance still uses existing ordinary file tools. Converting every autonomous mutation to universal staging is P1, explicitly deferred by the task. P0a does not claim to have implemented that stronger pipeline.

## 5. Files Changed

This continuation changes only:

| File | Purpose | Why necessary |
| --- | --- | --- |
| `src/skills/workshop/policy.ts:144` | Expired approval directs the operator to CLI inspect, then explicit lifecycle action | The bundled UI is removed; recovery instructions must provide a usable headless review path. |
| `docs/tools/self-learning.md:20` | Adds CLI proposal-mode/pending-policy setup and list/inspect/apply sequence | Documents both independent settings without silently granting auto. |
| `docs/tools/skill-workshop/configuration.md:18` | Replaces mandatory bundled-UI setup guidance with CLI setup and optional external UI | Matches the user's current headless distribution. |

The already-present P0a resolver, schema, Doctor behavior, authority fences and regression tests were preserved. Original P0a changes and subsequent client removal are separate historical patches; they are not new changes in this continuation.

## 6. Migration Behavior

Fresh and previously missing config resolves to propose/pending without rewriting config or granting consent. Explicit off/propose/auto values survive. Doctor only maps an actually present retired boolean and does not infer intent from files or old job history. Existing invalid authored config follows schema diagnostics and never becomes automatic authority through the resolver.

Weekly system monitors are converged disabled for omitted/off/propose mode; retained rows/history are not authorization. Removed-agent/duplicate cleanup remains the existing cron owner's behavior. Old enabled jobs are checked again at execution. Pending proposals retain their state. Foreground auto activation, lifecycle auto apply/restore and background work carry current-owner checks; non-auto config publication cancels active weekly declarations. Tests for these races exist but remain unexecuted here. Already-running shell/process side effects and transactional direct-file staging are not claimed solved.

## 7. Tests Added/Changed

No tests were added or changed for this three-file copy/documentation follow-up. Existing meaningful P0a regressions remain:

- `src/skills/workshop/config.test.ts`: omitted/default, explicit enums, malformed values, JSON round-trip, independent opt-ins and ignored retired runtime key.
- `src/skills/workshop/policy.test.ts`: omitted policy approval for four lifecycle actions; explicit auto; revocation and no retroactive upgrade of captured pending authority.
- `src/cron/skill-collection-review-monitor.test.ts:84`: missing/off/propose retains disabled monitor rows; explicit auto eligibility is separate.
- `src/commands/doctor/shared/legacy-config-migrations.runtime.retired.test.ts`: conservative legacy conversion and preservation of existing mode.
- `src/skills/workshop/experience-review.apply.test.ts:783`: enabling auto during a propose review leaves the draft pending.
- `src/skills/workshop/service.test.ts:166`, workspace write/restore suites, foreground repair and collection-restore suites: pending state and file recovery when forward authority is revoked.
- Schema/help suites: optional valid enums, rejection of invalid authored values and documented defaults.

The prior UI regressions were removed with the user-authorized Control UI deletion. Adding a replacement frontend or manufacturing UI tests would contradict the headless scope.

## 8. Post-Change Verification

| Command | Before | After | Status |
| --- | --- | --- | --- |
| `node scripts/run-vitest.mjs run <15 existing backend P0a test files>` | Canonical runner previously blocked; this expanded selector is a new attempt | Exit 1 before collection, local tsx missing | ENVIRONMENT ISSUE |
| `node scripts/run-tsgo.mjs -p tsconfig.core.json` | Exit 1, missing tooling | Exit 1, TypeScript missing | ENVIRONMENT ISSUE |
| `node --import ./scripts/tsx.mjs scripts/run-lint.mts` | Exit 1 before startup | Same missing dependencies | ENVIRONMENT ISSUE |
| `node --import ./scripts/tsx.mjs scripts/build-all.mts` | Exit 1 before startup | Same missing dependencies | ENVIRONMENT ISSUE |
| Actual resolver source smoke | Original 5/18, exit 1; prior P0a 18/18 | Current 18/18, exit 0 | PASS, supplemental only |
| `node --check src/skills/workshop/policy.ts` | Prior source passed syntax checks | Exit 0 | PASS, syntax only |
| Complete file manifests and lock digest | Current headless baseline verified | Exactly three intended source/doc files changed; no new/deleted source files; Hermes unchanged | Integrity verification |

All exact commands, outputs, exit codes and elapsed times are in `p0a-evidence/p0a-continuation/verification.json`. No unit tests were collected; no skipped/pass/fail suite counts are invented. The unsupported Node smoke run is not a substitute for Vitest, native SQLite, browser, concurrency, type or build validation. There is no proven new regression, but blocked gates cannot exclude regressions. No full suite or UI build was run.

## 9. Security Review

| Question | Source conclusion / verification limit |
| --- | --- |
| Can absent config still result in auto? | Not through the audited Workshop resolver: exact explicit auto is required for each independent field; source smoke proves omission behavior. |
| Can malformed config result in auto? | Unknown values fall back safely; strict schema rejects authored invalid enums. A separately valid explicit auto in the other dimension remains explicit consent. |
| Can normal enable result in auto? | Headless instructions set propose. There is no bundled UI enable path. Literal auto requires an explicit config action. |
| Can Doctor grant auto from absence? | No: absent retired key does nothing; retired true maps to propose; existing literal auto is preserved. |
| Can an old background job retain implicit auto? | Its row cannot authorize execution: resolver-backed convergence and execution checks require current explicit auto. |
| Can stale work activate after changes? | Source carries current mode/policy/source assertions to admission, apply/write/store commit and restore; weekly reload revokes active declarations. Race tests were not executed. Existing already-running process side effects remain a limit. |
| Are CLI/API/runtime semantics consistent? | Existing validated config key and owner are reused. CLI setup/review instructions now match headless capabilities. UI functionality was not duplicated or reintroduced. |
| Does explicit auto still work? | Resolver preservation is exercised; source keeps existing auto paths. Full execution/integration remains unverified. |

## 10. Diff Summary

This continuation: **3 files, 30 inserted lines, 3 deleted lines; zero tests changed; zero dependency/lock/generated source changes.** No Hermes or parent frontend edits. No source files were added or deleted. Exact new patch: `p0a-evidence/p0a-continuation/headless-P0a-follow-up.patch`, SHA-256 `429c10e70e0a49ff72c8813c14e78c11a605d582ac472508c152d88e5acc119e`. New manifests, backups, logs and this report are evidence/deliverables outside OpenClaw.

No final commit: OpenClaw is intentionally ignored and lacks its own history; force-adding whole imported files would not form a clean upstream patch. Canonical verification also remains incomplete. Existing user commit/ignore ownership was preserved.

## 11. Deferred Work

P0b scanner expansion, P0c generalized Trust Engine/content attestation, P1 universal autonomous Workshop staging, P2 bounded canonical memory, P3 cloud execution adapters, and a Muse-compatible resource protocol remain outside this patch. No Hermes implementation was imported.

## 12. Recommended Next Step

Close P0a verification with organization-approved supported Node and pinned pnpm, then frozen-lockfile installation and the recorded backend tests, typecheck, lint and build. Device Guard must not be disabled or bypassed. UI checks from the old report no longer apply to this headless checkout.

After P0a verification, **P0b** should begin at `src/skills/security/scanner.ts` (`SkillScanFinding`, `SkillScanOptions`, `scanSkillContent()`, `scanDirectoryWithSummary()`), `src/skills/workshop/proposal-scan.ts` (`scanProposalBundle()`), apply's existing quarantine/scan boundary, and `src/plugins/install-security-scan.runtime.ts` (`evaluateSkillInstallPolicyRuntime()`).

**P0c** should begin at `src/skills/library/bundle.ts` (`prepareSkillBundle()`, `prepareSkillLibraryBundle()`), `src/skills/workshop/proposal-bundle.ts`, `service-evaluation.ts`, `store-authority.ts`, `store-sqlite-schema.ts`, and plugin `plugin-trust.ts`/install provenance. Bind future verdicts to immutable content revisions while retaining separate permission and action approval owners. No such design was implemented here.
