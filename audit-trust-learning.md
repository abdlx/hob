# Trust and Self-Learning Source Audit

This is a supporting lane report for the Hermes → OpenClaw deep port audit. Paths below are relative to the named repository. Inspection is read-only; no source, configuration, dependencies, commits, or live runtime state were changed. Tests were inspected, not executed. Findings concern these supplied snapshots, not assumed historical upstream behavior.

## Findings that change the proposed port

1. **Hermes has useful scanner concepts, not a complete generalized Trust Engine.** Its scanner covers Python, shell, prose injection, credentials, invisible Unicode, symlink escapes and suspicious binaries. External skill installation and trusted-project skill discovery have real security gates. However, project discovery adds a process-global directory-only cache that skips later content hashing, and the rescan test manually clears it. Hub-installed profile skills are not uniformly reverified on every read. Do not copy those lifecycle weaknesses.
2. **OpenClaw already has much of the desired safety machinery.** Exact-release ClawHub trust gates, owner/version correlation, fail-closed install-policy execution, before-install hooks, immutable Library revision manifests, bounded file reads, Workshop pending proposals, apply-time rescans and quarantine, target hashes, evaluator hooks, durable SQLite events and rollback all exist. A new Trust Engine must unify missing content admission responsibility, not recreate these systems.
3. **Hermes already has optional write staging**, contrary to its outdated background-review module introduction saying writes go directly to stores. `tools/write_approval.py` is a common memory/skills write gate with pending/diff/approve/reject UX. But both `skills.write_approval` and `memory.write_approval` default false, gate import failures allow writes, pending records are JSON files, and skill approval replays mutation arguments against current disk. OpenClaw's Workshop state machine is a better foundation.
4. **OpenClaw's auto default is real and has two independent dimensions.** `src/skills/workshop/config.ts:26` defaults absent autonomous mode to `auto`; line 28 independently defaults lifecycle approval policy to `auto`. Changing autonomous mode alone does not require a human for a model's later `apply` action outside a proposal-only review.
5. **Auto review presently bypasses Workshop staging.** Experience auto reviews and weekly collection reviews receive ordinary read/write/edit/apply_patch/exec/process tools. Foreground repair is better: it already creates a proposal before immediately applying in auto mode. The staging change should replace the direct autonomous mutation route with the existing Workshop owner, not transplant Hermes review agents.

## Trust Engine

### Hermes exact implementation

### Scanner inputs, outputs and rules

`tools/skills_guard.py` owns `Finding` (39–46), `ScanResult` (50–58), `THREAT_PATTERNS` (136–453), `scan_file()` (618–647), `scan_skill()` (650–666), `_content_digest()` (669–684), `content_hash()` (687–690), `scan_skill_cached()` (693–721), `should_allow_install()` (724–737), `_check_structure()` (754–796), `_load_skill_ignore()` (803–839), `_resolve_trust_level()` (844–852), and `_determine_verdict()` (855–858).

- Input is a skill directory or single file and source identity. The directory scan applies gitignore-like `.skillignore`/`.clawhubignore`; SKILL.md is never excluded. Text suffixes include Markdown, text, Python, JS, TS, shell, YAML, JSON, TOML, XML, HTML, CSS, Ruby, Perl, PHP, R, Julia, TeX and common config formats (`SCANNABLE_EXTENSIONS`, 515–517). Binary suffixes and escaping symlinks are structural critical findings. File-count/size anomalies mostly remain informational; these are reporting thresholds, not hard traversal/read budgets.
- Rules include credential reads, env harvesting/exfiltration, prompt override and false policy directives, context exfiltration, shell piping, reverse shells, destructive commands, persistence/backdoors, config modification, path traversal, obfuscation and credential literals. Helpers demote inert/comment/denylist references, mask prose Markdown link destinations while retaining code-fence paths, and avoid delegation wording false positives. Invisible Unicode gets high severity.
- Finding: pattern id, severity, category, relative file, line, matched snippet, description. Result: skill/source/trust, verdict, findings, timestamp, summary, provenance.
- One critical finding gives `dangerous`; any high gives `caution`; medium/low alone give `safe`. **Safe is absence of selected heuristic findings, not a proof that arbitrary code is safe.** All three systems must preserve that distinction in product copy.
- `scan_file()` returns an empty finding list on decode/read failure (625–627). A non-existent path passed to `scan_skill()` produces an empty finding list. Do not interpret these outcomes as a complete successful verification. Missing/unreadable coverage and traversal limits must be separate mandatory status facts in an adapted verifier.

### Install policy is more nuanced than the initial claim

`INSTALL_POLICY` (26–33): builtins allow every verdict; trusted repos allow safe/caution but block dangerous; community allows safe and blocks caution/dangerous; agent-created allows safe/caution and asks on dangerous. `_resolve_trust_level()` trusts exact repo identities and descendants of the explicit repo names, avoiding prefix impersonation.

`should_allow_install()` hard-blocks dangerous **community/trusted** content even with force. It allows force overrides for other blocked/ask states, including dangerous agent-created content. `tests/tools/test_skills_guard.py:108–151` explicitly tests builtin-dangerous allowed, community/trusted dangerous unoverrideable, and agent-created dangerous force-overridable. Thus “dangerous can never be bypassed” is true for external community/trusted hub installation, not the entire Hermes skill system. The requested OpenClaw invariant should deliberately be stronger.

### Real installation call graph and side effect

```
hermes_cli/skills_hub.py do_install()
  -> fetch source bundle / source identity resolution
  -> tools/skills_hub_install.py quarantine_bundle()
  -> _scan_quarantined()
       -> tools/skills_guard.py scan_skill_cached()
  -> should_allow_install(result, force)
  -> optional advisory SkillEvaluator (never a blocker)
  -> confirmation unless force/skip_confirm
  -> install_from_quarantine()
       -> path/redirect/support-file checks
       -> shutil.move(candidate, active directory)
       -> installed content_hash
       -> HubLockFile.record_install()
       -> append_audit_log()
  -> cache invalidation / activation notice
```

Evidence: `hermes_cli/skills_hub.py:692–788`, especially 754–779; `tools/skills_hub_install.py:60–81,143–200`. The quarantine directory is pre-install staging; `_install_blocked()` (497–502) deletes the rejected staging copy and records BLOCKED. It is **not** a durable, operator-browsable archive of rejected packages. `install_from_quarantine()` accepts a ScanResult but itself does not re-run the scanner or independently enforce its verdict; it relies on its caller. This is another reason to centralize admission in an OpenClaw-native owner rather than copying helpers verbatim.

Hub state: `tools/skills_hub.py` path resolvers (approximately 40–68), `HubLockFile` methods including `record_install()` (312–346), audit log (387–396). The hub lock stores source, identifier, install path, trust tier, scan verdict, content hash, timestamps, files, commit/source/provenance fields. Persistent scan caches are JSON attestation records. The short lockfile `content_hash()` truncates SHA-256 to 16 hex characters; the cached scanner provenance uses the **full** digest. Use full hashes in proposed OpenClaw trust records.

### Update and runtime verification

`tools/skills_hub_install.py.check_for_skill_updates()` (264–324) compares source revision and/or latest bundle hash against the lock record; remote revisions can avoid full downloads. `hermes_cli/skills_hub.py.do_update()` (903–948) preserves local edits unless force, pins the original source registry and calls `do_install(...force=True)` so every update candidate takes the same external scan gate. `_has_local_edits()` (891–899) detects modified installed trees; it protects user work during updates, **not** runtime admission.

Trusted project skills follow a different path:

```
agent/skill_utils.py project root -> skills.trusted_project_dirs check
  -> get trusted project skill roots
  -> iter_project_skill_files()
       -> is_quarantined_project_skill()
            -> scan_skill_cached(full skill directory, source=project)
            -> dangerous or exception => exclude
  -> index/prompt/catalog/slash consumers
tools/skills_tool.py _locate_skill() -> same quarantine check -> skill_view()
```

Evidence: project root/trust resolution in `agent/skill_utils.py:492–593`; quarantine gate 600–644; `tools/skills_tool.py._skill_catalog()` around 187–233 and `_locate_skill()` 471–523. Caution remains loadable for projects. Scanner failures fail closed at this outer gate. Quarantine is logical exclusion, not moving repository files.

**Important bug-shaped limitation:** `_PROJECT_QUARANTINE_CACHE` (611) is keyed only by resolved skill directory. `is_quarantined_project_skill()` (623–624) returns before content hashing on a cache hit. Broad source search found no production clearing/invalidation reference. `tests/agent/test_project_skills.py.test_rescan_after_content_change()` (235–244) explicitly clears that cache at 243 before the second check. The code proves version/hash-aware persistent scan caching, but does **not** prove live same-process re-verification after a skill changes. Include a clean→malicious same-process regression without manual cache reset in any adaptation.

`tools/skills_tool.py.skill_view()` performs project checks but `_log_security_warnings()` (533–548) merely warns for other locations; default local/profile installed skill reads do not all pass a mandatory new content admission gate. This boundary should be generalized in OpenClaw rather than inherited.

### Plugins and MCP are not absent from Hermes trust

`tools/plugin_guard.py.scan_plugin()` (329–349) reuses skills patterns with plugin-specific remaps, exclusions and structural checks; `should_allow_plugin_install()` (352–364) permits safe, asks for caution (force can confirm), blocks dangerous regardless of force. `hermes_cli/plugins_cmd.py._scan_plugin_tree()` (174–223) gates install/update candidate trees before activation and supports exact curated commit review for caution. Its first branch (186–187) returns without scanning when `plugins.scan_on_install` is disabled; non-overridable dangerous applies while the scanner gate is enabled. File/code/test/prose context exemptions are complex; credentials/API use that is legitimate in plugins is exempted where skill content would be critical. **Adapt verifier profiles by object type; never use skill heuristics unchanged on every plugin.**

MCP is a separate policy: `tools/mcp_tool_registration.py._normalize_server_trust()` (37–46) defaults absent trust to `full`; unrecognized values become `untrusted`. `_record_scope_trust()` (69–74) keeps policy profile-specific; `_tool_candidates()` (252–266) invokes `_scan_mcp_description()`. `tools/mcp_tool_schema.py._scan_mcp_description()` (32–44) warns on prompt-injection descriptions, rather than content-blocking them. `tools/mcp_tool_handlers.py._trust_gate_check()` (59–84) asks for write-capable tools on untrusted servers, using declared `readOnlyHint`; `_make_tool_handler()` (555–573) checks before lazy transport spawn. This combines server policy and per-action approval; it is **not** a hash-attested MCP content Trust Engine and should not be copied as one. A hostile server can misdeclare annotations; only bounded, verifier-observed schema identity belongs in content trust, while annotations remain untrusted hints.

## Trust: OpenClaw exact overlaps and gaps

| Responsibility | Actual OpenClaw owner and behavior | Comparison / verdict |
|---|---|---|
| Static skill/code analysis | `src/skills/security/scanner.ts`: `scanSource()` 412–495, `scanSkillContent()` 498–499, `scanDirectoryWithSummary()` 683–719. JS/TS code suffixes; separate Markdown/text skill rules. Metadata cache dev/ino/size/mtime/ctime, bounded 500 files and 1 MiB per file, 100k directory entries. | Preserve bounded traversal, alias provenance, comment handling and evidence redaction; ADAPT_HERMES wider language/prose corpus. |
| Secret-safe findings | `src/skills/security/scan-evidence.ts.formatScanEvidence()` and literal credential rule; scanner uses redaction for all matches on credential-bearing lines. | KEEP_OPENCLAW. Hermes truncated match text can contain credentials. |
| Audit scanner | `src/security/audit.deep.runtime.ts.getSkillCodeSafetySummary()` 109–143; `collectPluginsCodeSafetyFindings()` 146 onward; `collectInstalledSkillsCodeSafetyFindings()` 312 onward. Includes hidden/shadowed Workshop skills. Errors/truncation become findings. | It is read-only audit, not runtime quarantine/admission. Do not claim the presence of a scanner means loading is gated. |
| Install policy | `src/security/install-policy.ts.runInstallPolicy()` about 410–563 and `src/plugins/install-security-scan.runtime.ts.runOperatorInstallPolicy()` 646–808. Secure absolute executable/scripts/ancestors, explicit env allowlist, bounded request/output/time, errors fail closed, warn requires explicit approval and is re-evaluated after approval. | KEEP_OPENCLAW; adapt trust owner behind this seam, do not replace command policy. |
| Install hooks | `src/plugins/install-security-scan.runtime.ts.runBeforeInstallHook()` 507–565; `runInstallPolicyAndHook()` 819–832; `evaluateSkillInstallPolicyRuntime()` 1057–1093. Hooks can veto; failures block. | KEEP_OPENCLAW seam. These functions run operator policy and hooks; they do **not** automatically invoke the built-in static scanner. |
| Skill archive/source/dependency installation | `src/skills/lifecycle/archive-install.ts.installExtractedSkillRoot()` 91–150; `source-install.ts.installSkillFromSource()` 254 onward; `install.ts.installSkill()` 427–504. Archive install/update candidates pass shared policy before filesystem activation. | HYBRID: retain acquisition/FS mechanics, add generalized content verifier. |
| Registry content trust | `src/skills/lifecycle/clawhub-install-core.ts.checkClawHubSkillTrust()` 345–374 → `src/infra/clawhub-install-trust.ts.checkClawHubPackageTrust()` 479–566; assessClawHubTrust 113–121. Malicious/moderation blocked releases stop install/update. Risky/unavailable/stale handling remains explicit. | KEEP_OPENCLAW exact release security, supplement local changed bytes. |
| Registry identity | `src/infra/clawhub-skill-security.ts.fetchExactClawHubSkillSecurityVerdicts()` validates requested slug/owner/version, cardinality/correlation and exact fallback verification. | KEEP_OPENCLAW; better registry correlation than a source-name trust allowlist. |
| Changed update/removal trees | `src/skills/lifecycle/skill-tree-digest.ts.digestClawHubSkillTree()` 15–47, `checkClawHubSkillPlanAtPath()` 59–83: full path/tree SHA-256, metadata excluded, links unsupported; rechecks before update/removal. | KEEP_OPENCLAW; content hashing exists, but this is mutation-plan concurrency protection, not persistent runtime trust. |
| Immutable Library revisions | `src/skills/library/bundle.ts.readSkillLibraryManifestTree()` 60–106 verifies each file's bytes/mode/hash and revision; staging and manifest integrity elsewhere in same file. | KEEP_OPENCLAW; trust can bind already immutable revisions, avoiding hashing whole mutable trees every hot-path read. |
| Workshop safety | `proposal-scan.ts.scanProposalBundle()` 4–38, `apply-transition.ts.applySkillProposalTransition()` 67–317: pending draft/support hashing, evaluations, re-scan, quarantine, stale-target checks, rollback/reconciliation, lifecycle events. | KEEP_OPENCLAW staging and mutation owner; extend verifier coverage/tri-state policy. |
| Plugin privilege trust | `src/plugins/plugin-trust.ts.PluginTrust`, `plugin-config-trust.ts.isWorkspacePluginAllowedByConfig()`, `official-external-install-trust.ts`; `trusted-tool-policy.ts` validates owner/registration and fails closed. | Provenance/privilege policy must remain distinct from object-content verdicts. |
| Mutable runtime skills | `src/skills/loading/workspace-skill-loader.ts.prepareWorkspaceSkillEntries()` / `prepareWorkspaceSkills()` and source loaders enforce file host, sources, roots, limits, filters and read authority; resources at `src/skills/runtime/resources.ts.prepareSkillResourceDelivery()` 136 onward. | NEW_LAYER: content admission leases/re-verification shared across discovery, resource delivery, explicit read and alternate harness paths. Broad scanner-caller search found no existing universal mandatory content Trust Engine here. |

Scanner limitations matter: OpenClaw directory scans skip oversized files and report truncation; their metadata cache is not a full content attestation. Hermes hash cache can bind current content/version when invoked, but its reader returns empty findings on unreadable files. A generalized verifier must require complete coverage and distinguish scan failure from safe, preserving both projects' useful mechanics without blessing either's incomplete result.

## Proposed OpenClaw-native Trust Engine

Classification: **NEW_LAYER + ADAPT_HERMES**. Keep acquisition, permission, approval, immutable Library, Workspace host and install policy owners. Add one SQLite-backed content-verification owner and object adapters.

Design types, not implementation:

```ts
type TrustVerdict = 'safe' | 'caution' | 'dangerous';
type TrustedObjectType = 'skill' | 'plugin' | 'mcp-server' | 'tool-package'
  | 'execution-provider' | 'executable' | 'repository' | 'remote-integration';
interface TrustedObject {
  id: string; type: TrustedObjectType; source: ObjectSource;
  contentHash: `sha256:${string}`; publisher?: VerifiedPublisher;
  trustVerdict: TrustVerdict; verifiedAt: string; verifierVersion: string;
  previousHash?: `sha256:${string}`; metadata: ObjectMetadata;
}
interface VerificationResult {
  verdict: TrustVerdict; findings: TrustFinding[];
  coverage: 'complete' | 'incomplete'; verifierVersion: string;
  manifestHash: string; sourceIdentity: string;
}
interface TrustedContentAdapter {
  prepareSnapshot(object: ObjectRef): Promise<ImmutableObjectSnapshot>;
  verify(snapshot: ImmutableObjectSnapshot): Promise<VerificationResult>;
  acquireForUse(snapshot: ImmutableObjectSnapshot): Promise<ContentLease>;
}
```

Persist verification status (`unverified`, `verifying`, `verified`, `quarantined`, `failed`) separately from verdict. Failure/incomplete must block admission without misreporting that a scanner found a malicious signature. Store full SHA-256, exact source/publisher identity, verifier version, scanner profile/coverage, manifest bytes/files, previous hash and audit events in the canonical SQLite state database using its worker/writer-broker lifecycle. Do not introduce Hermes JSON caches/sidecars as new authoritative state.

Flow: immutable snapshot/current full manifest → compare admitted full hash **and verifier version/source identity** → unchanged current verified content reuses record → changed/version-obsolete content requires verification → safe update record → caution create approval bound to exact manifest/verifier/findings → dangerous mark quarantined/block. Before activation/use, revalidate held authority after awaits and enforce the actual read/executed bytes match that manifest. Approval never turns dangerous into safe; permission grants never certify content. Quarantine should logically exclude external repository objects, and retain detached evidence/snapshots where needed rather than mutating the user's repository.

For mutable skill trees use safe bounded reads and immutable staging at admission; filesystem watch only invalidates the observed generation, it cannot alone prove identity. Catch race edits/renames/symlink swaps/appends between hashing, scan and activation. Existing Library revisions avoid repeated hashing: verifier record attaches to immutable revision identity. Refresh prompts using existing snapshot-generation contracts; do not unpredictably rewrite cached historical system prompts. Prevent explicit `read`, resource delivery, slash commands, CLI harness skill plugins and remote-node skill transfer from bypassing the admission owner.

Generalization is incremental. Define the object schema and verifier profiles in Phase 1; integrate skills plus plugin install/load first. MCP can attest schemas, declared executable package and endpoint identity, not invisible remote server code. A remote integration content hash certifies observed metadata, not future remote behavior. Repository trust needs a defined scope/tree manifest; scanning a whole arbitrary checkout with skill rules is inappropriate. Executables need publisher/signature/digest verification adapters, not prose regex alone.

## Self-Learning

### Hermes full flow

```
foreground task / conversation iterations
 -> agent/turn_context.py memory turn counter (about 735–761)
 -> agent/turn_finalizer.py finalize / durable delivery
 -> skill threshold + valid skill_manage tool check (749–755)
 -> not interrupted, nonempty result, !skip_background_review (767–777)
 -> run_agent.py AIAgent._spawn_background_review() (788–818)
 -> optional agent/review_idle_queue.py deferred owner
 -> _spawn_background_review_now() (820–857)
 -> agent/background_review.py spawn_background_review_thread() (1330–1358)
 -> _run_review_in_thread() / _run_review_fork() (1167–1320)
 -> build_cache_parity_fork() (984–1065)
 -> dispatch whitelist -> skill_manage / inline memory tool
 -> guards + write_approval gate
 -> direct validated write OR pending JSON record
 -> /skills diff|approve|reject via hermes_cli/write_approval_commands.py
 -> replay apply_skill_pending() -> mutation lock / validation / atomic write
 -> cache invalidation, usage/ledger events and summary callback
```

Memory nudge interval defaults 10 turns and skill nudge defaults 10 iterations: `agent/agent_init.py:1332,1356,1411–1415`. Automatic review enabled defaults true and configuration load errors remain enabled: `background_review.py.load_background_review_settings()` 228–242. No hard correction classifier is required; the reviewer prompts extract evidenced workflow corrections, recoveries and reusable patterns. Post-turn suppression means interrupted turns are not reviewed through this Hermes path; OpenClaw can deliberately review deep user-aborted turns with visible evidence.

`build_cache_parity_fork()` copies the parent's system prefix/cache scope; freezes tool advertisements but separately restricts dispatch, shares memory store, zeroes nudge counters, disables session persistence, detaches compressor/session DB, disables MCP refresh and suppresses status noise. This is carefully implemented cache reuse, not inherently a reason to replace OpenClaw's detached SessionManager/model-context snapshot.

`_review_tool_whitelist()` (1108–1150) gives memory only for memory-scoped review, read-only file tools for inspection, skill mutation through skill_manage, and optional configured extra tools. A thread-local callback auto-denies dangerous commands (1071–1075). `_BackgroundReviewRun` and cancellation helpers (28–168) prevent superseded reviews from continuing; tests cover interruption, cache parity, detached persistence and memory scope.

Skill writes: `tools/skill_manager_tool.py.skill_manage()` (716–770) → background preflight → shared write gate → shape/name validation → per-skill cross-thread/process mutation lock → frontmatter validation/action → atomic writes → optional post-write security scan → ledger/usage/summary. `skill_manager_guards.py._background_review_write_guard()` 164–217 refuses pinned/external/bundled/hub skills when ownership is not proven; `_background_review_read_before_write_guard()` 220–230 requires this review to have read current targets; curator deletes require an existing consolidation umbrella. `skill_linter.py` emits advisory authoring warnings; some frontmatter standards are hard rejected.

`tools/write_approval.py.write_approval_enabled()` (44–52) defaults false and configuration failures false. `evaluate_gate()` (201–216) stages all skills when on; background memory also stages; foreground memory can ask inline. `stage_write()` (74–89) stores exact mutation kwargs under `pending/{memory,skills}/<id>.json`, logs disk errors but still returns staged success. `skill_pending_diff()` (301–340) uses the same patch matcher as replay. `hermes_cli/write_approval_commands.py._approve()` (64–102) replays with `_apply_one()` (122–136) and drops successful pending records; failures remain. `_reject()` (139–148) discards records. `skill_manager_tool.py.apply_skill_pending()` (649–655) sets a ContextVar to avoid recursive gating.

**Failure/security caveats:** staging is optional/default off (`hermes_cli/config_defaults.py:1320,1485`); `_run_write_gate()` fails open if import fails (605–612); agent-created scanner is optional/default false (41–64; config_defaults 1476), scanner exceptions log and return allow; staged skill records do not freeze a full reviewed base revision the way OpenClaw does. Do not copy these defaults, replay authority model or stores. Direct shell/file paths need a separate mutation guard; a write gate around one tool is not universal OS protection.

## Self-learning: OpenClaw full flow

```
completed native/harness agent run
 -> src/agents/harness/agent-end-side-effects.ts runCoreAgentEndSideEffects() (34–79)
 -> scheduleSkillExperienceReview() / default scheduler (experience-review-default.ts)
 -> createSkillExperienceReviewScheduler().schedule() (154–283)
 -> eligibility / >=10 model iterations / 30 sec idle / system inactivity
 -> prepareSkillExperienceReviewCandidate() (experience-review.ts:40–111)
 -> detached runSkillExperienceReviewInner() (121–337)
 -> SessionManager.openModelContextAsync(source anchor)
 -> fresh source permission/liveness checks / current config / drain admission
 -> same selected model + inherited prefix / detached persistence
 -> propose mode: only skill_workshop; one staged mutation; no lifecycle activation
 -> proposeCreateSkill / proposeUpdateSkill / reviseSkillProposal
 -> prepareSkillProposalDraft / schema, bounded files, frontmatter, scans
 -> canonical SQLite proposal + generation artifacts + lifecycle event
 -> inspect/diff/evaluate / explicit apply or reject / quarantine
 -> applySkillProposalTransition(): evaluator, hash check, rescan,
      target CAS, rollback backup, filesystem effect, status event
 -> installed skill refresh/snapshot invalidation -> future skill activation

auto mode today:
 -> separate rooted Workshop execution location
 -> ordinary maintenance file/exec tools -> active filesystem edits
 -> refresh + outcome record; bypasses proposal apply state machine
```

Scheduler guards: `experience-review-scheduler.ts:14–27` constants (10 iterations, 30-second idle/retry, max 32 pending); `isEligibleContext()` 88–115 rejects compacted context, missing tool/model capability, cron/heartbeat/memory/overflow, internal hook/subagent/review sessions. `schedule()` skips errored completions, allows deep user-aborted turns, replaces evidence per agent+session, re-arms later foreground work, drops oldest at pending cap. Queue is process-local, not restart durable. This is appropriate best-effort learning; it must not be described as a durable job queue.

`prepareSkillExperienceReviewCandidate()` enforces current tool policies across agent/provider/group/sender/subagent/inherited policy and excludes incognito. **Propose reviews currently skip sandboxed source sessions** (58–62). Default change will therefore reduce learning in sandboxed sessions unless this is deliberately resolved. Do not silently fall back to auto to preserve activity; support a host-owned proposal capability or record why skipped.

`runSkillExperienceReviewInner()` uses foreground transcript anchors and validates session identity/permission after awaited preparation and during admitted tool execution (174–210). Delivery authority is cleared, model fallback locked out, review is detached and hidden, provider error is recorded as failure. Auto mode rechecks runtime auto opt-in before effects; propose outcome stays pending even if configuration changes mid-review. Outcomes/token usage are stored in collection-review state; review concurrency is one background owner.

Foreground corrections use `src/agents/skill-workshop-prompt.ts:15–16` and `src/agents/tools/skill-workshop-tool.ts`: `patch` requires a used-skill receipt, complete read hash or exact prepared span, current hash, and stages via `proposeUpdateSkill()`. Mode off rejects repair; propose leaves pending; auto applies that exact proposal around lines 588–600. This is **already** the desired draft-first pattern, but auto is currently implicit.

`service-propose.ts.proposeUpdateSkill()` (171–232) composes from the same authoritative read it hashes, records support-file old hashes, target identity and provenance. `createPendingSkillProposal()` (238–338) persists bounded pending records with autonomous capture/run provenance. `proposal-scan.ts` fails critical findings and warns separately. Known literal secrets reject even proposal staging (`proposal-draft.ts:70–77`). `apply-transition.ts:149–172` checks pending/current draft hash, rescans and quarantines failed scan; target/support files must still match prior state; evaluator failures block; rollback/reconciliation covers a filesystem effect that precedes status-commit failure. `store-sqlite-schema.ts:15–25` binds proposals/reviews/rollbacks/events to canonical state SQLite, not a new sidecar database.

Weekly maintenance: `src/cron/skill-collection-review-monitor.ts.resolveSkillCollectionReviewMonitorSpecs()` (213–269) enables system-owned jobs only when mode is auto (220), uses isolated session and ordinary maintenance tools (260–266), with rooted runtime eligibility and existing stored preferences. `maintenance-prompt.ts` explicitly states completed edits are not rolled back after failure/cancellation. Collection backup/restore helps recover but does not provide reviewed per-change staging. Default propose disables these auto maintenance jobs; preserving jobs in disabled state is better than deleting history.

## Exact default migration and downstream assumptions

| Location | Current assumption | Required plan |
|---|---|---|
| `src/skills/workshop/config.ts:26` | Missing/invalid mode resolves to auto. | Resolve only explicit `auto` to auto; absent valid mode to propose, explicit off preserved. Schema remains off/propose/auto. |
| `src/skills/workshop/config.ts:28` | Missing approvalPolicy resolves auto. | Default lifecycle application to pending or replace with a single activation policy owner so implicit auto cannot authorize model apply. Keep explicit operator RPC/CLI decisions distinct. |
| `src/config/zod-schema.root-shape.ts:563–570` | Enum optional; no schema default. | Align generated config/help schema with canonical runtime owner, avoid a second conflicting default. |
| `src/config/schema.help.runtime.ts:532–533` | Says default auto, direct weekly file edits. | Describe propose default and explicit activation opt-in. |
| `ui/src/pages/skill-workshop/self-learning.ts:33–35,52–55` | Absent mode is auto; enabled toggle writes auto. | Three-state control or enabled→propose plus separate explicit auto selector; preserve current explicit modes. |
| `src/skills/workshop/config.test.ts:5–24` | Pins implicit and retired-key fallback auto. | Regression tests for absent/malformed→propose, explicit auto preserved and retired keys migrated at Doctor/config owner. |
| `experience-review.ts:58–62,135–145,253–256` | Propose skip sandbox; auto uses direct tools; budget only propose. | Reuse proposal path for both modes, activation decided separately after validation; design host proposal access for sandboxed runs. |
| `skill-workshop-tool.ts` foreground patch | Off rejects, propose pending, auto create→apply. | Preserve evidence/read-before-write protection and exact revision; require explicit auto activation policy. |
| `src/skills/workshop/policy.ts:151–201` | Auto approval policy bypasses lifecycle gate. | Human decisions must bind full revision and diff; no implicit apply through model tool when autonomous default propose. |
| `src/cron/skill-collection-review-monitor.ts:220–267` | Weekly job exists/enabled only auto; normal file tools. | Disable existing auto jobs on missing mode; later change maintenance to staged change sets. |
| `src/flows/doctor-core-checks.ts:186` / `commands/doctor-skill-workshop-automations.ts` | Enabled if not off; migration of legacy Workshop config/jobs. | Audit migration tests, preserve explicitly selected auto and avoid treating an old absence as opt-in. |
| UI/i18n/e2e fixtures | Self-learning enabled often means auto. | Update semantics, state projections, text and default fixtures together. |

Migration policy: absence never counts as user opt-in; explicit `auto` survives unless product deliberately requires reconfirmation. Do not scan/infer opt-in from prior learned files. Existing pending proposals remain pending, active skills stay active subject to new content verification, in-flight auto runs lose activation authority after mode revocation, disabled weekly jobs retain history. Retired boolean config is not honored by runtime today; handle normalization only through the existing Doctor/config migration owner.

## Common autonomous staging design

Classification: **KEEP_OPENCLAW** Workshop state machine plus **ADAPT_HERMES** common memory/skill gate concept; implement natively.

- One proposal/change-set service admits **all autonomous** create/update/support write/support delete/skill retirement/consolidation/rename mutations, whether from experience review, foreground repair, weekly maintenance or future hooks. Current proposal kind create/update is insufficient for complete collection refactoring; extend an operation manifest with per-target base hashes and delete/rename semantics while preserving existing protocol/SQLite records through migration.
- Propose and explicit auto use the same pipeline. Auto changes activation policy only; it never grants direct writes or bypasses security/evaluators/hashes. Generated → pending immutable revision → full diff (including modes/deletes/binaries) → schema/reference/semantic/security validation → recorded approve/reject decision bound to revision → activate through existing filesystem mutation/rollback owner.
- Model-facing proposal-only capability exposes no `apply`, reject or quarantine lifecycle action; operator RPCs are separate current authority. Generic file tools/exec from autonomous maintenance must not target active skill stores. Removing active write tools from reviewers is preferable to depending on prompts. If scripts are necessary for synthesis/validation, operate on isolated candidate artifacts and ingest an explicit bounded diff. “Rooted cwd” alone is not an OS sandbox or write restriction.
- Collection consolidation is a change set with preservation accounting, referenced assets, and all-or-none target validation; do not silently delete a skill simply because it is unused. Existing backups/restore stay as recovery, not primary approval.
- Validation sees the exact same final bundle activated; recheck source session and current activation opt-in after every awaited evaluator/approval and immediately before filesystem effects. Staging errors report failure rather than Hermes staged success with no saved record.
- Per-agent pending caps, dedup against existing pending drafts, budgets and rejection feedback prevent review spam. No new automatic self-improvement loop should review its own failed/rejected drafts as independent evidence.

## Ranked port/change map and impact estimates

Counts are rough production+tests modules touched, not hours; overlapping counts must not be summed mechanically.

| Priority | Hermes source / symbol | OpenClaw target | Action | Reason | Complexity | Risk | Upstream divergence | Affected files |
|---|---|---|---|---|---|---|---|---|
| P0 / Phase 1 | `tools/skills_guard.py.scan_file`, `THREAT_PATTERNS`, structural checks | existing `src/skills/security/scanner.ts`, verifier profile under proposed `src/security/trust/` | ADAPT_HERMES / reimplement TS rules and fixtures | Wider Python/shell/prose/injection coverage; preserve OpenClaw budgets/redaction | medium | medium | moderate | 6–10 |
| P0 / Phase 1 | `scan_skill_cached`, `is_quarantined_project_skill` | proposed content owner + existing loading/resources/install/Library/refresh seams | NEW_LAYER / adapt concept | Full digest + version/source re-verification and fail-closed quarantine missing universally | high | high | moderate | 18–30 for skill integration |
| P1 / Phase 1 extension | `plugin_guard.scan_plugin`, `should_allow_plugin_install` | shared trust owner + `install-security-scan.runtime.ts`, plugin loading/provenance owner | HYBRID | Object-specific verifier behavior, keep exact ClawHub/install policy | high | high | moderate | 10–18 incremental |
| P0 / Phase 2 | Hermes optional `write_approval` serves as comparison only | `workshop/config.ts`, UI config controls/help/Doctor/tests | KEEP_OPENCLAW / change defaults | propose default + pending activation, explicit auto opt-in | low | medium | minimal | 10–16 |
| P1 / Phase 2 | `write_approval.evaluate_gate`, `skill_pending_diff`, review guards | existing Workshop services/types/protocol/state schema, review/cron/tools | ADAPT_HERMES concept; extend OpenClaw staging | Every autonomous mutation must draft and validate before activation | high | high | moderate | 20–35 |
| P2 / optional | `background_review._review_input_token_budget`, `_review_tool_whitelist` | `experience-review.ts`/admitted run budgeting and review config | ADAPT_HERMES | Aggregate review-cost cap / explicit review scope, if selected runtime lacks equivalent run budget | medium | low | minimal | 4–7 |

No direct Python subsystem transplant is recommended. Scanner rule/test corpus is the highest-value Hermes material here. Common write gate is an architectural inspiration; SQLite Workshop should own the implementation.

## OpenClaw likely files/modules to touch

Trust: `src/skills/security/scanner.ts`, `scan-evidence.ts`, `src/security/audit.deep.runtime.ts`; proposed `src/security/trust/{types,service,verifier,skill-adapter,plugin-adapter,store}.ts` or equivalent existing security owner; canonical `src/state/openclaw-state-schema.ts` plus schema migration/generated types; `src/plugins/install-security-scan.runtime.ts`, `src/security/install-policy.ts` only for integration; `src/skills/lifecycle/{archive-install,source-install,clawhub-install-core,skill-tree-digest}.ts`; `src/skills/loading/{workspace-skill-loader,skill-root-loader}.ts`; `src/skills/runtime/{resources,refresh,session-snapshot}.ts`; Library revision admission/read, plugin loader/provenance, remote-node skill resource transfer/harness skill preparation; associated tests. Keep host authority and selected immutable revisions fixed across retries.

Learning defaults: `src/skills/workshop/config.ts`, `config.test.ts`, `src/config/schema.help.runtime.ts`, `zod-schema.root-shape.ts` and generated schema consumers; `ui/src/pages/skill-workshop/self-learning.ts`, i18n labels/control UI tests; `src/flows/doctor-core-checks.ts`, relevant Doctor automation/legacy migration owner, `src/cron/skill-collection-review-monitor.ts` tests.

Staging: `src/skills/workshop/{experience-review,experience-review-prompt,maintenance-prompt,service,service-propose,proposal-draft,proposal-scan,apply-transition,reconcile-transition,types,store-proposal.kernel,store-transition,collection-backup,collection-restore}.ts`; `src/agents/tools/skill-workshop-tool*.ts`; `src/agents/harness/agent-end-side-effects.ts`; `src/cron` maintenance runner; gateway skill proposal RPC/protocol schemas and UI diff/lifecycle controls. Exact blast radius depends on whether delete/rename/consolidation use an additive change-set envelope or extension of current proposal operations.

## Tests to reuse conceptually and add

Existing Hermes evidence: `tests/tools/test_skills_guard.py` source spoofing, severity policy, force limits, cached version invalidation, pipe-to-shell/injection/path traversal, credential reads, Markdown fence handling, ignores and hash tests; `test_skills_guard_agent_config.py`; `tests/agent/test_project_skills.py` trust root/scope/quarantine but rescan test manually resets cache; `tests/tools/test_plugin_guard.py` object-profile demotions; `tests/tools/test_write_approval.py` on/off, inline decisions, malformed records, diff/replay matcher and destructive-memory entry pinning; `test_skill_manager_tool.py` mutation lock/rollback; `tests/agent/test_background_review*.py` cache parity, cost controls, isolation, cancellation, scope; `tests/hermes_state/test_background_review_session_isolation.py`.

Existing OpenClaw evidence: `src/skills/security/scanner.test.ts` aliases/context/redaction, bounded scans, changed file metadata/replacement, explicit include boundaries; `src/infra/clawhub-skill-security.test.ts` exact publisher/version correlation; `src/skills/lifecycle/{archive-install,skill-tree-digest,source-install,install}.test.ts`; install-policy/hook security tests under `src/plugins` and `src/security`; `src/skills/workshop/{service,service-evaluation,revision-atomicity,store,experience-review,experience-review.apply,experience-review.e2e}.test.ts`; `src/agents/tools/skill-workshop-tool.{review,lifecycle,revision-constraint,support-paths,evaluation}.test.ts`; `src/cron/skill-collection-review-monitor.test.ts`; `src/gateway/gateway-workshop-learning.e2e.test.ts`; `ui/src/e2e/skill-workshop-{self-learning,revision-integrity,collection}.e2e.test.ts`; Library manifest/persistence/selection authority tests.

Required new/changed checks:

- **Unit:** three verdicts, safe/caution/dangerous aggregation, complete/incomplete/failed states, source identities, version invalidation, plugin profile distinctions, canonical manifest hashing including paths/modes, full credential-redacted evidence, malformed verifier output never safe.
- **Security/malicious input:** injection in Markdown and support files, Python/shell exfiltration, invisible Unicode, case/prefix path confusion, symlink/hardlink escape, forged source/publisher, files excluded by user ignores that are still runtime-reachable, invalid UTF-8/read failures, unsupported executable, oversize/deep/huge trees; partial scans block activation rather than produce clean attestation.
- **Reverification:** unchanged complete bytes skip scanner; content/file-name/mode/support mutation, scanner version/source/publisher identity change forces scan; clean→malicious and malicious→clean within the same process without manual cache reset; edited remote skill transfer never reuses Gateway-local provenance.
- **Approval:** caution approval binds exact hash+version+findings; altered bytes after approval force a new decision; dangerous cannot be bypassed by force, trusted publisher, builtin label, permission mode, auto-learning opt-in or an allow-once action approval. Revoked current authority after awaited checks blocks effects.
- **Runtime integration:** discovery/index/prompt/slash/tool/resource/CLI/native harness/remote node consume admitted content identity; explicit read/resource paths cannot bypass quarantine; stable prompts preserve existing session refresh contract.
- **Staging:** propose/off/explicit-auto across empty/new/legacy config; sandboxed source behavior visible; no autonomous read/write/exec route can mutate active skills; all auto activations have durable pending/validation/decision events; exact reviewed revision applied; support deletes/renames/consolidations rollback; partial filesystem/SQLite failure recovery and restart reconciliation; duplicate/capped pending drafts.
- **Migration/regression:** explicit auto retained, missing mode becomes propose, old implicit weekly jobs disabled/history retained, in-flight revocation fenced, existing Library/proposal records readable; old pending drafts stay pending; existing OpenClaw policies/ClawHub blocks retained; review outcome and token accounting remain attributable.

## Things not to copy

- Hermes source-name allowlisting as proof of content safety; builtin/dangerous policy exceptions; caution silently allowed for trusted/project skills if product requires approval for all caution.
- `_PROJECT_QUARANTINE_CACHE` directory-only cache and the test's manual invalidation; shortened authoritative hashes; unhashed executable/runtime dependencies.
- Scanner read/decode failures becoming empty “safe” results; unbounded whole-tree text scans and attacker-controlled coverage exclusions.
- Optional/default-off mutation safety, fail-open configuration/import/scanner errors, JSON/JSONL authoritative pending/trust stores or successful staging responses after persistence failure.
- Background-review `AIAgent` transplant, frozen advertisement hacks, thread-local console/approval plumbing or Hermes-specific prompt and home-directory coupling. OpenClaw already owns detached runs, policy/admission authority, worker SQLite, hooks and model context.
- MCP `full/untrusted` plus `readOnlyHint` approval as a substitute for content trust. Keep content verdict, capability permission and action approval separate.
- Desktop/TUI/slash UI replication. Translate only useful diff/review mechanics into current OpenClaw protocol/UI.

## Lane final recommendation

Retain expected phase order. Phase 1 should add the trust owner and skill verifier/admission seams, while reusing ClawHub, Library, install policy and Workshop hashing. Phase 2 is a defaults/activation safety patch followed by eliminating direct autonomous writes through the existing Workshop staging owner. Changing the default is small enough to prepare early, but broad autonomous change sets depend on a consistent verifier contract. Do not port the Hermes learning runtime or its persistence implementation. The highest value is its **scanner corpus plus reusable content-version verification concept**; the highest trust risk is guaranteeing every runtime/alternate-harness/remote consumption path checks the exact admitted mutable object. Defaults/help/UI are upstreamable patches; scanner coverage and generic verification hooks should also be upstream candidates; product-wide object lifecycle/admission and collection change sets require careful core/SDK seam design rather than a large permanent fork.
