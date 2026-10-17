# OpenClaw implementation checkpoint

Recorded 2026-10-15. This is an interim verification record for the expanded
Hermes-informed OpenClaw work. **The full objective is not complete and this is
not a production-readiness claim.** The earlier P0a reports describe historical
checkpoints; their missing-dependency status does not describe the current host.

## 1. Source and ownership

- The parent workspace owns Git. `openclaw/` and `hermes-agent/` are imports, not
  separate repositories or submodules.
- Parent HEAD: `35bdbc03f341a60b29bb7fa6ba31804cb954aca5`.
- The worktree already contained substantial ongoing implementation and frontend
  changes. No reset, clean, stash, checkout-over, or commit was performed in this
  verification checkpoint. Unrelated work was preserved.
- OpenClaw's original import corresponded to upstream candidate
  `306da58672fd412858e5e24d5dde6ad74268010c`: 52,507 of 52,509 blobs matched
  exactly; two completion-runtime files already differed. It was not an exact
  upstream tree. The current fork also includes the authorized headless changes.
- Hermes's original import corresponded to candidate
  `1298c8e74baa73e1a2b90124228d017261ac6bc4` after normalizing 30 CRLF-only
  differences. Raw-byte upstream identity and executable modes were not proven.
- A fresh comparison against the original local Hermes manifest verified all
  **17,257 files**, with zero changed, missing, or extra files. Hermes was not
  modified. `New_System/.env` was not read or modified.

Original provenance and manifests remain in `p0a-evidence/`. This checkpoint's
source receipt is `p0a-evidence/all-phases/checkpoint-source-manifest.json`, with
the tracked Git patch and byte-exact changed-file ZIP beside it. The receipt
records source hashes and the parent commit, not an assertion of upstream identity.
The scope covers OpenClaw and the existing authorized web/server/deployment work;
it excludes unrelated `.vite/`, credentials, and the historical report files.

## 2. Implementation status

| Area | Current implementation | Remaining scope |
| --- | --- | --- |
| P0a: safe learning defaults | Missing/invalid autonomous mode resolves to `propose`; lifecycle policy resolves to `pending`. Explicit modes/policies survive. Normal UI exposes distinct Off/Propose/Auto choices. | Broader current regression and deployment verification are recorded below. |
| P0b: skill scanner | Full skill bundles, expanded source/prose rules, incomplete-coverage refusal, exact content revisions and non-bypassable dangerous quarantine. | Host/platform coverage and final release validation. Static scanning is not a proof that arbitrary code is harmless. |
| P0c: immutable-revision trust | Host-owned verifier profiles, durable SQLite revisions/decisions, source/hash/verifier/publisher binding; skill install/runtime admission; plugin install/update publication admission. | **Plugin runtime loading remains ungated.** MCP servers, executables, remote integrations, and other future object types have no implemented verifier. |
| P1: staged autonomous skills | Experience and weekly reviewers produce Workshop proposals. Host-owned explicit-auto activation uses exact revisions through ordinary validation/apply. Collection staging supports create/update/retire and multi-operation rename/consolidation. | Final broad regression/release proof; independently audit remaining writers before claiming universal coverage. |
| P2: canonical memory | Aggregate USER budget 2,000 and MEMORY budget 4,000 UTF-16 code units, native-carrier deduplication, staged canonical changes and indexed lossless preimages; full retrieval retained. | Full migration/long-session production proof. Canonical admission is a bounded heuristic, not protection for all retrieved content. |
| P3: cloud execution | Optional, default-disabled Daytona adapter through existing SandboxBackend/remote-shell owners. Existing local/node/container/SSH/OpenShell contracts retained. | Live vendor conformance, lost-reply allocation semantics, process/PTY/file behavior and confirmed teardown. No live paid allocation was made. |
| Headless administration | Existing custom frontend and server expose learning choices and revision-bound Workshop actions. | Current frontend build/lint, final visual/deployment proof and Linux container validation. |

Hermes command approvals, retrieval, OpenAI API implementation, and agent loop
were not copied. The audit found stronger existing OpenClaw owners for those
contracts. No new universal execution registry or Muse resource protocol was
implemented.

## 3. Learning and migration semantics

Canonical owner: `openclaw/src/skills/workshop/config.ts`,
`resolveSkillWorkshopConfig()`.

| Input | Autonomous learning | Lifecycle policy |
| --- | --- | --- |
| Missing | `propose` | `pending` |
| Explicit `off` | `off` | Independent; missing stays `pending` |
| Explicit `propose` | `propose` | Independent; missing stays `pending` |
| Explicit `auto` | `auto` | Independent; missing stays `pending` |
| Malformed/unknown | Runtime fallback `propose`; authored config schema rejects invalid enums | Runtime fallback `pending`; authored config schema rejects invalid enums |
| Retired boolean false | Doctor converts to `off` when canonical mode is absent | No new authority |
| Retired boolean true/other present retired value | Doctor conservatively converts to `propose` when mode is absent | No new authority |
| Existing canonical mode during Doctor migration | Preserved, including explicit `auto` | Explicit policy preserved |
| Ordinary UI enable/Propose selection | Writes `propose` | Does not materialize `auto` |
| Deliberate UI Auto selection | Writes `auto` | Separate explicit lifecycle selector |

Explicit autonomous `auto` authorizes the host to activate its exact staged
autonomous revisions after successful synthesis and validation. It does not
grant arbitrary model lifecycle actions. `approvalPolicy` separately controls
normal model-requested lifecycle prompts. Off prevents autonomous learning;
an operator can still inspect and act on an existing pending proposal.

Weekly monitor declarations require current explicit auto. Missing/propose/off
converges system monitor rows disabled while retaining the existing history
owner. Execution and reload paths recheck/revoke authority; an old enabled row
does not itself authorize automatic mutation. Pending proposals remain pending.
Enabling auto after a propose review begins does not retroactively authorize its
draft. Revoked source sessions, permissions, current mode and apply authority
remain checked through the existing admission and publication boundaries.

The preserved original resolver had two independent automatic fallbacks:

```ts
mode: autonomous.mode === "off" || autonomous.mode === "propose" ? autonomous.mode : "auto"
approvalPolicy: raw.approvalPolicy === "pending" ? "pending" : "auto"
```

These historical defaults are already corrected at the current parent HEAD;
they are not newly introduced changes in this verification turn.

## 4. Important source owners

| File or module | Responsibility and reason for the change |
| --- | --- |
| `src/security/trust/service.ts`, `profiles.ts` | Host-owned verification/decision boundary and an honest supported-object/enforcement inventory. |
| `src/skills/security/trust-store.kernel.ts` | Immutable SQLite revision/decision history, publisher identity, exact consent and legacy readable evidence. |
| `src/skills/security/trust-scanner.ts`, `trust-admission.ts` | Skill-specific complete bundle inspection and retained content admission. |
| `src/skills/library/bundle.ts`, loading/runtime and node-host skill owners | Portable full-bundle identity and admission across actual skill consumers. |
| `src/plugins/content-trust.ts` | Complete plugin publication manifest, package dependency closure, filesystem identity and exact publication custody. |
| `src/plugins/content-trust-scanner.ts`, `content-trust-admission.ts` | Plugin-specific verdicts and exact-revision host review before installation. |
| `src/plugins/install-shared.ts`, `install-managed-npm.ts`, `git-install.ts`, `bundled-install.ts` | Attach admission to final staged artifacts and preserve existing capability/approval boundaries. |
| `src/infra/install-package-dir.ts` | Host publication receipt and validation before releasing the prior artifact/committing deferred publication. |
| `src/cli/plugin-trust-review.ts`, `plugins-trust-cli*.ts` | Authenticated local-operator inspection and acknowledgement, never a model tool or serialized bypass flag. |
| `src/skills/workshop/experience-review.ts`, `autonomous-activation.ts` | Proposal-only reviewer and host activation with current authority and exact mutated revisions. |
| `src/skills/workshop/collection-*.ts`, rollback/lock/store owners | Bounded multi-skill proposal, preimage validation, recoverable publication and interrupted-journal ownership. |
| `src/agents/tools/skill-workshop-tool.ts` | Common proposal tool, bounded inventory and mandatory complete read receipt for full rewrites. |
| `src/memory/canonical-memory-budget.ts`, `canonical-memory-safety.ts` | Canonical source identity, UTF-16 caps and whole-source inspection before truncation. |
| `src/agents/bootstrap-files.ts`, bootstrap and harness helpers | Enforce caps/admission after hooks and prevent duplicate native-carrier injection. |
| `extensions/codex/src/app-server/attempt-*.ts` | Native harness projection keeps canonical facts once even with a different effective execution workspace. |
| `extensions/memory-core/src/canonical-memory-proposals.ts`, promotion/consolidation/forget owners | Stage changes, validate current preimages and authority, preserve/index full previous content, erase linked artifacts on forget. |
| `src/gateway/server-methods/users-personal-file.ts` | Reject unsafe canonical writes while retaining authenticated raw reads for repair. |
| `src/state/openclaw-agent-db-lifecycle.ts`, readers/resources and reader protocol | Join worker-isolate read connection release under the existing close fence without granting deletion authority or closing another owner. |
| `extensions/daytona/` and remote-shell backend | Vendor allocation/token/teardown adapter, strict SSH pins, failed-cleanup retention and retry through existing transport owners. |
| `web/src/services/learning.ts`, `LearningSettings.tsx`, Workshop view; `server/` | Explicit learning choices and reviewed-revision actions through the existing Gateway transport. |

All paths in this table except `web/` and `server/` are relative to `openclaw/`.
The complete changed-file list and hashes are in the source receipt, rather than
being inferred from this selected owner map.

## 5. Defects resolved during verification

- Full skill rewrite could omit its read receipt when autonomous capture was set
  and the current skill was oversized. It now requires the complete read/prepared
  hash; targeted patch preparation remains available.
- Final plugin copy publication creates different inodes. Trust now transfers
  custody only through the install owner's actual target receipt and unchanged
  complete manifest, retaining external dependency identities. Post-publication
  cleanup tampering restores the prior artifact rather than releasing its backup.
- Plugin closure resolution now includes actual local/pnpm dependency owners and
  optional edges without absorbing unrelated ancestor development tools. Internal
  Node index modules without package.json remain hash-bound publication content.
- Core typechecking caught an unchecked queue index in that traversal. The queue
  now consumes defined items directly; no type assertion suppresses the defect.
- Canonical memory inspection now detects invisible formatting within Markdown
  directive prefixes and secret-upload command option forms before truncation.
- Model-context SQLite readers survived ordinary async database close in worker
  isolates. Close now joins their release with the correct physical path and
  optional agent owner. Tests prove the surviving database remains usable and
  the same worker can reopen a closed database.
- The new lifecycle test initially confused directory labels with the actual
  admitted agent ID. It now uses the real `main` owner and distinct physical
  stores/session messages; wrong-owner isolation remains asserted.

## 6. Verification evidence

Canonical runtime: Node 24.16.0, pnpm 12.5.1, existing frozen dependencies.
Vitest uses `node scripts/run-vitest.mjs run ... --maxWorkers=1`, with filesystem
module cache enabled and serialized worker compiler/typecheck runs. The single-worker
selection is a bounded local verification setting, not a production change.

| Check | Current evidence | Result / scope |
| --- | --- | --- |
| Core production types | `core-typecheck-checkpoint-fixed.log` | PASS, exit 0. Original checkpoint run caught the queue index error, now fixed. |
| Extension production types | `extensions-typecheck-checkpoint.log` | PASS, exit 0. |
| Extension test types | `extensions-test-typecheck-checkpoint.log` | PASS, exit 0. |
| Current safe-default resolver | `workshop-defaults-checkpoint.log` | 19 passed, zero failed/skipped, exit 0. Missing/invalid settings, explicit modes/policies, independent opt-ins and serialization. |
| Doctor retired config migration | `doctor-legacy-checkpoint.log` | 55 passed, zero failed/skipped, exit 0. Includes conservative legacy boolean migration, absent config and preservation of explicit auto. This suite unexpectedly triggered shared worker compilation. |
| Plugin publication, rollback, reader lifecycle and ordered review revocations | `publication-reader-final-regressions.log` | 55 passed, 48 skipped across four shards, exit 0. 47 skips were the explicit name filter and one was a Windows symlink platform skip. This preceded the queue typing correction; fresh plugin traversal proof is listed below when complete. |
| Canonical/native memory and staged writer contracts | `native-memory-staging-current.log` | 51 passed, zero failed/skipped across four shards, exit 0, 148.49 seconds. |
| Trust kernel / memory admission / owner / Gateway selected contracts | `trust-memory-owner-fixed-regressions.log` | Its first four shards passed 23, 34, 1 and 10 tests. A later reader fixture failed; the corrected real-reader suite passed above. Do not count this mixed run as an overall pass. |
| Adapter/deployment/learning HTTP and WebSocket tests | `web-adapter-deploy-current.log` | 34 passed, zero failed/skipped, exit 0. |
| Frontend config/stream tests | `web-config-stream-current.log` | 5 passed, zero failed/skipped, exit 0. |
| Changed source formatting | `changed-source-format-final.log` | PASS, exit 0, all 135 changed source files. Six formatting defects were corrected before this check. |
| Git whitespace check | `git diff --check` | PASS, exit 0; CRLF normalization warnings recorded. |
| Core lint | `core-lint-latest.log` | ENVIRONMENT ISSUE: Application Control blocks the installed native oxlint binding. No bypass or successful lint claim. |
| Actual cold plugin runtime admission baseline | `runtime-admission-baseline-probe.log` and `.json` | Exit 1, PATCH_RELEVANT: scanner verdict dangerous/complete, but the real global public-surface loader executes a harmless marker without an admission decision. No shell/network payload is executed. This is an unresolved security boundary, not a passing test. |
| Full OpenClaw build | `full-build-checkpoint.log` | ENVIRONMENT ISSUE, exit 1 after 29m 3.7s. Package/runtime bundles and four declaration invocations passed; the fifth exhausted Windows committed memory while Doctor triggered the shared worker compiler. `VirtualAlloc` failed with errno 1455, followed by `oneshot canceled`. Both runs settled without manual process termination or lock deletion. An isolated retry is required. |
| Isolated full build retry | `full-build-checkpoint-serial.log` | PASS, exit 0, 31m 23.9s. All six unified and both SDK declaration passes succeeded; all 151 public SDK subpaths verified, 96 plugin distributions built, 53 built control-plane modules checked, startup metadata/stamps completed. No concurrent tests/checks ran during the retry. |
| Current frontend lint | `web-lint-checkpoint.log`, `npm run lint` | PASS, exit 0. |
| Current frontend build | `web-build-checkpoint.log`, `npm run build` | PASS, exit 0; TypeScript and Vite production build, 1,936 modules transformed. Bundler callback timing warning retained. |
| Workshop/plugin/cron/schema regressions after queue correction | `workshop-plugin-cron-checkpoint.log` | PASS, exit 0: 92 passed and 2 Windows-specific skips across six shards / eleven files, 192.05 seconds. Includes fresh full plugin publication/dependency cases, collection recovery, lifecycle approval, autonomous exact-revision activation, review read receipts, inventory, cron and schema help. The tooling reporter prints its same 20-test summary twice; it is counted once. |
| Relevant core test and scripts type graphs | Not yet rerun in this checkpoint | Pending; do not infer full graph coverage from production typechecks or selected tests. |
| Full test suite / Linux Docker / live vendor execution | Not executed in this checkpoint | No full-suite, container deployment or live-cloud support claim. |
| Hermes full local manifest | `hermes-checkpoint-verification.json` | PASS: 17,257 unchanged, zero changed/missing/extra. |

Logs are in `p0a-evidence/all-phases/`. Successful typechecks produce empty logs;
their exit codes were observed directly. PowerShell's NativeCommandError wrapper
around redirected stderr is not itself an exit-code result.

## 7. Failures and limitations retained

- Original P0a pre-change canonical tests could not collect because dependencies
  were missing/blocked. No clean pre-change canonical baseline is invented.
- The first concurrent worker build/typecheck exhausted memory before collecting
  tests. Serial execution removed that resource conflict; zero tests from the
  failed attempt are counted as passing.
- The current full build also exhausted memory in declaration invocation 5/6
  when an apparently light Doctor test pulled in shared worker compilation.
  The Doctor suite passed, but that does not make the failed build a pass.
  Keep **all** Vitest/check processes separate from the full build, including
  tests that initially route to unit-fast. The failure log and original build
  result are preserved; there was no forced process kill or artifact-lock removal.
- Earlier plugin publication and reader-fixture failures remain in the evidence
  logs alongside the subsequent owner corrections and successful regressions.
- A mistaken unscoped formatter **check** inspected the repository and reported
  80 files. It made no writes. The corrected changed-source selection found six
  relevant files; unrelated formatting was preserved.
- Windows test wrappers retained their temporary namespaces because descendant
  process termination was unverified. They were not manually deleted.
- Earlier automatic approval review rejected removal of `.vite/`. It remains
  preserved; the rejection was not bypassed.

## 8. Security boundaries and unfinished work

Trust, component permissions, and approval of a specific action remain separate.
Dangerous/incomplete inspected revisions cannot gain activation through a human
allow flag. Caution consent binds the exact source/hash/verifier/revision;
publisher changes cannot reuse old consent. Existing permission and live
mutation-authority checks still apply after awaited work.

Plugin install admission does **not** protect code loaded outside that admission.
`src/security/trust/profiles.ts` explicitly publishes
`{ install: true, runtimeLoad: false }` for plugins. Runtime completion must cover
metadata preparation, synchronous public/setup/provider surfaces, cold fallbacks,
lazy import closures, source generations and already-loaded exports. A new disk
receipt must never attest an old in-memory module, and hashing a prefix of the
eventually loaded closure is insufficient. This remains substantial work.

A source-level probe now demonstrates the gap through
`loadValidatedPublicSurfaceModule()` ->
`loadFacadeModuleAtLocationSync()` ->
`loadPluginPublicSurfaceModuleSync()` -> `preparePluginModule()` -> module load.
The last owner validates filesystem containment and caches exports, but the cold
path has no content-trust admission. A scanner-only comment in the harmless
fixture produces a dangerous verdict while its module marker still executes.
The isolated fixture, script and result are retained under `p0a-evidence/all-phases/`;
no operator state database or credentials are part of this probe.

Unsupported executable binary inspection is incomplete and therefore blocks
plugin admission. Opaque inert assets are hash-bound and require review. This
can limit packages with native dependencies; it is not a claim of native-code
verification. Volatile Git candidates need retained-candidate interactive review;
there is no complete online retained-install approval resource yet.

Canonical memory scanning covers automatic canonical injection and participating
canonical writers. It neither rewrites files on read nor sanitizes arbitrary
retrieval results. The full on-disk retrieval corpus and OpenClaw's existing
SQLite/FTS/vector/hybrid retrieval are retained.

## 9. Production gates

1. Complete the current OpenClaw build and remaining regression/type graphs; review
   the complete source delta and obtain fresh independent review before committing.
2. Complete revision-bound plugin runtime admission without breaking bundled SDK
   identity, laziness, source generations or restart/reload behavior.
3. Run clean Linux container install/build/startup and headless end-to-end flows:
   authentication, agent turn, proposal/diff/approve/reject, retrieval, authority
   revocation, restart recovery and rollback with isolated state.
4. Verify schema/data upgrade and backup/restore with representative copied state;
   no operator database is a test fixture.
5. Run approved live Daytona contracts before enabling that experimental backend
   in production. Keep it disabled until allocation/abort/teardown are proven.

Core lint still needs a host permitted to load its native module. There is no
evidence-based production date or honest completion percentage at this stage.

## 10. Commit and scope

No final commit was created. This is an unfinished multi-phase worktree, not a
small fully verified P0a patch. The checkpoint source archive contains 148 tracked
changed paths and 32 untracked implementation/asset paths; `.vite/` and the older
untracked report are excluded. The tracked delta is 4,903 inserted and 1,455
deleted lines, excluding the untracked source/assets and this report. A fresh
receipt comparison found zero changed or newly generated source paths. These are
the expanded worktree counts, not the size of the original P0a-only patch.

There is no Hermes rewrite, replacement agent runtime, retrieval replacement,
approval-system port, or new Muse API in this work. The active objective remains
open; the next implementation work must begin from the missing runtime trust
boundary, after finishing this checkpoint's verification.

## 11. Precise next implementation entry points

- `src/plugins/plugin-metadata-snapshot.ts:649`,
  `resolvePluginMetadataSnapshotAsync()`: the existing asynchronous preparation
  seam can prepare immutable trust facts without adding database work to a
  synchronous loader. `finalizePluginMetadataSnapshot()` at line 132 is the
  shared publication owner; a parallel metadata registry is unnecessary.
- `src/plugins/plugin-instance-module-loader.ts:35`,
  `bindPluginInstanceModuleLoader()`: existing non-bundled generation capture and
  expected source digest check. Bundled modules deliberately use a shared host
  loader and reject that digest option; do not remove this distinction casually.
- `src/plugins/plugin-generation-artifact.ts:49`,
  `capturePluginGenerationArtifact()`: selective entries, dependency capture and
  later module preparation must receive a sound execution attestation contract.
  Its existing initial source digest alone does not prove the final lazy closure.
- `src/plugins/public-surface-loader.ts:16`,
  `loadValidatedPublicSurfaceModule()`, and its synchronous bundled/global
  callers: these are concrete cold paths that runtime admission must cover.
- `src/security/trust/service.ts` and `profiles.ts`: retain the existing verdict,
  exact revision decision and current authority owners. Change the published
  plugin runtime capability only after every executing path is covered and tested.

Regression proof must include changed dependencies, lazy imports added after
initial registration, already-loaded exports after source changes, restart/reload,
public/setup/provider cold paths, bundled host SDK identity, disabled plugins,
dangerous/incomplete refusal and exact caution approvals. An install-only pass
cannot stand in for those runtime contracts.

## 12. Provider specification cross-check

The adapter's fixed hosted endpoint, token-based SSH hostname, token creation and
exact-token revocation routes were checked against Daytona's current
[SSH documentation](https://www.daytona.io/docs/en/ssh-access/) and
[OpenAPI specification](https://www.daytona.io/docs/openapi.json) on 2026-10-15.
The published schema accepts lookup/removal by sandbox ID or name and the
creation fields used here, including a negative auto-delete interval. This is
documentation agreement, not live allocation, SSH, teardown or idempotency proof.

The exact 703,754-byte specification is retained as
`p0a-evidence/all-phases/daytona-current-openapi.json`, SHA-256
`345f667a51f6ef8beceff152a07bafd032cdc16bebb94bc65e02e693141d41e1`.
The browser JSON fetch timed out; the same official URL was subsequently fetched
successfully as data. No cloud credentials or paid resources were used.
