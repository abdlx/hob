# OpenClaw P0a Safety Baseline — Implementation Report

P0a source changes are implemented and reviewed. Omitted or malformed Workshop authority now resolves to **propose/pending**; explicit modes and policies remain supported. Normal UI enable writes **propose**. Current-authority checks protect retained review, apply and restore operations using existing OpenClaw mechanisms.

**Verification remains incomplete.** Canonical tests, typechecking, lint, build and browser/i18n validation could not execute because the required dependency installation was blocked by Windows Device Guard. This is a reviewable source patch, not a release-ready or fully tested result. No final commit was created. Hermes is unchanged.

## 1. Source Identity

The containing workspace owns Git. Neither import has its own `.git` directory/file, remote, or submodule entry. Git discovery inside either import resolves to the parent repository; it does not identify an upstream revision. Both imports were already ignored by the parent's `.gitignore`. No `git init`, reset, clean, checkout-over, restore-over, stash, or source-format command was used.

At initial inspection the parent had an initial commit, recorded as `2ae42184b9078914400199a7f84779ed64073028`, and remote `https://github.com/abdlx/hob`. There were no tracked import changes to inspect because both trees were ignored; every import file was therefore inventoried and hashed. The parent acquired independent web-app work during this task. Its final observed HEAD is `4dd1f9a886e95d3d1e0fadd28c91943d60339c53`; that work was preserved. No parent ignore rule or web file was changed by this patch. Before writing this deliverable the parent status was clean, subject to a denied global-ignore-file warning.

Official commit metadata and complete recursive Git trees were compared against the preserved imports, rather than inferred from package versions:

| Import | Best verified upstream correspondence | Proven limits |
| --- | --- | --- |
| OpenClaw | [306da58672fd412858e5e24d5dde6ad74268010c](https://github.com/openclaw/openclaw/commit/306da58672fd412858e5e24d5dde6ad74268010c), 2026-10-04 13:27:36Z. All 52,509 candidate blobs present, no extra baseline files; 52,507 exact original-byte matches. | Two existing source differences: `src/cli/completion-runtime.ts` and its test preserve escaped trailing shell-profile spaces. Neither was touched. This is **not an exact upstream tree**; executable modes are also unproven on Windows. Matching release version `2026.9.8` did not establish provenance; that release tree was disproved. |
| Hermes | [1298c8e74baa73e1a2b90124228d017261ac6bc4](https://github.com/NousResearch/hermes-agent/commit/1298c8e74baa73e1a2b90124228d017261ac6bc4), 2026-10-04 12:23:37Z. All 17,257 candidate blobs present: 17,227 exact and 30 PowerShell CRLF-only differences. | Normalized content corresponds; raw-byte and executable-mode identity are not claimed. Final full local file inventory and hashes match the original local manifest exactly. |

The reproducible baseline is **hash-manifest-based**, not a source-repository commit:

| Artifact | SHA-256 |
| --- | --- |
| [openclaw-baseline-manifest.json](<D:/code/github-projects/Mused - OpenMuse/p0a-evidence/openclaw-baseline-manifest.json>) | `de03d1ebb9579326abaf281bbb75738455866d6fe370201adfaf3300a41667a9` |
| [hermes-agent-baseline-manifest.json](<D:/code/github-projects/Mused - OpenMuse/p0a-evidence/hermes-agent-baseline-manifest.json>) | `3a6fc24724b44d46b44051c55d166392b5fc0c7a335edf10032272748b249fd5` |
| [openclaw-baseline.zip](<D:/code/github-projects/Mused - OpenMuse/p0a-evidence/openclaw-baseline.zip>) | `015f57742b30053f7df593a29c9fe1c6c77177616c4078d44bb2d1672b5b389e` |

All 52,509 ZIP members were reverified against the original manifest. The frozen package-manager bootstrap briefly added its own lock metadata before being denied. The earlier `openclaw-before.zip` consequently contains that tooling mutation and is **not the authoritative original baseline**. Only that known lock change was restored, guarded by both before/current SHA-256 and exact matching official candidate bytes. The corrected ZIP replaces only those verified lock bytes. Original lock digest: `a5ab3b496b8d21308fa04bf907a0f7eeab38ad055c5abe766becc4a5d7a3f029`. No lockfile change remains in P0a. See [provenance-and-prerequisites.md](<D:/code/github-projects/Mused - OpenMuse/p0a-evidence/provenance-and-prerequisites.md>) for complete comparison artifacts and the correction history.

Final source patch: [P0a.patch](<D:/code/github-projects/Mused - OpenMuse/p0a-evidence/P0a.patch>) (SHA-256 `66292be1d833a53d5198283a21ab49bfabb3dbbd930f2a1192ccb7e5ee8b166e`); file hashes/counts: [patch-inventory.json](<D:/code/github-projects/Mused - OpenMuse/p0a-evidence/patch-inventory.json>). Replaying this patch on extracted baseline files produces all 46 final file bytes exactly. The original completion divergence stays outside the patch.

## 2. Pre-Change Test Baseline

The checkout requires Node `>=24.16.0 <25 || >=26.1.0` and integrity-pinned pnpm `12.5.1` ([package.json](<D:/code/github-projects/Mused - OpenMuse/openclaw/package.json:2381>)). The installed Node was `v25.3.0`, an unsupported major; installed pnpm was `11.13.0`. `openclaw/node_modules` was absent. CI primary/Windows lanes use Node 24.21.0. Frozen installation was attempted without changing dependency versions; after an approved network retry, Device Guard denied the downloaded pinned `pnpm.exe`. The denied executable was not renamed, repackaged, or run through an alternate entry point.

| Command, from `openclaw/` unless stated | Result | Passed | Failed | Classification |
| --- | --- | --- | --- | --- |
| `pnpm.cmd install --frozen-lockfile` | Nonzero; initial registry restriction, then pinned executable blocked by Device Guard | — | — | ENVIRONMENTAL |
| `node scripts/run-vitest.mjs run` with initial Workshop config/policy/tool/experience/cron/Doctor/UI selectors | Exit 1 before collection: local tsx dependencies missing | Not collected | Not collected | ENVIRONMENTAL |
| `node scripts/run-tsgo.mjs -p tsconfig.core.json` | Exit 1 before typechecking: local tooling missing | — | — | ENVIRONMENTAL |
| `node scripts/run-oxlint.mjs --tsconfig tsconfig.core.json src/skills/workshop/config.ts` | Exit 1 before linting: local tooling missing | — | — | ENVIRONMENTAL |
| `node --import ./scripts/tsx.mjs scripts/build-all.mts` | Exit 1 before build: local tsx missing | — | — | ENVIRONMENTAL |
| `node p0a-evidence/config-source-smoke.mjs before`, from workspace | Exit 1; supplemental assertions against preserved original resolver | 5/18 | 13/18 | PATCH_RELEVANT: original unsafe defaults, not canonical test failures |

The initial selector list included audit-era paths that later proved inaccurate (`src/skills/workshop/skill-workshop-tool.test.ts`, `src/commands/doctor-skill-workshop.test.ts`, UI `self-learning.test.ts`). The exact original attempt was:

```powershell
node scripts/run-vitest.mjs run src/skills/workshop/config.test.ts src/skills/workshop/policy.test.ts src/skills/workshop/skill-workshop-tool.test.ts src/skills/workshop/experience-review.test.ts src/cron/skill-collection-review-monitor.test.ts src/commands/doctor-skill-workshop.test.ts ui/src/pages/skill-workshop/self-learning.test.ts
```

The wrapper failed before path discovery, so this did **not** establish runnable baseline coverage. Correct source paths were discovered and used in the final verification commands. No meaningful repository test counts, skipped counts, or clean baseline can be claimed. No BASELINE_EXISTING code failure or flaky test was isolated; dependency failure occurred first. The earlier install command's numeric exit code was not retained in the final evidence bundle; its policy-denial diagnostic and failure are recorded without inventing a code.

Canonical tooling discovered from package scripts, workspace config, CI and test wrappers:

| Purpose | Repository command |
| --- | --- |
| Install | `pnpm install --frozen-lockfile` using the pinned package manager and supported Node |
| Core/UI production types | `pnpm tsgo:core`, `pnpm tsgo:ui` |
| Test types | `pnpm tsgo:core:test` (source/UI shards available) |
| Lint / complete checks | `pnpm lint`, `pnpm check`; changed-file routing: `node scripts/check-changed.mjs --dry-run` |
| Focused tests | `node scripts/run-vitest.mjs run <actual test paths>` / `pnpm test <paths> --maxWorkers=1` |
| Unit / broader tests | `pnpm test:unit`, `pnpm test` |
| UI/browser | `pnpm test:ui`, `pnpm test:ui:e2e` with Playwright Chromium prerequisite |
| Integration/E2E | `pnpm test:e2e` dispatches Gateway, agent/plugin/Gateway and UI lanes; no separate Workshop-only integration script |
| Build | `pnpm build` |
| UI copy validation | `pnpm ui:i18n:baseline`, `pnpm ui:i18n:verify` |

Native SQLite/tooling and Chromium requirements make arbitrary standalone dependency substitution insufficient. No dependency upgrade or lock regeneration was used as a workaround.

## 3. Verified Original Behavior

The original source preserved in the verified ZIP contains **two independent fail-open defaults**, both in `resolveSkillWorkshopConfig()` ([src/skills/workshop/config.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/config.ts:22>); original bytes in [before/workshop-config.ts](<D:/code/github-projects/Mused - OpenMuse/p0a-evidence/before/workshop-config.ts>)):

```ts
// Original line 26
mode: autonomous.mode === "off" || autonomous.mode === "propose" ? autonomous.mode : "auto"
// Original line 28
approvalPolicy: raw.approvalPolicy === "pending" ? "pending" : "auto"
```

Omission and any unknown value selected automatic behavior in either dimension. The schema's optional enums did not themselves provide defaults. The original UI independently used `mode ?? "auto"` at line 33 and `enabled ? "auto" : "off"` at line 52 of `self-learning.ts`.

Important consumers traced:

| Owner / symbol | Execution consequence |
| --- | --- |
| [src/config/types.skills.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/config/types.skills.ts:21>); [src/config/zod-schema.root-shape.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/config/zod-schema.root-shape.ts:560>) | Types derive the existing three-mode contract; schema accepts optional enums and rejects malformed authored values. No new enum or policy system needed. |
| [src/skills/workshop/experience-review-scheduler.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/experience-review-scheduler.ts:196>); [src/skills/workshop/experience-review.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/experience-review.ts:129>) | Off prevents reviewer work; propose gives the reviewer a pending-proposal mutation budget; auto selects Workshop-rooted ordinary file maintenance. Agent-end review uses this flow. |
| [src/agents/tools/skill-workshop-tool.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/agents/tools/skill-workshop-tool.ts:377>) and lines 515–580 | Foreground repair: off refuses autonomous repair, propose stages pending, explicit auto uses existing proposal/evaluation/apply path. Normal user-requested proposal work remains possible in off. |
| [src/skills/workshop/policy.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/policy.ts:148>); [src/agents/agent-tools.before-tool-call.approval.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/agents/agent-tools.before-tool-call.approval.ts:519>) | Agent lifecycle calls consult approval policy separately from autonomy. Apply/reject/quarantine/restore are approval-bearing actions. |
| [src/skills/workshop/apply-transition.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/apply-transition.ts:70>); [src/skills/lifecycle/workspace-skill-write.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/lifecycle/workspace-skill-write.ts:99>) | Proposal read/evaluation/locks/scan precede filesystem mutation and SQLite commit. Existing rollback recovers failed forward writes. |
| [src/skills/workshop/collection-restore.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/collection-restore.ts:34>); [src/skills/workshop/collection-rollback.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/collection-rollback.ts:8>) | Historical collection restore also mutates active files; it must carry the same retained authority as apply. |
| [src/cron/skill-collection-review-monitor.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/cron/skill-collection-review-monitor.ts:220>); [src/gateway/server-cron.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/gateway/server-cron.ts:580>) | Weekly system review enablement and execution require autonomy auto. The old resolver made omission satisfy that condition. |
| [src/gateway/server-cron-skill-review-jobs.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/gateway/server-cron-skill-review-jobs.ts>); [src/gateway/server-reload-utils.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/gateway/server-reload-utils.ts:42>); [src/gateway/config-reload-plan.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/gateway/config-reload-plan.ts:236>) | Startup/reload converge durable monitor rows; reload already cancels active skill-review declarations before publishing non-auto mode. |
| [src/gateway/server-runtime-services.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/gateway/server-runtime-services.ts:442>); [src/flows/doctor-core-checks.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/flows/doctor-core-checks.ts:186>) | Existing warning/diagnostic consumers use the canonical resolver. They do not independently grant mutation authority. |
| [src/commands/doctor/shared/legacy-config-migrations.runtime.skills.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/commands/doctor/shared/legacy-config-migrations.runtime.skills.ts:19>) | Existing retired-boolean migration is conservative: false→off; any other present value→propose; an already-set mode wins. |
| [src/commands/doctor-skill-workshop-automations.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/commands/doctor-skill-workshop-automations.ts>); [ui/src/pages/skill-workshop/self-learning.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/ui/src/pages/skill-workshop/self-learning.ts:22>) | Doctor automation relocation is not consent migration; UI config patches use the canonical key and optimistic config hash. |

CLI and Gateway proposal lifecycle handlers remain existing operator owners. They are not disabled by the autonomous-learning mode: a human can explicitly apply or restore while learning is off.

## 4. Implemented Behavior

The canonical resolver now uses exact positive consent:

```ts
mode: autonomous.mode === "off" || autonomous.mode === "auto" ? autonomous.mode : "propose"
approvalPolicy: raw.approvalPolicy === "auto" ? "auto" : "pending"
```

| Input | Autonomous mode | Lifecycle approval policy |
| --- | --- | --- |
| Missing / empty nested objects | propose | pending |
| Explicit off | off | `off` is not a policy enum; absent policy is pending |
| Explicit propose | propose | `propose` is not a policy enum; absent policy is pending |
| Explicit auto | auto when set on mode | auto only when separately set on approvalPolicy |
| Explicit pending | `pending` is not a mode enum | pending |
| Invalid / unknown | Normal schema rejects; defensive resolver falls back to propose | Normal schema rejects; defensive resolver falls back to pending |
| Retired enabled=false | Doctor migrates to off when mode absent | Unchanged; absent remains pending |
| Retired enabled=true or another present old value | Doctor migrates to propose when mode absent | Unchanged; absent remains pending |
| Normal UI enable / disable | propose / off | Leaves the independent policy unchanged |
| Deliberate advanced auto selection | Existing Settings enum editor or CLI/RPC explicitly writes auto | Existing Settings/CLI can independently choose policy auto |

```text
off       -> no autonomous capture/review/foreground repair
propose   -> existing reviewer -> pending proposal -> validation/review -> operator activation
auto      -> explicit consent for existing automatic behavior
             foreground repair still uses existing proposal/evaluate/apply

normal agent lifecycle action
  captured pending, missing or malformed -> approval required
  captured auto + current auto           -> skip additional approval prompt
  captured auto + revoked current policy -> cannot retain automatic activation authority
```

Off preserves suggestion-only nudges and human-requested work already supported by OpenClaw; those are not autonomous active-skill mutations. Auto and approvalPolicy remain independent. A deliberately configured policy auto is an explicit authorization for normal lifecycle calls even if autonomy is propose/off. No setting silently enables the other.

The schema remains optional without injecting concrete defaults, preserving the distinction between omission and persisted consent. Browser display has a small matching fallback because it consumes an editable serialized snapshot; execution authority stays with the server resolver. No new default was inserted into arbitrary background callers.

**Phase boundary:** existing explicit-auto per-turn and weekly direct file maintenance remains. It is not universally staged, scanned or rolled back through Workshop. The broader requested invariant that every autonomous auto mutation use the proposal pipeline requires deferred P1. Documentation now says this plainly.

## 5. Files Changed

Every path below is inside OpenClaw. Tests and narrow authority-callback plumbing account for much of the file count; no subsystem was renamed or reorganized.

| File | Purpose | Why Necessary |
| --- | --- | --- |
| [docs/tools/self-learning.md](<D:/code/github-projects/Mused - OpenMuse/openclaw/docs/tools/self-learning.md>) | Document propose/pending defaults and explicit auto limitations | Remove the unsafe-default recommendation and preserve truthful direct-edit documentation |
| [docs/tools/skill-workshop/authoring.md](<D:/code/github-projects/Mused - OpenMuse/openclaw/docs/tools/skill-workshop/authoring.md>) | Describe default lifecycle approval | Authors must not expect implicit apply authority |
| [docs/tools/skill-workshop/configuration.md](<D:/code/github-projects/Mused - OpenMuse/openclaw/docs/tools/skill-workshop/configuration.md>) | Update config example/default table and independent policies | Keep the configuration contract consistent with the resolver |
| [docs/tools/skill-workshop.md](<D:/code/github-projects/Mused - OpenMuse/openclaw/docs/tools/skill-workshop.md>) | Update self-learning entry-point wording | Avoid presenting generic enable as automatic activation |
| [docs/tools/skills-config.md](<D:/code/github-projects/Mused - OpenMuse/openclaw/docs/tools/skills-config.md>) | Update ParamField defaults and examples | Public settings documentation must match effective runtime defaults |
| [src/agents/agent-tools.before-tool-call.approval.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/agents/agent-tools.before-tool-call.approval.ts>) | Supply current config to Workshop approval owner | A captured auto policy cannot authorize a call after revocation |
| [src/agents/agent-tools.before-tool-call.embedded-mode.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/agents/agent-tools.before-tool-call.embedded-mode.test.ts>) | Exercise approval hook with captured/current policies | Prove current policy participates in lifecycle approval |
| [src/agents/tools/skill-workshop-tool-collection.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/agents/tools/skill-workshop-tool-collection.ts>) | Forward the host guard to collection restore | Restore is another active-skill mutation and needs the same fence |
| [src/agents/tools/skill-workshop-tool.collection-restore.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/agents/tools/skill-workshop-tool.collection-restore.test.ts>) | Cover manual restore and revoked automatic restore | Preserve operator workflows while rejecting stale auto authority |
| [src/agents/tools/skill-workshop-tool.review.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/agents/tools/skill-workshop-tool.review.test.ts>) | Make auto-policy intent explicit in relevant review fixtures | Existing unrelated review expectations must not depend on missing-config auto |
| [src/agents/tools/skill-workshop-tool.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/agents/tools/skill-workshop-tool.test.ts>) | Test pending apply, abort, explicit auto and foreground mode changes | Protect the public tool behavior across default and runtime transitions |
| [src/agents/tools/skill-workshop-tool.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/agents/tools/skill-workshop-tool.ts>) | Capture source guard; share lifecycle fence; recheck foreground auto | Prevent stale authority at proposal/apply/restore boundaries |
| [src/commands/doctor/shared/legacy-config-migrations.runtime.retired.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/commands/doctor/shared/legacy-config-migrations.runtime.retired.test.ts>) | Test omission, explicit mode preservation and repeat migration | Doctor must never turn absence into auto consent |
| [src/config/schema.help.quality.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/config/schema.help.quality.test.ts>) | Assert propose/pending help semantics | Help, schema and runtime must agree on independent authority dimensions |
| [src/config/schema.help.runtime.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/config/schema.help.runtime.ts>) | Update autonomy help and add lifecycle approval help | Expose the actual safe defaults in schema-driven settings |
| [src/config/schema.labels.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/config/schema.labels.ts>) | Label the existing approvalPolicy field | Keep the newly documented settings field readable |
| [src/config/zod-schema.core.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/config/zod-schema.core.test.ts>) | Test omission, invalid enums and JSON round-trip | Schema must not materialize an automatic default or discard explicit modes |
| [src/cron/active-jobs.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/cron/active-jobs.test.ts>) | Exercise prepared admission revocation and latching | Weekly host authority must reach existing runtime admission |
| [src/cron/isolated-agent/run-execution.types.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/cron/isolated-agent/run-execution.types.ts>) | Add the optional host assertion to execution parameters | Preserve a typed callback across the existing cron handoff |
| [src/cron/isolated-agent/run-executor.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/cron/isolated-agent/run-executor.ts>) | Forward assertion to cron admission | Do not lose current policy between preparation and agent execution |
| [src/cron/isolated-agent/run-prepare-runtime.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/cron/isolated-agent/run-prepare-runtime.ts>) | Accept optional source assertion | Existing cron execution requires a host-owned revocation seam |
| [src/cron/isolated-agent/run.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/cron/isolated-agent/run.ts>) | Pass source assertion through prepared execution | Complete existing callback plumbing without a new authorization system |
| [src/cron/run-admission.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/cron/run-admission.ts>) | Forward assertion to prepareAgentRunAdmission | Use existing source-authority latching for cron reviewers |
| [src/cron/skill-collection-review-monitor.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/cron/skill-collection-review-monitor.test.ts>) | Test missing/off/propose disabled and explicit auto behavior | Old implicit-auto scheduling must no longer resolve as authorized |
| [src/gateway/server-cron-skill-review-jobs.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/gateway/server-cron-skill-review-jobs.test.ts>) | Test disabled monitor convergence with row/state preservation | Enforce the default without deleting scheduler history |
| [src/gateway/server-cron.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/gateway/server-cron.test.ts>) | Test current-mode refusal in a retained weekly runner | Durable job enablement alone must not preserve old auto authority |
| [src/gateway/server-cron.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/gateway/server-cron.ts>) | Bind latest-mode/abort assertion to weekly review execution | A queued/in-flight system review must revalidate current auto permission |
| [src/skills/lifecycle/workspace-skill-write.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/lifecycle/workspace-skill-write.test.ts>) | Test revocation before activation and rollback after partial support writes | Filesystem fencing must stop forward writes while allowing recovery |
| [src/skills/lifecycle/workspace-skill-write.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/lifecycle/workspace-skill-write.ts>) | Pass optional guard into existing fs-safe write boundary | Checks must reach the actual mutation, not only the outer async caller |
| [src/skills/workshop/apply-transition.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/apply-transition.ts>) | Recheck guard around preparation, filesystem and store commit | Revocation during evaluation must not produce active bytes or committed status |
| [src/skills/workshop/collection-restore.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/collection-restore.test.ts>) | Test pre-write/mid-copy revocation and exact-byte recovery | Restore must respect current authority and retain usable backups |
| [src/skills/workshop/collection-restore.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/collection-restore.ts>) | Latch and forward optional restore authority | Avoid resurrection of a refused automatic invocation |
| [src/skills/workshop/collection-rollback.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/collection-rollback.ts>) | Check forward removals/copies; leave recovery unfenced | Refusing a restore must not prevent restoration of the previous collection |
| [src/skills/workshop/config.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/config.test.ts>) | Test default, explicit, malformed, independent and round-trip values | The canonical owner must fail closed into propose/pending |
| [src/skills/workshop/config.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/config.ts>) | Change two canonical fallback expressions | Absence or malformed authority is not consent |
| [src/skills/workshop/experience-review.apply.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/experience-review.apply.test.ts>) | Test review source mode revocation and changed default fixtures | Captured reviewer mode must not outlive present authority |
| [src/skills/workshop/experience-review.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/experience-review.ts>) | Revalidate current autonomy in existing source assertion | Retained auto review must stop after propose/off; propose must stop after off |
| [src/skills/workshop/policy.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/policy.test.ts>) | Test all lifecycle actions and captured/current policy combinations | Missing policy asks; explicit unrevoked auto still skips the extra prompt |
| [src/skills/workshop/policy.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/policy.ts>) | Require unrevoked explicit auto to skip approval | Keep approval distinct from autonomous mode |
| [src/skills/workshop/service.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/service.test.ts>) | Test commit-edge revocation and pending recovery | Pending proposals and original live bytes must survive failed activation |
| [src/skills/workshop/types.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/types.ts>) | Expose existing host guard on lifecycle action input | Apply can carry owner authority without serializing it into RPC data |
| [ui/src/e2e/skill-workshop-self-learning.e2e.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/ui/src/e2e/skill-workshop-self-learning.e2e.test.ts>) | Change enable/conflict-retry fixture and payload expectation to propose | Browser enable must not silently write auto |
| [ui/src/i18n/locales/en-skill-workshop.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/ui/src/i18n/locales/en-skill-workshop.ts>) | Explain pending suggestions and explicit automatic choice | UI language must describe the new semantics |
| [ui/src/pages/skill-workshop/header-controls.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/ui/src/pages/skill-workshop/header-controls.test.ts>) | Test missing/malformed, off/propose/auto and toggle-off behavior | Header state and warning logic must reflect explicit mode |
| [ui/src/pages/skill-workshop/self-learning.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/ui/src/pages/skill-workshop/self-learning.ts>) | Display safe fallback and write propose on enable | Normal UI enable is not automatic mutation consent |
| [ui/src/pages/skill-workshop/skill-workshop-page.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/ui/src/pages/skill-workshop/skill-workshop-page.test.ts>) | Test header/pitch enable payloads and retained admin restrictions | Every ordinary enable route must serialize propose |

The existing schema, Doctor migration implementation, weekly monitor owner, reload-cancellation owner and generic Settings editor already had suitable semantics once the resolver was corrected; they were inspected but not rewritten. No standalone `self-learning.test.ts` exists in this checkout: coverage belongs to the actual header/page tests.

## 6. Migration Behavior

No bulk configuration rewrite or intent inference was added. The effective runtime fallback changes on upgrade; omitted fields can remain omitted on disk.

| Existing state | Upgrade behavior |
| --- | --- |
| Fresh install / absent Workshop config | propose/pending at runtime; no implicit active-skill maintenance or lifecycle auto permission |
| Missing mode with existing scheduler row | New monitor specification is disabled; existing row identity/state/history is retained by normal reconciliation |
| Explicit off / propose | Preserved; independent missing policy resolves pending |
| Explicit auto mode | Preserved; weekly/per-turn automatic behavior remains subject to existing capability/cron eligibility; missing lifecycle policy now requires approval for ordinary agent lifecycle calls |
| Explicit auto approvalPolicy | Preserved independently; it does not convert omitted mode into auto |
| Retired boolean and no mode | false→off; true/other present old value→propose; remove retired key; never auto |
| Retired boolean with explicit mode | Keep that mode, including literal auto; remove retired key; repeat migration is stable |
| Invalid current mode / policy | Established schema validation rejects authored config. A defensive resolver caller gets propose/pending; Doctor does not promote malformed values to auto |
| Existing pending proposals | No state migration or automatic drain; they remain pending until explicit approval/apply |
| In-flight auto reviewer | Current-mode source assertion refuses auto→propose/off; propose→off also refuses; admitted refusal is latched |
| In-flight normal agent apply/restore | Captured automatic approval cannot survive current policy revocation; abort/source guard reaches preparation and commit/mutation boundaries; partial supported forward writes use existing recovery |
| In-flight weekly review | Existing cancellation before config publication plus latest-mode assertion carried to cron admission; a stale enabled row cannot authorize another review |

The old UI historically persisted literal auto on ordinary enable. This patch preserves **existing literal auto**, as instructed. There is no intent ledger that can prove whether a persisted auto came from that old toggle or a deliberate advanced setting. It would be incorrect to infer/downgrade intent from generated skills or scheduler history. The migration reliably distinguishes absent config from explicit stored config.

Retired historical review-job replacement remains existing OpenClaw behavior; P0a does not add row deletion. The new regression specifically proves row/state preservation for the current system monitor. No live config, scheduler database, proposal database, service or user skill was edited during this task.

Authority callbacks are optional host functions, not serialized RPC fields. Existing `prepareAgentRunAdmission` latching ([src/agents/admitted-run-context.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/agents/admitted-run-context.ts:499>)), source execution guard ([src/agents/agent-tool-source-execution-guard.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/agents/agent-tool-source-execution-guard.ts:65>)), fs-safe mutation checks and store broker are reused. Restore latches the callback through `retainMutationAuthority`; recovery deliberately does not inherit the refused forward fence.

There is no general ability to undo arbitrary side effects of an already-spawned child process. Current checks fence subsequent owner-controlled writes, spawns and activation; cancellation attempts to stop current work. P0a does not claim transactionality for direct-auto shell maintenance.

## 7. Tests Added/Changed

These are **authored regression contracts**, not claims that Vitest executed them. Twenty existing test files changed; parameterized cases cover the twelve requested safety properties.

| Test file | Meaningful contract |
| --- | --- |
| [src/skills/workshop/config.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/config.test.ts>) | Missing nested objects → propose/pending; all three explicit modes; both explicit policies; eight malformed values; independent opt-ins; JSON round-trip. Retired boolean is not a runtime authority field. |
| [src/skills/workshop/policy.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/policy.test.ts>) | Missing policy asks for apply/reject/quarantine/restore; explicit current auto skips approval; revoked captured auto asks; captured pending is not upgraded by later auto. |
| [src/agents/agent-tools.before-tool-call.embedded-mode.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/agents/agent-tools.before-tool-call.embedded-mode.test.ts>) | Approval hook uses latest owner policy even when a tool retained an older auto config; current explicit auto remains supported. |
| [src/agents/tools/skill-workshop-tool.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/agents/tools/skill-workshop-tool.test.ts>) | Pending draft remains pending after policy revocation; aborted apply does not activate; foreground auto→propose/off leaves pending; retained propose does not upgrade to auto; explicit auto path is preserved. |
| [src/agents/tools/skill-workshop-tool.collection-restore.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/agents/tools/skill-workshop-tool.collection-restore.test.ts>) | Operator-reviewed restore works in off/propose; captured auto approval revoked before restore or during forward copying refuses, recovers bytes and suppresses success hooks. |
| [src/agents/tools/skill-workshop-tool.review.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/agents/tools/skill-workshop-tool.review.test.ts>) | Existing review expectations that deliberately skip lifecycle prompts now configure explicit auto approval instead of relying on omission. |
| [src/skills/workshop/service.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/service.test.ts>) | Revocation at the final activation commit restores original bytes and keeps proposal pending; no success lifecycle commit is recorded. |
| [src/skills/lifecycle/workspace-skill-write.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/lifecycle/workspace-skill-write.test.ts>) | Default filesystem writer checks authority at mutation; revocation after an earlier support-file write restores those exact previous bytes. |
| [src/skills/workshop/collection-restore.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/collection-restore.test.ts>) | Revocation after preparation before the first live mutation; revocation within per-entry copy; exact active/support bytes and original backup bytes preserved. Existing failed-recovery retention tests remain. |
| [src/skills/workshop/experience-review.apply.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/experience-review.apply.test.ts>) | Propose→off, auto→propose and auto→off revoke admitted source authority. Existing automatic-review fixtures declare auto explicitly. |
| [src/cron/skill-collection-review-monitor.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/cron/skill-collection-review-monitor.test.ts>) | Missing/off/propose disable the system review; explicit auto retains enabled behavior subject to existing eligibility rules. |
| [src/gateway/server-cron-skill-review-jobs.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/gateway/server-cron-skill-review-jobs.test.ts>) | An existing monitor under omitted mode becomes disabled while retaining id, creation time and state/history identity; explicit-auto convergence remains covered. |
| [src/gateway/server-cron.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/gateway/server-cron.test.ts>) | Previously captured weekly review refuses after current mode becomes propose/off, including when durable reconciliation has not completed. |
| [src/cron/active-jobs.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/cron/active-jobs.test.ts>) | Host assertion reaches prepared cron admission; once refused, re-enabling auto does not resurrect that same admitted operation. |
| [src/commands/doctor/shared/legacy-config-migrations.runtime.retired.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/commands/doctor/shared/legacy-config-migrations.runtime.retired.test.ts>) | Absent legacy/current field does not synthesize auto; explicit off/propose/auto survive retired-key migration; existing boolean cases and repeat/idempotent migration remain covered. |
| [src/config/zod-schema.core.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/config/zod-schema.core.test.ts>) | Schema leaves omitted authority fields absent; explicit modes survive serialization; invalid enums are rejected; missing approval resolves pending after parse. |
| [src/config/schema.help.quality.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/config/schema.help.quality.test.ts>) | Help describes propose as default, auto as opt-in, and lifecycle pending as independent; avoids promising staging for direct auto edits. |
| [ui/src/pages/skill-workshop/header-controls.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/ui/src/pages/skill-workshop/header-controls.test.ts>) | Header uses safe fallback, honors explicit auto, warns about weekly cron only in auto, and disabling auto writes off. |
| [ui/src/pages/skill-workshop/skill-workshop-page.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/ui/src/pages/skill-workshop/skill-workshop-page.test.ts>) | Both empty-state pitch and header enable write propose; existing settings authorization and state handling are retained. |
| [ui/src/e2e/skill-workshop-self-learning.e2e.test.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/ui/src/e2e/skill-workshop-self-learning.e2e.test.ts>) | Existing browser conflict recovery/replayed scalar patch expects propose. Browser test authored/updated, not executed here. |

Explicit-auto upgrade is tested through preservation by resolver, schema JSON round-trip, Doctor precedence and monitor behavior. There is no new default-writing migration to test. Generic Settings already serializes literal enum choices; auto remains one deliberate literal choice in the existing editor. The updated UI tests cover read/display of explicit auto and safe ordinary enable; a separate new end-to-end test of generic Settings auto selection was not added or executed. Native apps were searched: no independent native default/enable writer required a patch (Apple surfaces share Control UI; Android Workshop proposal UI has no autonomy toggle).

Supplemental executable source checks import the actual resolver, with one workspace alias mapped to its actual source module and native Node type stripping. They do not rewrite resolver bodies or substitute a mock. Preserved original resolver is hash-verified against the baseline ZIP. This demonstrates the narrow default behavior even without dependencies; it does not validate schema, UI, concurrency or services.

## 8. Post-Change Verification

Complete commands, exit codes and stderr are retained in [post-verification.json](<D:/code/github-projects/Mused - OpenMuse/p0a-evidence/post-verification.json>). Every canonical command below exited **1 before substantive execution**. Test pass/fail/skip counts are unavailable; reporting these as failed tests would be misleading.

| Command | Before | After | Status |
| --- | --- | --- | --- |
| `node scripts/run-vitest.mjs run <focused selectors below>` | Exit 1: dependencies unavailable | Exit 1: tooling unavailable | ENVIRONMENT ISSUE |
| `node scripts/run-vitest.mjs run src/skills/workshop` | Not separately executed before edit | Exit 1: tooling unavailable | ENVIRONMENT ISSUE |
| `node scripts/run-vitest.mjs run src/config` | Not separately executed before edit | Exit 1: tooling unavailable | ENVIRONMENT ISSUE |
| `node scripts/run-vitest.mjs run src/commands/doctor/shared/legacy-config-migrations.runtime.retired.test.ts` | Not separately executed before edit | Exit 1: tooling unavailable | ENVIRONMENT ISSUE |
| `node scripts/run-vitest.mjs run ui/src/pages/skill-workshop` | Not separately executed before edit | Exit 1: tooling unavailable | ENVIRONMENT ISSUE |
| `node scripts/run-vitest.mjs run src/cron/active-jobs.test.ts src/gateway/server-cron.test.ts src/gateway/server-cron-skill-review-jobs.test.ts` | Not separately executed before edit | Exit 1: tooling unavailable | ENVIRONMENT ISSUE |
| `node scripts/run-tsgo.mjs -p tsconfig.core.json` | Exit 1: dependencies unavailable | Exit 1: tooling unavailable | ENVIRONMENT ISSUE |
| `node scripts/run-tsgo.mjs -p tsconfig.ui.json` | Not separately executed before edit | Exit 1: tooling unavailable | ENVIRONMENT ISSUE |
| `node scripts/run-oxlint.mjs --tsconfig tsconfig.core.json src/skills/workshop/config.ts` | Exit 1: dependencies unavailable | Exit 1: tooling unavailable | ENVIRONMENT ISSUE |
| `node --import ./scripts/tsx.mjs scripts/run-lint.mts` | Not separately executed before edit | Exit 1: tooling unavailable | ENVIRONMENT ISSUE |
| `node --import ./scripts/tsx.mjs scripts/build-all.mts` | Exit 1: dependencies unavailable | Exit 1: tooling unavailable | ENVIRONMENT ISSUE |
| `node --import ./scripts/tsx.mjs scripts/test-projects.mts` | Not separately executed before edit | Exit 1: tooling unavailable | ENVIRONMENT ISSUE |
| `node scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner ui/src/e2e/skill-workshop-self-learning.e2e.test.ts` | Not separately executed before edit | Exit 1: tooling unavailable | ENVIRONMENT ISSUE |
| `node --import ./scripts/tsx.mjs scripts/control-ui-i18n-verify.ts baseline` | Not separately executed before edit | Exit 1: tooling unavailable | ENVIRONMENT ISSUE |
| `node --import ./scripts/tsx.mjs scripts/control-ui-i18n-verify.ts verify` | Not separately executed before edit | Exit 1: tooling unavailable | ENVIRONMENT ISSUE |
| `node p0a-evidence/config-source-smoke.mjs before/after` | 5/18 expected safe-default assertions pass; exit 1 | 18/18 pass; exit 0 | PASS for supplemental resolver contract |
| `node --check` on every changed TS file | Not a recorded canonical baseline | 41/41 parse; exit 0 | PASS for syntax only |
| `python p0a-evidence/verify-snapshot-replay.py` | Verified original manifest/snapshot | 52,509 baseline files verified; 46 exact replayed files; 17,257 Hermes files unchanged | PASS for source integrity |
| `git -c core.autocrlf=false apply --check --whitespace=error` on isolated replay files | Original verified bytes | Exit 0; no whitespace errors; actual isolated replay matches final SHA/bytes | PASS for patch applicability |

Focused selector command used:

```powershell
node scripts/run-vitest.mjs run src/skills/workshop/config.test.ts src/skills/workshop/policy.test.ts src/agents/tools/skill-workshop-tool.test.ts src/skills/workshop/service.test.ts src/agents/agent-tools.before-tool-call.embedded-mode.test.ts src/agents/tools/skill-workshop-tool.collection-restore.test.ts src/agents/tools/skill-workshop-tool.review.test.ts src/skills/lifecycle/workspace-skill-write.test.ts src/skills/workshop/collection-restore.test.ts src/skills/workshop/experience-review.apply.test.ts src/cron/active-jobs.test.ts src/gateway/server-cron.test.ts src/cron/skill-collection-review-monitor.test.ts src/gateway/server-cron-skill-review-jobs.test.ts src/commands/doctor/shared/legacy-config-migrations.runtime.retired.test.ts src/config/zod-schema.core.test.ts src/config/schema.help.quality.test.ts ui/src/pages/skill-workshop/skill-workshop-page.test.ts ui/src/pages/skill-workshop/header-controls.test.ts
```

Normal full lint, full test dispatch, core/UI types, UI E2E wrapper and i18n checks were also attempted; they stopped at missing tooling. Playwright browser launch, native SQLite behavior, async races and rollback tests were **not exercised**. No NEW_REGRESSION is proven or excluded by these blocked gates. No PRE-EXISTING code failure or flaky failure was distinguishable. Do not ship or commit this as verified without running the canonical gates in a supported environment.

Source smoke results: [config-smoke-before.json](<D:/code/github-projects/Mused - OpenMuse/p0a-evidence/config-smoke-before.json>), [config-smoke-after.json](<D:/code/github-projects/Mused - OpenMuse/p0a-evidence/config-smoke-after.json>); syntax: [syntax-checks.json](<D:/code/github-projects/Mused - OpenMuse/p0a-evidence/syntax-checks.json>); exact replay: [snapshot-replay-verification.json](<D:/code/github-projects/Mused - OpenMuse/p0a-evidence/snapshot-replay-verification.json>). The smoke/syntax runs used unsupported Node 25 and are explicitly supplemental.

## 9. Security Review

| Question | Answer and evidence |
| --- | --- |
| 1. Can absent config still result in auto? | **No in the audited Workshop defaults.** Exact auto equality is required for each field; resolver tests cover omission at every nesting level ([src/skills/workshop/config.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/config.ts:26>), config tests). Omitting mode while explicitly choosing auto approval still grants that separate deliberate policy; it does not set mode auto. |
| 2. Can malformed config result in auto? | **No via validation/resolution.** Optional enum schema rejects malformed authored values; defensive resolver selects propose/pending. Eight malformed owner cases and schema rejection cases are authored; 18 source-smoke checks executed. |
| 3. Can normal UI enable result in auto? | **No.** `setSelfLearningEnabled()` writes propose; the exact scalar patch is reused on optimistic-lock retry ([ui/src/pages/skill-workshop/self-learning.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/ui/src/pages/skill-workshop/self-learning.ts:56>), page and E2E tests). It preserves a separately explicit auto approvalPolicy. |
| 4. Can Doctor migration accidentally grant auto? | **No from absence/retired enabled.** Existing migration only writes off/propose when mode absent; explicit mode wins ([src/commands/doctor/shared/legacy-config-migrations.runtime.skills.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/commands/doctor/shared/legacy-config-migrations.runtime.skills.ts:19>), retired-migration tests). An already-invalid mode remains a validation error, not an auto fallback. |
| 5. Can a background job retain implicit auto authority? | **No new invocation is authorized solely by old omission or a retained enabled row.** Resolver-backed specification disables it, execution checks mode, existing reload cancellation revokes active declarations, and host assertion reaches admission (monitor/Gateway/active-jobs tests). Existing arbitrary user-authored cron tasks are not reclassified as system Workshop learning jobs. |
| 6. Can stale in-flight work activate after changes? | **Owner-controlled forward activation now rechecks current authority.** Foreground auto checks latest mode; lifecycle auto apply/restore checks latest policy/source; apply checks reach fs-safe and store commit; restore checks every forward copy/removal and permits recovery; reviewer/weekly admission latches revocation. Source/tests support these boundaries. Already-running child process side effects and universal direct-edit transactionality remain outside this patch; tests are unexecuted. |
| 7. Are CLI/API/UI/runtime semantics consistent? | **The audited authority/default flow is consistent in source.** Server canonical resolver; schema optional enums; UI enable propose; advanced Settings/CLI literal auto; Doctor conservative conversion; operator lifecycle RPC/CLI remains explicit. Schema/help round-trip and UI payload regressions are authored. No runtime integration proof was possible. |
| 8. Does explicit auto still work? | **Preserved in source.** Resolver, schema and Doctor preserve explicit auto; current auto approval skips additional prompt; monitor enables eligible explicit-auto weekly work; foreground auto retains proposal/evaluate/apply. Regression tests are authored; supplemental resolver preservation executes. End-to-end automatic execution is unverified. |

No new permission bypass, scanner, trust database, approval framework or private approval receipt was introduced. A tool retaining captured auto that loses current auto policy is conservatively refused at commit; even if a later hook acquires fresh approval, the stale tool should be recreated/retried with current context. An unrelated manual operator apply/restore remains available in off/propose.

Whole-tree searches included config/type/schema/help/default phrases, runtime consumers, native apps, UI state/serialization and Doctor/cron paths. No remaining semantically active implicit-auto Workshop fallback was found. Historical changelog descriptions of the old release behavior were retained as history; unrelated exec/browser/code-mode auto settings were not changed. Fresh independent review found a restore sibling gap during implementation; it was corrected and the final source received a second read-only review with no further concrete blocker. That source review is not a substitute for tests.

## 10. Diff Summary

| Item | Final value |
| --- | --- |
| OpenClaw files changed | 46 |
| Insertions | 994 |
| Deletions | 138 |
| Test files added/changed | 0 new files; 20 existing test files changed |
| Other TypeScript / Markdown | 21 other TS files; 5 documentation files |
| New/deleted OpenClaw files | 0 / 0 |
| Hermes changes/new/deleted files | 0 / 0 / 0 |
| Dependency manifest / lock / generated source changes | 0 / 0 / 0 |

Only changed test expressions were manually wrapped to existing style; no formatter ran. Diff review checked unrelated formatting, local paths/secrets/debug output, package/lock churn, source inventory, default assumptions and authority/recovery edges. Windows file permission identity cannot be inferred from the imports; no permission-changing command was executed. Evidence scripts, manifests, ZIPs, replay copies and this report are task artifacts outside OpenClaw, not part of the upstream source patch. Successful replay used command-local `core.autocrlf=false` to prevent the host Git setting from translating verified LF bytes; no Git config was changed.

**No final commit.** Both imports are deliberately ignored and lack source Git history. Force-adding modified imported files would record whole files rather than a clean upstream baseline-relative patch, and canonical verification is incomplete. The identifiable before/patch/after state is supplied by the verified baseline ZIP/manifest, exact `P0a.patch`, final file SHA inventory and replay proof. No bootstrap/provenance artifact was mixed into a source commit. Parent web work remains untouched. This report is the only new nonignored deliverable.

## 11. Deferred Work

The following remain entirely outside this patch:

- P0b scanner expansion / broader fail-closed skill scanning.
- P0c generalized immutable-revision Trust Engine and content-attestation database.
- P1 universal autonomous Workshop staging, change sets, and explicit-auto direct-edit conversion.
- P2 bounded canonical memory.
- P3 cloud execution adapters/provider refactor (including Daytona, Modal and Vercel).
- Muse-compatible resource protocol, new run API or agent runtime.

No Hermes code or architecture was imported. The existing OpenClaw proposals, scan/evaluation, operator approval, filesystem safety, store commit/recovery and scheduler boundaries were retained.

## 12. Recommended Next Step

First validate P0a in a supported, organization-approved Node/pnpm environment with the frozen lockfile. Run all changed test files (including restore, write recovery and browser retry), core/UI and test type checks, normal lint/i18n checks and build. The current source result should be reviewed before further security work is layered on it. The user need not diagnose or disable Device Guard; an approved development environment is required to close this gap.

**P0b — broader fail-closed skill scanner:** begin at [src/skills/security/scanner.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/security/scanner.ts:16>) (`SkillScanFinding`, `SkillScanOptions`, `scanSource()` line 412, `scanSkillContent()` line 498, `scanDirectoryWithSummary()` line 683) and [src/skills/workshop/proposal-scan.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/proposal-scan.ts:4>) (`scanProposalBundle()`). Existing apply already rescans and quarantines critical proposal findings at [src/skills/workshop/apply-transition.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/apply-transition.ts:165>); expand that owner rather than adding an unrelated scanner. Trace install coverage through [src/skills/lifecycle/archive-install.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/lifecycle/archive-install.ts:91>) (`installExtractedSkillRoot()`), [src/skills/lifecycle/install.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/lifecycle/install.ts:427>) (`installSkill()`), source-install staging, and [src/plugins/install-security-scan.runtime.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/plugins/install-security-scan.runtime.ts:1057>) (`evaluateSkillInstallPolicyRuntime()`). Use existing scanner/install-security and Workshop regression suites to test unreadable/truncated/oversized trees, mutable support files, encoded malicious content and inability to downgrade dangerous findings through permissive install policy. Those semantics are a future design/test task, not claimed fixed here.

**P0c — generalized immutable-revision Trust Engine:** begin with the existing immutable artifact owners, not with mutable path timestamps. [src/skills/library/bundle.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/library/bundle.ts:151>) (`prepareSkillBundle()`, `prepareSkillLibraryBundle()`, `readSkillLibraryManifestTree()`) binds file bytes, executable metadata and tree revision. [src/skills/workshop/proposal-bundle.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/proposal-bundle.ts>) supplies proposal evaluation bundles and `readSkillProposalTargetTreeSha256()`; [src/skills/workshop/service-evaluation.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/service-evaluation.ts:54>) (`evaluateSkillProposal()`) and apply bind evaluation/revision/target locks before commit. Study [src/skills/library/store.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/library/store.ts>), `store-authority.ts` and [src/skills/workshop/store-sqlite-schema.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/skills/workshop/store-sqlite-schema.ts>) as existing persistence/authority boundaries. For plugins, start at [src/plugins/plugin-trust.ts](<D:/code/github-projects/Mused - OpenMuse/openclaw/src/plugins/plugin-trust.ts:6>) (`PluginTrust`), `install-provenance.ts`, `install-record-commit.ts`, and installed-plugin-index hashing/records; startup identity/provenance must stay with those owners. Build any later generalized verdict record against exact immutable content revisions, keeping trust separate from action permission/approval. Decide reuse and runtime re-verification seams after a dedicated design review; P0a has not created this layer.
