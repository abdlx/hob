# Hermes → OpenClaw Deep Port Audit

Audit date: October 4, 2026. Scope: the local source snapshots at `D:\code\github-projects\Mused - OpenMuse\hermes-agent` and `D:\code\github-projects\Mused - OpenMuse\openclaw`.

This is a source audit and implementation design, not an implementation. No code, configuration, dependencies, formatting, or commits were changed in either project. Source, schemas, callers, and relevant test cases were inspected. Tests and live backends were not executed; test references below describe existing coverage and required future proof, not passing results.

Neither source directory has usable Git metadata, so commit identity, local-vs-upstream differences, and upstream ancestry cannot be established. `openclaw/package.json` reports **2026.9.8**. Hermes's Python package reports **0.0.0** and JavaScript workspace **1.0.0**; neither is a reliable Hermes release identity. Claims apply to the supplied source, not older comparisons or whatever upstream currently ships. Paths prefixed `hermes-agent/` or `openclaw/` are relative to the containing workspace; unprefixed paths within a project-specific paragraph are relative to that project. Line ranges are snapshot-specific.

## 1. Executive Summary

**Keep OpenClaw as the runtime. This snapshot already implements much of the proposed destination architecture. The strongest plan is to strengthen its existing owners, adapt selected Hermes security mechanics, and avoid a combined runtime.**

Top findings:

1. **Do not port Hermes command approvals.** OpenClaw has the stronger integrated approval system: structured reviewer outcomes, executable/script/environment/cwd binding, current authority checks, node-host policy, one-use decisions and cancellation. A regex classifier or auxiliary LLM is already present, not a missing capability.
2. **Do not port Hermes memory retrieval or learning orchestration.** OpenClaw already has SQLite, FTS, embedding/vector and hybrid retrieval, MMR/temporal processing, provenance, dreaming/consolidation, and a durable Workshop proposal/revision/apply/rollback owner. These would be weakened by replacement.
3. **Adapt Hermes's broader scanner rule coverage and content/version-bound scan attestations.** Python, shell, Markdown directives, hidden Unicode, credential exfiltration, and agent-configuration persistence patterns address real coverage gaps. Extend OpenClaw's scanner and admission gates; do not copy Python control flow, vendor allowlists, incomplete-scan handling, or caches.
4. **Build a generalized Trust Engine above existing security owners.** Current install scans and Workshop validation do not collectively establish mandatory content-bound verification for every mutable skill/plugin/MCP/provider/repository. Use full hashes, immutable revisions, verifier/policy versions, typed object adapters, SQLite authority, and hash-bound caution decisions. Dangerous content has no install-force escape; failed/incomplete verification stays blocked without pretending to be a safe verdict.
5. **Change both unsafe Workshop defaults.** `openclaw/src/skills/workshop/config.ts:26` maps absent autonomous mode to `auto`; line 28 maps absent approval policy to `auto`. Changing only one is insufficient. Adopt `off | propose | auto`, with **propose + pending** as the fallback, and require explicit opt-in for automatic activation. Reuse Workshop staging; close direct file/exec maintenance paths.
6. **Tighten existing canonical-memory owners.** OpenClaw already has a special 4,000-character USER injection ceiling and a 10,000-character MEMORY promotion budget. General bootstrap limits are larger. Hermes's 2,200/1,375-character memory/user write limits are useful sizing references, but externally edited oversized files remain loaded. The strict invariant is not already guaranteed by Hermes.
7. **Do not begin an execution-provider rewrite.** OpenClaw already has `SandboxBackendFactory` / `SandboxBackendHandle`, Docker/Podman/SSH, OpenShell registration, and a separate `WorkerProvider` lifecycle for agent workers/remote execution. Hermes also retains a built-in backend factory switch. Add cloud adapters to existing seams before inventing a universal execution owner. A truly universal cutover would be **VERY HIGH** complexity; scoped adapter work is much smaller.
8. **No duplicate OpenAI API port.** OpenClaw already supports Chat Completions, Responses POST/streaming/continuation, models and embeddings. Hermes's coherent REST run/status/steer/stop/approval/SSE surface is a useful future facade concept. Its event backlog is in memory, not a durable replay journal. A Muse protocol needs resource projections and some new durable contracts, not another agent loop.

Unexpected discoveries: Hermes has opt-in shared memory/skill write staging, but fails open in some configuration/import paths; project-skill quarantine caches by directory inside a process, so it does not guarantee reverification after every mutation; native OpenClaw harnesses deliberately omit raw MEMORY injection; OpenClaw already has Goals, Computers, Workboard, Artifacts and worker lifecycle surfaces; a Hermes-to-OpenClaw memory migration plugin already exists.

**What absolutely belongs in the plan:** content-bound verification at install/update/use boundaries, wider calibrated scanner coverage, safe learning defaults, one autonomous skill staging owner, and a strict small canonical-memory projection with lossless retrieval retention. These are adaptations or OpenClaw-native work, not a justified raw source transplant. No examined component merits a wholesale `PORT_HERMES` verdict.

Ranked implementation order:

| Rank | Work | Verdict | Complexity | Risk | Upstream divergence | Approximate affected OpenClaw files |
|---|---|---|---|---|---|---|
| P0a | Safety baseline: propose + pending defaults, explicit auto validation/migration | KEEP_OPENCLAW | low | medium | minimal | 10-16 |
| P0b | Broader skill scanner and fail-closed skill trust admission | ADAPT_HERMES | medium | medium | moderate | 12–20 |
| P0c | General trust records, immutable revisions, reverification/quarantine; initially skills/plugins | NEW_LAYER | high | high | moderate | 18–30 |
| P1 | All autonomous skill writers use Workshop staging and one activation path | HYBRID | high | high | moderate | 20-35 |
| P2 | USER ~2K / MEMORY ~4K canonical caps, existing consolidation and lossless archive | HYBRID | medium | medium | minimal to moderate | 22-33 including tests; native carriers +4-6 |
| P3 | One cloud execution adapter through an existing sandbox/worker contract | ADAPT_HERMES | medium to high | medium | minimal to moderate | 6-14 per terminal adapter; full worker 12-25 |
| Later | REST run facade, durable Muse resource/event protocol | ADAPT_HERMES / NEW_LAYER | high | high | moderate | 20–35 for the protocol owner/facade baseline |
| Optional | Benchmark CJK transcript recall; add tokenizer/fallback only if demonstrated | ADAPT_HERMES | medium | low–medium | minimal–moderate | 5–8 |

Counts include likely source, schema/config and test modules and overlap across changes; they are planning ranges, not an additive estimate of total edits. Generalizing trust to all listed remote/executable object classes is staged work beyond the initial skills/plugins range. No developer-hour estimates are made.

The small P0a default patch is intentionally pulled forward from Phase 2: actual source shows default unattended direct skill maintenance today, while a complete Trust Engine takes substantially more work. The four substantive phases otherwise retain the requested order.

## 2. Architecture Comparison

### Repository roots and top-level map

| Hermes root | Responsibility | OpenClaw root | Responsibility |
|---|---|---|---|
| `hermes_cli/`, `cli.py`, `hermes` | CLI/bootstrap/config/profile/frontend | `openclaw.mjs`, `src/index.ts`, `src/cli/` | CLI/bootstrap/config commands |
| `run_agent.py`, `agent/` | Python agent facade, synchronous turn phases, memory/context/review | `src/agents/`, `packages/agent-core/`, harness extensions | Agent admission/execution/tool policy/context/harness owners |
| `gateway/`, `gateway/platforms/` | Async adapters, profile scope, agent-thread dispatch, HTTP APIs | `src/gateway/`, gateway protocol package, channels/extensions | HTTP/WS control plane, authenticated methods, sharing, dispatch |
| `tools/`, `model_tools.py`, `toolsets.py` | Registry, toolsets, terminal providers, skills/security | `src/agents/tools/`, `src/skills/`, `src/security/`, `src/plugins/` | Tools, skill runtime/Workshop, security, plugin contracts |
| `hermes_state*.py` | SQLite sessions/messages/search/compression/state integrity | `src/state/`, `src/config/sessions/`, `src/sessions/` | SQLite schemas/migrations, worker/broker state, session/transcript ownership |
| `cron/` | Jobs, execution attempts, scheduling and delivery | `src/cron/`, `src/auto-reply/`, worker-environments | Scheduling, background delivery, leases/recovery |
| `plugins/`, `providers/` | Provider/plugin implementations and discovery | `extensions/`, `src/plugin-sdk/`, `packages/*-sdk/` | Plugin implementations/public SDK/provider registration |
| `tests/`, `tests-js/`, `evals/` | Python/JS invariant and integration tests/evals | colocated tests, `test/`, `qa/`, `extensions/qa-lab/` | Unit/integration/e2e/platform/release validation |
| `apps/`, `tui_gateway/`, `ui-tui/`, `web/`, `website/` | Desktop/TUI/web/docs surfaces | `apps/`, `ui/`, `docs/` | Native apps/control UI/docs |

Hermes runtime:

```text
CLI / chat adapter / HTTP API
    → profile + session lease
    → AIAgent facade → init_agent → run_conversation
    → prompt / memory provider / context engine
    → model request → tool registry + inline executors
    → terminal environment / files / integrations
    → SQLite session persistence + finalization
    → background review → memory / skills [optional write gate]
```

OpenClaw runtime:

```text
CLI / channel / HTTP / authenticated Gateway WS
    → method descriptor + current authority + work admission
    → agent-turn service / command ingress + session/dedupe owner
    → harness selection + context engine + memory/skill context
    → tool policy + approval owner + executable/action binding
    → local process | node system.run | SandboxBackend
    → optional WorkerProvider placement for whole-agent/remote work
    → authoritative SQLite commit + session/event projections
    → agent-end → Workshop experience review / memory maintenance
```

Hermes is organized around a synchronous Python conversation facade with async transports and executor threads. OpenClaw is organized around typed runtime/control-plane owners with explicit admission, scoped authority, process supervision, state publication and public plugin contracts. Both use plugin seams and stable prompt prefixes. Porting Hermes's agent loop, terminal state globals, storage layout or approval runtime would undermine OpenClaw's stronger boundaries.

Entry-path evidence: `hermes-agent/run_agent.py:AIAgent`, `agent/agent_init.py:init_agent`, `agent/turn_facade.py`, `agent/turn_facade_lease.py`, `agent/conversation_loop.py:run_conversation`; `openclaw/src/index.ts:runLegacyCliEntry`, `src/cli/run-main.ts:runCli`, `src/gateway/server-methods.ts:createRequestGatewayMethodRegistry` and `runWithGatewayRequestEnvelope`, `src/gateway/server-methods/agent-run-handler.ts:agentRunHandler`, `src/gateway/agent-turn/agent-turn-service.ts:createAgentTurnService().startTurn`. The latter explicitly carries dedupe reservation, session target, source authority and lifecycle generation through execution.

## 3. Feature Matrix

| Feature | Hermes Implementation | OpenClaw Implementation | Winner | Verdict | Complexity | Risk |
|---|---|---|---|---|---|---|
| Skill static threat coverage | `tools/skills_guard.py` multi-language/prose rules | `src/skills/security/scanner.ts`, Workshop bundle scan | Hermes coverage; OpenClaw filesystem handling | HYBRID | medium | medium |
| Dangerous external install override | `should_allow_install` hard-blocks community/trusted dangerous | Skill/plugin install gates permit explicit override in some flows | Hermes policy concept | ADAPT_HERMES | medium | medium |
| General mutable-object trust | Skill hash attestations/project admission, incomplete universal coverage | Install scans/provenance/approvals/Workshop, no single generalized owner | Neither | NEW_LAYER | high | high |
| Quarantine/reverification | Project quarantine + hash cache; stale in-process cache caveat | Workshop hash-bound apply scan/quarantine; gaps outside Workshop | Combined mechanics | HYBRID | high | medium |
| Learning triggers/reviewer | Finalizer/background review/nudges | Agent-end, idle experience scheduler, Workshop curator | OpenClaw | KEEP_OPENCLAW | none | none |
| Autonomous activation defaults | Write approval opt-in, automatic stores | Missing mode/policy become auto | Neither safe by default | KEEP_OPENCLAW (existing modes; change policy) | low | medium |
| Staging/review/rollback | Optional replay payload JSON staging | Durable proposals/revisions/evaluation/apply/rollback | OpenClaw | KEEP_OPENCLAW; HYBRID writer coverage | high for coverage | medium |
| Canonical memory sizing | USER 1375 / MEMORY 2200 write chars; manual oversized load allowed | USER 4000 injection, MEMORY 10000 promotion, larger bootstrap | Hermes sizing concept | ADAPT_HERMES | medium | medium |
| Retrieval/vector/hybrid/MMR | FTS5 session search, provider plugins | Memory-core embeddings/vector/hybrid/BM25/temporal/MMR | OpenClaw | KEEP_OPENCLAW | none | none |
| Consolidation/provenance | Memory provider lifecycle, background review, poisoned-entry filtering | Dreaming/promotion/consolidation/provenance/active memory | OpenClaw; Hermes content filter reference | HYBRID | medium | medium |
| CJK episodic substring recall | Native bigram + trigram/LIKE fallback | Configurable memory trigram/CJK; canonical transcript MATCH index | Hermes niche candidate | ADAPT_HERMES after benchmark | medium | low–medium |
| Execution contracts | BaseEnvironment + plugin provider; built-in factory switch | SandboxBackend + WorkerProvider + node/process/computer contracts | OpenClaw | KEEP_OPENCLAW | none | none |
| Cloud backend breadth | Modal/Daytona and other terminal backends | Extensible factories/lifecycle, different production backends | Hermes vendor adapters as reference | ADAPT_HERMES | medium–high each | medium |
| Universal execution rewrite | Not unified across all agent/computer/provider concerns | Existing multiple deliberate owners | Neither needs replacement | IGNORE big-bang; NEW_LAYER only proven need | very high | high |
| Command classifier/smart reviewer | Dangerous regexes + auxiliary reviewer | Bound executable/script/environment policy + structured reviewer | OpenClaw | KEEP_OPENCLAW | none | none |
| Approval UX | CLI/session/permanent/run-scoped queues | Gateway/node approvals, one-time decisions, identity and live authority | OpenClaw | KEEP_OPENCLAW | none | none |
| OpenAI compatibility | Chat/Responses + response CRUD, models | Chat/Responses continuation, models, embeddings | OpenClaw foundation; different CRUD surface | KEEP_OPENCLAW | none | none |
| REST run control/events | Coherent run/status/approval/steer/stop/SSE | Equivalent runtime owners exposed largely through Gateway methods | Hermes presentation | ADAPT_HERMES later | medium | medium |
| Durable Muse resource protocol | Partial run/session resources, ephemeral event replay | Many resource owners, no unified full journal/protocol | Neither | NEW_LAYER later | high | high |
| Context engines/compression | Plugin ContextEngine selection/compress hooks | Typed context engine assemble/compact/maintain/thread projection | OpenClaw | KEEP_OPENCLAW | none | none |
| Retry/failover | Bounded post-exhaustion wait ladder | Replay-safe transient retries, budgets, auth/model failover | OpenClaw policy; Hermes wait UX idea | KEEP_OPENCLAW | low optional UX | low |
| Recovery/checkpointing | Session/cron ownership and recovery | Transcript checkpoints, queued child recovery, durable claims | No established Hermes superiority | KEEP_OPENCLAW | none | none |
| Scheduling/concurrency | CronScheduler provider + durable fire claims | Cron queues/timers/receipts/recovery + workers | No established Hermes superiority | KEEP_OPENCLAW | none | none |
| Tool/plugin/model/observability systems | Python registries/provider contracts/metrics | SDK registries/hooks/diagnostics/audit/model owners | No established Hermes superiority | KEEP_OPENCLAW | none | none |
| Hermes UI/TUI/desktop | Hermes-specific product surfaces | Existing OpenClaw product surfaces | Irrelevant to this port | IGNORE | none | none |

`none` means no implementation recommended; the complexity/risk column describes the proposed change, not the size of the existing subsystem. Classification details, exceptions, test evidence and estimates follow.

## 4. Trust Engine

#### Hermes exact implementation

#### Scanner inputs, outputs and rules

`tools/skills_guard.py` owns `Finding` (39–46), `ScanResult` (50–58), `THREAT_PATTERNS` (136–453), `scan_file()` (618–647), `scan_skill()` (650–666), `_content_digest()` (669–684), `content_hash()` (687–690), `scan_skill_cached()` (693–721), `should_allow_install()` (724–737), `_check_structure()` (754–796), `_load_skill_ignore()` (803–839), `_resolve_trust_level()` (844–852), and `_determine_verdict()` (855–858).

- Input is a skill directory or single file and source identity. The directory scan applies gitignore-like `.skillignore`/`.clawhubignore`; SKILL.md is never excluded. Text suffixes include Markdown, text, Python, JS, TS, shell, YAML, JSON, TOML, XML, HTML, CSS, Ruby, Perl, PHP, R, Julia, TeX and common config formats (`SCANNABLE_EXTENSIONS`, 515–517). Binary suffixes and escaping symlinks are structural critical findings. File-count/size anomalies mostly remain informational; these are reporting thresholds, not hard traversal/read budgets.
- Rules include credential reads, env harvesting/exfiltration, prompt override and false policy directives, context exfiltration, shell piping, reverse shells, destructive commands, persistence/backdoors, config modification, path traversal, obfuscation and credential literals. Helpers demote inert/comment/denylist references, mask prose Markdown link destinations while retaining code-fence paths, and avoid delegation wording false positives. Invisible Unicode gets high severity.
- Finding: pattern id, severity, category, relative file, line, matched snippet, description. Result: skill/source/trust, verdict, findings, timestamp, summary, provenance.
- One critical finding gives `dangerous`; any high gives `caution`; medium/low alone give `safe`. **Safe is absence of selected heuristic findings, not a proof that arbitrary code is safe.** All three systems must preserve that distinction in product copy.
- `scan_file()` returns an empty finding list on decode/read failure (625–627). A non-existent path passed to `scan_skill()` produces an empty finding list. Do not interpret these outcomes as a complete successful verification. Missing/unreadable coverage and traversal limits must be separate mandatory status facts in an adapted verifier.

#### Install policy is more nuanced than the initial claim

`INSTALL_POLICY` (26–33): builtins allow every verdict; trusted repos allow safe/caution but block dangerous; community allows safe and blocks caution/dangerous; agent-created allows safe/caution and asks on dangerous. `_resolve_trust_level()` trusts exact repo identities and descendants of the explicit repo names, avoiding prefix impersonation.

`should_allow_install()` hard-blocks dangerous **community/trusted** content even with force. It allows force overrides for other blocked/ask states, including dangerous agent-created content. `tests/tools/test_skills_guard.py:108–151` explicitly tests builtin-dangerous allowed, community/trusted dangerous unoverrideable, and agent-created dangerous force-overridable. Thus “dangerous can never be bypassed” is true for external community/trusted hub installation, not the entire Hermes skill system. The requested OpenClaw invariant should deliberately be stronger.

#### Real installation call graph and side effect

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

#### Update and runtime verification

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

#### Plugins and MCP are not absent from Hermes trust

`tools/plugin_guard.py.scan_plugin()` (329–349) reuses skills patterns with plugin-specific remaps, exclusions and structural checks; `should_allow_plugin_install()` (352–364) permits safe, asks for caution (force can confirm), blocks dangerous regardless of force. `hermes_cli/plugins_cmd.py._scan_plugin_tree()` (174–223) gates install/update candidate trees before activation and supports exact curated commit review for caution. Its first branch (186–187) returns without scanning when `plugins.scan_on_install` is disabled; non-overridable dangerous applies while the scanner gate is enabled. File/code/test/prose context exemptions are complex; credentials/API use that is legitimate in plugins is exempted where skill content would be critical. **Adapt verifier profiles by object type; never use skill heuristics unchanged on every plugin.**

MCP is a separate policy: `tools/mcp_tool_registration.py._normalize_server_trust()` (37–46) defaults absent trust to `full`; unrecognized values become `untrusted`. `_record_scope_trust()` (69–74) keeps policy profile-specific; `_tool_candidates()` (252–266) invokes `_scan_mcp_description()`. `tools/mcp_tool_schema.py._scan_mcp_description()` (32–44) warns on prompt-injection descriptions, rather than content-blocking them. `tools/mcp_tool_handlers.py._trust_gate_check()` (59–84) asks for write-capable tools on untrusted servers, using declared `readOnlyHint`; `_make_tool_handler()` (555–573) checks before lazy transport spawn. This combines server policy and per-action approval; it is **not** a hash-attested MCP content Trust Engine and should not be copied as one. A hostile server can misdeclare annotations; only bounded, verifier-observed schema identity belongs in content trust, while annotations remain untrusted hints.

### Trust: OpenClaw exact overlaps and gaps

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

### Proposed OpenClaw-native Trust Engine

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

## 5. Self-Learning

#### Hermes full flow

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

### Self-learning: OpenClaw full flow

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

### Exact default migration and downstream assumptions

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
| `src/flows/doctor-core-checks.ts:186` / `src/commands/doctor-skill-workshop-automations.ts` | Enabled if not off; migration of legacy Workshop config/jobs. | Audit migration tests, preserve explicitly selected auto and avoid treating an old absence as opt-in. |
| UI/i18n/e2e fixtures | Self-learning enabled often means auto. | Update semantics, state projections, text and default fixtures together. |

Migration policy: absence never counts as user opt-in; explicit `auto` survives unless product deliberately requires reconfirmation. Do not scan/infer opt-in from prior learned files. Existing pending proposals remain pending, active skills stay active subject to new content verification, in-flight auto runs lose activation authority after mode revocation, disabled weekly jobs retain history. Retired boolean config is not honored by runtime today; handle normalization only through the existing Doctor/config migration owner.

### Common autonomous staging design

Classification: **KEEP_OPENCLAW** Workshop state machine plus **ADAPT_HERMES** common memory/skill gate concept; implement natively.

- One proposal/change-set service admits **all autonomous** create/update/support write/support delete/skill retirement/consolidation/rename mutations, whether from experience review, foreground repair, weekly maintenance or future hooks. Current proposal kind create/update is insufficient for complete collection refactoring; extend an operation manifest with per-target base hashes and delete/rename semantics while preserving existing protocol/SQLite records through migration.
- Propose and explicit auto use the same pipeline. Auto changes activation policy only; it never grants direct writes or bypasses security/evaluators/hashes. Generated → pending immutable revision → full diff (including modes/deletes/binaries) → schema/reference/semantic/security validation → recorded approve/reject decision bound to revision → activate through existing filesystem mutation/rollback owner.
- Model-facing proposal-only capability exposes no `apply`, reject or quarantine lifecycle action; operator RPCs are separate current authority. Generic file tools/exec from autonomous maintenance must not target active skill stores. Removing active write tools from reviewers is preferable to depending on prompts. If scripts are necessary for synthesis/validation, operate on isolated candidate artifacts and ingest an explicit bounded diff. “Rooted cwd” alone is not an OS sandbox or write restriction.
- Collection consolidation is a change set with preservation accounting, referenced assets, and all-or-none target validation; do not silently delete a skill simply because it is unused. Existing backups/restore stay as recovery, not primary approval.
- Validation sees the exact same final bundle activated; recheck source session and current activation opt-in after every awaited evaluator/approval and immediately before filesystem effects. Staging errors report failure rather than Hermes staged success with no saved record.
- Per-agent pending caps, dedup against existing pending drafts, budgets and rejection feedback prevent review spam. No new automatic self-improvement loop should review its own failed/rejected drafts as independent evidence.

## 6. Memory

### Conclusions and classifications
1. **KEEP_OPENCLAW** for retrieval, persistence, session visibility, provenance, embeddings, hybrid ranking, and consolidation execution. The local OpenClaw implementation is considerably more sophisticated than the built-in Hermes file store plus lexical session search. Do not transplant Hermes's memory backend.
2. **ADAPT_HERMES / HYBRID** for the product discipline of a small canonical memory and explicit write feedback. Hermes defaults to 2,200 Python characters for MEMORY and 1,375 for USER, but these are *write* limits, not hard injection limits. `MemoryStore.load_from_disk()` deliberately loads over-limit external/manual files and only logs a warning. Its test explicitly preserves this behavior. Copying this implementation would fail the proposed invariant.
3. OpenClaw already has **USER injection capped at 4,000**, MEMORY promotion/consolidation capped at **10,000**, normal bootstrap per-file cap **20,000**, total **60,000**, project-memory context **2,000**, and active-memory recall summary **220**. Tighten and connect existing budget owners; do not invent a second memory manager.
4. Native Codex and AgentsAPI intentionally route MEMORY through retrieval rather than injecting its contents. A universal requirement that MEMORY is always injected would change those harness contracts. A cap-only patch would therefore **not fully satisfy the user's always-injected product requirement**. Stage native bounded-memory context support through the existing workspace/thread seam and a declared harness capability, preserving the upstream default until the new OpenClaw product profile explicitly selects it.
5. **HYBRID** candidate: Hermes checks strict threat patterns on memory writes and load-time prompt snapshots. OpenClaw has stronger provenance and session visibility, but unrecorded workspace memory defaults to `agent` origin and does not receive equivalent content scanning at the inspected bootstrap boundary. Adapt memory content admission into the generalized Trust Engine; do not confuse origin provenance with a content trust verdict.

| Recommended change | Complexity | Risk | Divergence | Approximate affected OpenClaw files |
|---|---|---|---|---|
| Canonical per-kind and aggregate budgets, diagnostics, all existing carriers | medium | medium | minimal if upstreamed | 12–18 production/config/SDK files; 10–15 focused tests |
| Lossless legacy-memory migration and staged consolidation | medium | medium | moderate | 6–10 production/migration files plus tests, partly overlapping above |
| Memory content scanner adapter using generalized Trust Engine | medium | medium | minimal/moderate | 4–7 memory files in addition to shared Trust Engine |
| Multilingual transcript lexical recall improvement, only after benchmark | medium/high | medium | moderate if native tokenizer shipped | 4–8 plus platform/packaging files if a native extension is chosen |

### Hermes: precise runtime flow

#### Built-in always-injected store

`run_agent.py::AIAgent` is assembled from mixins. `agent/agent_init.py::_init_memory()` (1327–1407) resolves built-in flags and defaults, constructs `tools/memory_tool_store.py::MemoryStore(memory_char_limit=2200,user_char_limit=1375)` (99–108), then calls `load_from_disk()` (136–168). Files are profile-scoped under `get_memory_dir()` (`tools/memory_tool.py`; paths resolved by `MemoryStore._path_for()` at 212–215): `memories/MEMORY.md` and `memories/USER.md`.

The store parses `\n§\n` separated entries, deduplicates preserving order, and records a **frozen system-prompt snapshot**. `_char_count()` (220–224) uses `len(ENTRY_DELIMITER.join(entries))`: Unicode code points in Python, including delimiters; not UTF-8 bytes or model tokens. Rendered headers and wrappers are outside that store-content budget. `_render_block()` (483–489) wraps content; `format_for_system_prompt()` (463–466) returns the frozen snapshot. `agent/system_prompt.py::_memory_parts()` (516–544) selects enabled MEMORY and USER blocks; `build_system_prompt_parts()` includes these in `volatile_parts` (783), but the resulting system prompt is cached for the conversation. Writes do not rebuild it mid-turn or mid-session.

**Crucial failure to meet hard injection bounds:** `load_from_disk()` (158–168) warns when stored content exceeds limits but says entries stay loaded and does not truncate. `tests/tools/test_memory_tool.py::test_over_limit_file_loads_but_warns()` (394–411) verifies it. A user, shell, or external MCP bridge can enlarge the prompt beyond 2,200/1,375. External memory-provider `system_prompt_block()` is also joined without a canonical cap by `MemoryManager.build_system_prompt()` (437–442). This is a policy discipline, not a universal enforced budget.

#### Writes, consolidation, approval, and failure handling

Model `memory` calls are intercepted in `agent/inline_tool_executors.py::_memory()` before generic tool dispatch, then `tools/memory_tool.py::memory_tool()` (206–219), `_memory_tool()` (226–270), write/background gates, and `MemoryStore.add()/replace()/remove()/apply_batch()`.

`MemoryStore._mutate()` (242–274) obtains an exclusive sibling `.lock`, re-reads the actual current file, refuses unreadable content, detects unroundtrippable drift before destructive changes, applies operations, and writes atomically. `_file_lock()` (170–210) uses flock/msvcrt, tightens lock mode to 0600, and uses O_NOFOLLOW where available. `_write_file()` (521–527) calls `atomic_write_text`. `add()` (276–296) rejects overflow; replacement and batch validate the final result rather than rejecting temporary intermediate overflow. `apply_batch()`/`_batch()` (397–461) is all-or-nothing and rejects an empty final store. Overflow asks the model to consolidate via replace/remove; **there is no independent built-in memory compaction algorithm here**. `_MAX_CONSOLIDATION_FAILURES_PER_TURN=3` (94–97); after the fourth failure `_consolidation_failure()` returns terminal `done=true` (118–134), protecting the user's final reply from endless saving loops.

`tools/memory_tool.py::_background_delete_gate()` (157–204) stages unattended review replace/remove, including whole batches containing destructive operations; unattended add can still apply. `_apply_write_gate()` provides optional foreground/background write approval. `apply_memory_pending()` (307–330) bypasses the gate only for approved replay, verifies exact pinned entries, and refuses old destructive records without pinning. `MemoryStore._locate()` (318–334) enforces exact reviewed entry identity when `matched_entry` is present, rather than replaying a stale substring against newer memory. This is a valuable concept for staged OpenClaw consolidation, not a reason to copy the delimiter file store.

Threat handling is explicit: `_scan_memory_content()` (26–29) calls `tools/threat_patterns.py::first_threat_message(scope="strict")`; add, replace, and batch reject malicious content. `load_from_disk()` checks every entry with strict `scan_for_threats()`, replaces threat hits with a `[BLOCKED: ...]` placeholder **only in the prompt snapshot**, retains raw live content so the user can inspect and remove it (136–153). It does not hide or delete evidence.

#### Learning and provider background updates

`agent/turn_context.py::_tick_memory_nudge()` (745–755) increments completed user-turn accounting and fires at the configured interval, default 10 (`agent_init.py:1332,1356`). Turn context passes the review signal into background review. `run_agent.py::_spawn_background_review()` and `agent/background_review.py::spawn_background_review_thread()` (1330–1358) fork the conversation snapshot; memory review only has the configured built-in target/tool surface. `load_background_review_settings()` defaults task enablement to true (228–235). Review-origin destructive memory operations are staged as above. The background reviewer is not a replacement for the store's budget checks.

External providers use `agent/memory_provider.py::MemoryProvider` (84–286): initialize/shutdown, static system-prompt guidance, prefetch/queue_prefetch, sync_turn, tools, on_session_end/switch, on_pre_compress, on_delegation, on_memory_write. `MemoryManager.prefetch_all()` (447–455) runs nontrivial queries; `_prefetch_provider()` (457–502) applies external timeout, skips a provider with an outstanding daemon call, and spills oversized recall. `agent/turn_context.py::_memory_turn_start_and_prefetch()` (889–921) prepares recall for the model-facing user-turn content rather than rebuilding the system prefix. `run_agent.py::_sync_external_memory_for_turn()` (923–955) excludes interrupted/incomplete turns, then `MemoryManager.sync_all()` (533–557) queues serialized writes. `_submit_background()` (559–596) uses a one-worker executor with copied contextvars, tracking write/prefetch classes and shutdown drainage. A failed executor can fall back inline, so its “nonblocking” contract has a failure-path exception. Session close/reset triggers `on_session_end`; `conversation_compression.py::_pre_compress_memory_context()` (2972–3009) supports provider checkpoint versions and a required durable checkpoint before compression where the provider contract requires it.

#### Session storage and retrieval

`agent/session_persistence.py::_db_flush_collect()` (249–288) collects unflushed messages; `_db_flush_write()` (290–305) calls `SessionDB.append_messages_batch()`. `hermes_state.py::SessionDB` (459–465, constructor 578+) owns profile `state.db`, WAL/read pool/writer/lease/recovery state. Actual DDL is `hermes_state_common.py::SCHEMA_SQL`, schema version 31 (283), sessions (382–447), messages (449–480), usage, state metadata, compression locks, turn leases, async delegations. This is not merely JSON session logs.

`tools/session_search_tool.py::session_search()` (619–640) owns four shapes: discovery, bounded anchored scroll, session read, and recent browse. `_discover()` (354–431) calls `SessionDB.search_messages()`, deduplicates compression lineage, hides still-live current/delegated context, makes compacted rows recoverable, hydrates the strongest result, and offers exact anchor expansion. `_read_session()` (447–462) uses head/tail and caps message content at 2,000. `_scroll()` (531–571) validates anchor ownership, rebinding only within valid lineage. It does **not** require an auxiliary LLM summarizer in this snapshot.

`hermes_state_search.py::SessionSearchMixin.search_messages()` (1062–1083) and `_search_messages_impl()` (1085–1189) use FTS5 rank, validated queries, source/role/time filters, rewind-aware active/compacted policy, and lexical fallbacks. `hermes_state_common.py::FTS_SQL` (773–830) uses external-content FTS over content, tool_name, tool_calls; the tool content projection is bounded. `hermes_state_fts.py` owns base/trigram/optional CJK indexes and can detach corrupt derived FTS while continuing canonical message writes (354–424). This is robust lexical session recall, not built-in vector/hybrid persistent memory search. Optional memory plugins add other backends; their existence is not evidence the built-in memory store has these properties.

### OpenClaw: precise runtime flow

#### Injection owners, limits, carriers, and privacy

Canonical bootstrap filenames and order: `src/agents/workspace-bootstrap-policy.ts::WORKSPACE_BOOTSTRAP_FILENAMES` (29–36), USER at 14, MEMORY at 16. `src/agents/workspace.ts::loadWorkspaceBootstrapFiles()` (911–980) performs guarded reads, skips missing exact root USER/MEMORY, and surfaces unreadable markers without assuming empty state. `src/agents/workspace-bootstrap-read.ts:5` has a separate **2 MiB read byte limit**; this is not the prompt cap.

`src/agents/bootstrap-files.ts::resolveBootstrapFiles()` (306–394) loads the shared session snapshot, adds an authenticated personal USER overlay, applies session/privacy filtering, provenance classification, hooks, and revalidates protected files after hooks. `resolveIneligibleAutomaticMemoryFiles()` (208–274) rejects origin classes other than owner/agent and excludes candidates on classification errors/unsupported runtime. A runtime `unavailable` result follows the existing policy and does not remove all files. `src/agents/workspace.ts::filterBootstrapFilesForSession()` (1013+) excludes root MEMORY from groups/channels, cron and subagents; subagents only get AGENTS; cron has an explicit profile allowlist. Preserve these boundaries.

`src/agents/embedded-agent-helpers/bootstrap.ts::buildBootstrapContextFiles()` (387–455) enforces per-file/aggregate limits with UTF-16-safe slicing: default per-file 20,000 and aggregate 60,000 (88–89), special USER max 4,000 (92; applied 429–432). These are JavaScript `.length` **UTF-16 code units**, not bytes, graphemes, Python code points, or tokens. Marker/separator content counts in the returned budget, but outer system-prompt labels and non-file additions are separate. A personal USER exceeding its budget is skipped whole (434–437), preserving indivisible directives. Shared USER can be truncated. Critically the 4K cap is **per file**: shared USER plus personal USER can each consume it. The proposed 1–2K product budget needs an explicit combined user-category budget, not only a smaller constant.

Budget statistics use `src/agents/bootstrap-budget.ts::effectiveBootstrapFileLimit()` (41–46), `isFixedUserCapFile()` (55–60), reports/warnings and Doctor. Update diagnostics alongside the actual enforcement so remediation never tells a user to raise a fixed cap. Normal immutable bootstrap snapshots live in `bootstrap-cache.ts`; personal context has its own refresh/hash contract (`workspace-personal-bootstrap.ts`, `src/agents/cli-runner/bootstrap-transport.ts`). Do not force every memory write to refresh a stable prompt mid-session.

Carriers traced:

| Runtime path | Actual path/symbol | Current MEMORY/USER behavior |
|---|---|---|
| Embedded agent and workers using it | `src/agents/embedded-agent-runner/run/attempt-bootstrap-prepare.ts::prepareEmbeddedAttemptBootstrap()` 63–146 → common builder → `system-prompt.ts::buildAgentSystemPrompt()` 889–906 | Canonical files are project context; provenance/privacy filters and caps apply. Worker remote workspace access goes through the owner, not a second Gateway filesystem copy. |
| CLI/native command runners | `src/agents/cli-runner/prepare.ts` 774+ → `resolveBootstrapContextForRun()`; `src/agents/cli-runner/bootstrap-transport.ts::resolveCliBootstrapPromptHash()` | Uses common budgets; preserves first/live prompt transport and personal context refresh semantics. |
| Copilot | `extensions/copilot/src/workspace-bootstrap.ts::resolveCopilotWorkspaceBootstrapContext()` 31–80 | Common bounded bootstrap; SDK-native AGENTS removed to avoid duplication; other profile/memory files rendered. |
| ACPX | `extensions/acpx/src/harness-attempt.ts` 167–195 | First request resolves common bounded bootstrap into developer instructions; later requests do not reinject. |
| Native Codex | `extensions/codex/src/app-server/attempt-workspace-context.ts::buildCodexWorkspaceBootstrapContext()` 72–190 → `src/agents/harness/workspace-context.ts::prepareAgentWorkspaceContext()` 47–165 | Root MEMORY is removed from budgeted prompt files when memory-tool routing is active; only paths and tool guidance included (Codex renderer 214–232). USER/SOUL/IDENTITY are separate persona instructions. |
| AgentsAPI | `extensions/agentsapi/agentsapi-prompt.ts` 76–128 → same harness preparation | Same tool-routed MEMORY policy; profile and instruction snapshots have common USER limits. |
| Realtime/voice | `src/agents/realtime-bootstrap-context.ts::resolveRealtimeBootstrapContextInstructions()` 55–160 | Defaults IDENTITY, USER, SOUL only; 12K aggregate including headings/preamble (40,115–143), common per-file builder. Explicit extra files have separate safe reads then common content caps; budget-aware known identity must survive aliases. |
| Compaction and diagnostics | `src/agents/embedded-agent-runner/prepared-compaction-runtime.ts` 165+; `src/auto-reply/reply/commands-system-prompt.ts` 181+; `bootstrap-files-diagnostics.ts` | Reuse common resolver; need budget compatibility regressions. |
| Context-engine memory guidance | `src/context-engine/delegate.ts::prepareMemorySystemPromptAddition()` 174–178 | Delegates to selected memory provider, not an independent canonical-file writer. Custom engine `systemPromptAddition` is separate plugin-authored content; generic hooks can add context. A canonical cap must not falsely claim to bound the entire prompt or arbitrary plugin prose. |

`src/agents/embedded-agent-runner/run/attempt-context-engine-helpers.ts::resolveAttemptBootstrapContext()` (27–68) honors always/continuation-skip/never, lightweight/heartbeat/raw probes. “Always injected canonical” cannot mean undoing these runtime decisions.

Two existing additional bounded-memory seams already solve much of the context-growth problem: `src/agents/project-memory-bootstrap.ts` caps project recall at 2K and each entry at 600 (25–26,83–142), filters project tags and authoritative automatic-recall eligibility; `extensions/active-memory/types.ts` caps default summary at 220 (11), query at 480 (99); `extensions/active-memory/index.ts` hooks proactively retrieve only eligible sessions with owner-configured recall tools. Keep query-relevant retrieval content distinct from canonical context and report their separate budgets.

#### Storage, search, provenance, failures

`extensions/memory-core/index.ts` registers memory capability and lazy tools/runtime (219–258), preserving plugin ownership. `createMemorySearchTool()` (`extensions/memory-core/src/tools.ts:226+`) resolves corpus/session scope, uses `getMemorySearchManager`, enforces visibility and deadlines, returns disabled/stale/unavailable outcomes explicitly; `createMemoryGetTool()` (569+) reads safe exact file excerpts. Session hit expansion routes to existing **sessions_search + sessions_history**, not raw transcript files (`memory-tool-contract.ts:115–159`). Do not port Hermes's session_search as an extra core tool.

`extensions/memory-core/src/memory/manager-search-orchestration.ts::MemorySearchOrchestration.search()` (67–103) → `searchCandidates()` (125+) → keyword worker + query embedding + vector search → `hybrid.ts::mergeHybridResults()` (66–296) → selection. Ranking includes BM25/text 0.3 and vector 0.7, candidate expansion, MMR lambda 0.7, 30-day temporal half-life, importance multiplier, exact path specificity, project ranking, and provenance metadata. Defaults are actually **enabled** in `src/agents/memory-search.ts:116–122`; helper module fallback constants may be false but are not the resolved runtime defaults. `importance.ts` maps bounded 1–10 importance to 0.80–1.25 multiplier. `temporal-decay.ts` uses indexed session activity/remote file metadata and leaves evergreen MEMORY/USER/topic memory undecayed. `mmr.ts::applyMMRToHybridResults()` uses diversity-aware reranking. Results retain path, lines, source, scores, importance, triggers, projectKey, provenance.

Canonical source files and sessions remain durable; SQLite memory index is rebuildable: `packages/memory-host-sdk/src/host/memory-schema-base.ts` defines strict sources/chunks/meta/cache/state, chunks include content hashes, line spans, model, embedding BLOB, updated_at (22–35); vector table `memory_index_chunks_vec`; FTS schema is `memory-schema-fts.ts` with body + path indexes and reconciled triggers. `memory-schema-provenance.ts:8–17` has additive authoritative origin/session-kind metadata, missing legacy chunks backfilled as untrusted (49–57). `memory-schema-recall.ts` carries importance/triggers/project keys separately. KNN can run in a subprocess; database retrieval uses workers/admitted generations. Preserve these seams.

Search failure behavior is strong: `manager-search-orchestration.ts` handles initial index bootstrap, provider initialization failure, valid keyword fallback, provider identity generation changes, background sync, index-version repair, partial lexical results, aborts and overload. Embedding failures can fall back to keyword-only (around 459–542); invalid corpus/scope identity fails closed. It does not silently treat a missing embedding provider as no memory. Relevant tests: `manager-search-bootstrap.test.ts`, `manager-search-generation.test.ts`, `manager-search-upgrade.test.ts`, `manager-provider-lifecycle-fallback.test.ts`, `manager-retrieval-offthread.test.ts`, `manager-search-provenance.test.ts`, `manager-memory-source-race.test.ts`.

Cross-session semantic index defaults/policy are explicit: `src/agents/memory-search-source-policy.ts::resolveMemorySearchSourcePolicy()` (21–43) separates indexed sources from ordinary search sources; rememberAcrossConversations can index sessions for trusted recall without exposing them to every generic memory query. `extensions/memory-core/src/session-search-visibility.ts` uses the shared session visibility, agent-to-agent, sandbox, all-alias privacy and reset-cutoff policies. Do not broaden it while changing memory budgets.

OpenClaw session history is already SQLite canonical state: `src/state/openclaw-agent-schema.sql::transcript_events` (566–602) stores JSON or bounded zstd payloads with navigation data, archives/cold archives (608+), derived active events and FTS (888–937). `session-accessor.sqlite-transcript-message-append.ts` prepares idempotent canonical message bytes; `session-accessor.sqlite-transcript-store.ts::appendTranscriptEventInTransaction()` writes canonical and projection state. `session-transcript-index.ts::createTranscriptIndexAppenderInTransaction()` (235+) appends FTS in the same transaction; `session-transcript-search.ts::searchSessionTranscripts()` (54+) dispatches to the owner/worker, validates query and agent/session scope before LIMIT, filters dirty rewind generations, and uses bound FTS MATCH/BM25 (153–215). `sessions-search-tool.ts::createSessionsSearchTool()` (296+) and `sessions-history-tool.ts::createSessionsHistoryTool()` (339+) supply bounded exact navigation. Cold archived transcripts intentionally require restore and are reported as excluded; no naive change to that retention contract.

Provenance is not content trust. `extensions/memory-core/src/memory/memory-path-provenance.ts::resolveMemoryPathClassification()` validates canonical path/remote source, marks dreaming artifacts system, consults persisted origin evidence, and otherwise treats workspace memory as agent (87–89). `src/agents/memory-write-provenance.ts::withMemoryWriteProvenance()` (30–80) wraps write/delete effects and retains live tool authority. `bootstrap-files.ts` filters untrusted/system files before and after hooks; `dreaming-consolidation-candidates.ts::isPromotionOriginBlocked()`/`isConsolidationCandidateEligible()` (11–24) reject tainted origins and noninteractive session-derived candidates. Hermes pattern scanning can complement this; it must not replace origin/visibility and must not claim semantic safety.

#### Memory writes and existing bounded consolidation

Pre-compaction flow: auto-reply memory flush planning → selected memory capability `flushPlanResolver` → `extensions/memory-core/src/flush-plan.ts::buildMemoryFlushPlan()` → dedicated memory trigger/tool projection → append-only `memory/YYYY-MM-DD.md` → provenance/index ingestion. `flush-plan.ts` explicitly treats root MEMORY/DREAMS/SOUL/AGENTS read-only (15–35); the default token soft threshold is 4,000 and transcript-force threshold 2 MiB (12–13), unrelated to canonical file character caps. `src/agents/agent-tools.memory-flush.ts::projectMemoryFlushTools()` (99–128) only admits append-only writer/read or selected provider-owned persistence tools; it records actual successful persistence and refuses unavailable tool-arm writers before inference. This is stronger than relying on a prompt alone.

Dreaming flow: memory-core scheduled deep sweep (`dreaming.ts:177–264`) → rank recall candidates → `applyShortTermPromotions()` (`short-term-promotion-apply.ts:202+`) → provenance/source rehydration → optional subagent `consolidateMemory()` → structured plan validation → reread authoritative candidate/store/file under locks → bounded commit → mark successfully written candidates promoted → origins and DREAMS summaries.

`memory-budget.ts::DEFAULT_MEMORY_FILE_MAX_CHARS=10000` (15); `resolveMemoryPromotionFileMaxChars()` (22–46) takes the smallest consuming agent bootstrap cap. `compactMemoryForBudget()` (202+) only removes oldest **entirely generated** promotion sections under entry-loss limits; human/mixed blocks are preserved. `dreaming-consolidation.ts::applyMemoryConsolidationPlan()` (284–394) constrains removal fraction, verifies reviewed exact entries/lineage, only emits supplied candidate result text, rejects NUL and final over-budget content (371–377). `consolidateMemory()` (396+) rejects missing/invalid outputs and uses append-only fallback. This already solves bounded machine-generated growth; it does not ensure manually oversized files or whole injection are 4K.

`short-term-promotion-apply.ts` snapshots content hashes and candidate fingerprints (359–362), revalidates after async review and under locks (396–477), saves preimage before destructive consolidation (482–501), reserves origins before publication, and distinguishes committed/uncertain atomic publication. Append fallback rejects over-budget file (567–576). `short-term-promotion-memory-write.ts::commitMemoryContent()` (159+) uses expected hash before rename, sync and atomic replacement; existing writable-file fallback is permitted only for append mode and preserves the original on failure. Do not replace with Hermes's simple file mutation path.

Existing backup is not an unlimited retrieval archive: `dreaming-consolidation-artifacts.ts::storeMemoryPreimage()` (34–69) rotates **eight** backups (`CONSOLIDATION_BACKUP_LIMIT` at 12). The recall store keeps fuller snippets than visible MEMORY text (`short-term-promotion-apply.ts:89–91`), but a source/retention operation can delete them. Tightening to 4K must archive displaced canonical facts into a **durable indexed memory source**, not assume the rebuildable chunk index or rotating preimages permanently retains them. The user invariant means *no fixed canonical-size quota on retrieval storage*, not an exemption from explicit forget, retention, privacy, or owner deletion.

### Proposed bounded canonical architecture (design only)

Choose OpenClaw-native defaults: **USER 2,000 UTF-16 code units combined across shared/personal overlays**, **MEMORY 4,000 UTF-16 code units**. Preserve established char semantics and surrogate-safe utilities; document this accurately. Do not pretend a char quota is a token quota for all languages.

One authoritative `CanonicalMemoryBudget` policy should resolve caps and expose prepared facts to both core bootstrap and memory plugin writers through the existing SDK:

```ts
interface CanonicalMemoryBudget {
  unit: "utf16-code-units";
  userMaxChars: number;       // default 2_000; combined category budget
  memoryMaxChars: number;     // default 4_000
}
interface CanonicalMemoryProjection {
  kind: "user" | "memory";
  sourceIds: readonly string[];
  sourceHashes: readonly string[];
  content: string;
  usedChars: number;
  overflow: boolean;
  retrievalReferences: readonly string[];
}
```

Extend the existing builder, not a new manager. The shared USER is a baseline and authenticated personal USER a whole override/addendum: select a deterministic composition whose *combined rendered content* fits 2K; if a personal directive cannot fit whole, retain existing whole-file omission and surface its warning, then stage a shortened proposal. Never cut a selected personal instruction into a different instruction. Ensure known canonical source identity survives remapping/hook aliases; category caps must not depend solely on a user-controlled basename. Deduplicate content and decide explicitly whether headings/reference notices count. Report canonical versus retrieval context separately; total bootstrap caps remain in force.

MEMORY can use deterministic entry projection when a legacy source is over budget, with an explicit “additional memory available through recall” marker. Leave the source intact until approved consolidation. Make projection stable for the session; a changed source gets a new projection at the owner's next-session/explicit refresh boundary. Trust verification may invalidate malicious content immediately through its existing security lifecycle, but ordinary factual writes should not rebuild prompt history.

Synchronize `resolveMemoryPromotionFileMaxChars()` with the resolved canonical MEMORY cap; honor the tightest sharing-agent budget and retain authoritative hash/live workspace guards. Admission caps must cover **both regular files and manually changed files**; writer validation alone is insufficient. Preserve native MEMORY tool routing, group/subagent exclusions, realtime allowlist, raw-probe/lightweight and continuation-skip semantics.

To satisfy the new product requirement on native harnesses, add a declared `canonicalMemoryContext` capability and a prepared `CanonicalMemoryProjection` to the **existing** `prepareAgentWorkspaceContext()` result. Stage support first in Codex/AgentsAPI: deliver the verified 4K canonical snapshot as clearly delimited factual context through the existing `memoryInstructions`/thread carrier, retaining memory tools for every larger fact. Do not label MEMORY as user policy or merge it into persona instructions. Capture the snapshot at the same session/thread boundary as upstream workspace context and preserve explicit refresh/invalidation rules; no edits to accepted transcript history. Unsupported native harnesses must report the capability gap instead of silently promising always-injected MEMORY. The product profile can opt into this supported projection across harnesses after parity tests. This adds roughly **4–6 production/carrier/SDK files** above the cap-only implementation (Codex workspace context and request carrier, AgentsAPI prompt, shared harness workspace context/types, capability contract), complexity medium, risk medium, divergence moderate but localized. Review whether realtime should add the bounded MEMORY profile by explicit selection; it presently excludes it. Keep lightweight/raw/group/subagent exclusions intentional and documented—the canonical product guarantee applies to eligible personal-agent conversations, not every internal model call.

Lossless migration: discover existing oversized root/USER entries under owner privacy scope; persist displaced fact text, original source/hash, timestamp and provenance as a named retrieval artifact (e.g. indexed topic/archive under memory/) using existing artifact write/index owners; generate a compact proposal/diff against the precise preimage; validate scan, caps, origin, entry identities and overlap; stage it; on approval atomically activate it under existing commit locks/hash checks. Rejection keeps the source; projection continues bounded. Do not automatically rewrite user directives merely to reduce token cost. Automatic canonical activation requires an explicit policy opt-in; use the proposed shared staging owner, but do not make routine retrieval indexing a self-modification approval.

Existing dreaming consolidation should return a proposal in propose mode and stage all root canonical rewrites; default auto behavior for dreaming must be reviewed independently of self-learning skill mode. Manual memory-forget and user-requested edits should retain their existing authorizations. Shell/file tools can still write mutable files; enforcement must happen again at **read/injection**, because a write-tool wrapper alone cannot intercept every shell, plugin, remote provider or external editor.

## 7. Execution Providers

### Hermes: exact execution contracts and flow
`agent/terminal_env_provider.py:20–105 TerminalEnvironmentProvider` extends `ProviderBase`. Required methods are `is_available()` and `create_environment(cwd, timeout, task_id, image, container_config, **kwargs)`. Optional hooks include `check_requirements(config)`, `probe()`, `setup_instructions()`, `post_setup()`, `doctor_checks()`. The returned object is a `BaseEnvironment` duck type, not a typed process transport. Classification attributes are `is_remote`, `is_container`, `session_isolated_when_nonpersistent`, `skip_container_guards`, `cache_path_base`, `strip_env_keys`, `env_description`. `skip_container_guards` defaults to `is_container`, which is itself true by default. This is a consequential security default; do not transplant it.

`agent/terminal_env_registry.py:23–42` reserves built-in names `local/docker/singularity/modal/managed_modal/daytona/vercel_sandbox/ssh`. Its generic `ProviderRegistry` is scope-aware. `provider_flag():53–69` catches property failures and returns a caller-provided default. `plugin_strip_env_keys():69–86` unions declared credential environment names across all scopes. `hermes_cli/plugins.py:1114–1116` exposes the plugin registration hook. `tests/agent/test_terminal_env_registry.py:56–200` covers registration, reserved names, profile scopes, defaults, raising properties, credential union and generation restoration.

**Important correction:** Hermes does not route every built-in through `TerminalEnvironmentProvider`. `tools/terminal_tool_backends.py:130–259` contains separate built-in builders and `_ENV_BUILDERS`; `_create_environment()` picks a built-in or `_build_plugin_env()`. `_SANDBOX_ROWS` handles Singularity/Daytona/Vercel. Modal has a direct-vs-managed decision. Plugin environments are stamped with `_hermes_backend_name` and `env_type`, including fail-soft attribute writes. This is a dispatch table plus plugin fallback, not a fully unified provider architecture superior to OpenClaw.

The actual command path is:

```text
registry tool handler: terminal_tool.py:_handle_terminal (1562)
  -> terminal_tool (1369)
  -> _plan_execution (1077): config/cwd/resource/timeout/session routing
  -> _acquire_env (1184): reuse or _create_environment
  -> bounded _pre_exec_block (1314; call 1438): gateway lifecycle, cwd, self-repo guards
  -> _run_approval_guards (1018; call 1455)
  -> spawn_background_process (1463), or _run_foreground (1240; call 1477)
  -> BaseEnvironment.execute (base.py:604–718)
  -> _before_execute -> command preparation -> snapshot/cwd wrapper -> _run_bash
  -> ProcessHandle polling/draining -> timeout/interrupt cleanup -> cwd/result
```

`BaseEnvironment` requires `_run_bash()` and `cleanup()` (`tools/environments/base.py:225–284`). It also supplies `fetch_file()`, `fetch_realpath()`, session setup, stdin strategies and `_wait_for_process():450–554`. `ProcessHandle` (`base_output.py:269–281`) requires poll/kill/wait/stdout/returncode. SDK calls use `_ThreadedProcessHandle:284–340`, so a blocking cloud API can look like a local subprocess. Foreground output uses a head/tail bounded collector while internal file/RPC consumers retain full fidelity. `BaseEnvironment.execute()` wraps wait work in `agent.deadline.run_bounded_sync`, carrying interrupt identity/activity callback to a worker and killing processes on expiry. This addresses its synchronous Python call architecture; OpenClaw should keep its asynchronous process supervision.

`base_session_env.py:89–169` captures and sources shell exports, functions and aliases and emits a cwd marker. Session/profile passthrough names are excluded from shared snapshots. This persistence is convenient but carries executable shell state and credentials across calls. It is not a requirement for a clean backend contract and should not become an OpenClaw default.

`terminal_tool_lifecycle.py:184–249 ensure_task_env()` lazily provisions under a shared environment lock; active environments and activity timestamps are process-resident. `_cleanup_inactive_envs():143–174` evicts stale objects and tears them down outside the map lock. `_cleanup_env():84–101` tries `cleanup/stop/terminate` by duck type. `cleanup_vm():290–310` preserves persistent environments unless forced. There is no durable generic lifecycle state machine equivalent to OpenClaw worker leases.

#### Concrete Hermes backends

| Backend | Source/symbols | Actual semantics and limitations |
|---|---|---|
| Local | `tools/environments/local.py:951–1120 LocalEnvironment` | Fresh bash process each command; persisted shell snapshot/cwd, temporary file cleanup, process group plus descendant termination. `build_subprocess_env():350` and `hermes_subprocess_env():317` filter profile/provider secrets. |
| Docker | `tools/terminal_tool_backends.py:134–157 _build_docker_env`, `tools/environments/docker.py DockerEnvironment` | Resource config, optional host mounts and environment forwarding, cross-process container reuse; session-scoped mode disables cross-process persistence. Factory calls orphan reaper. |
| SSH | `tools/environments/ssh.py:45–153 SSHEnvironment`, `_run_bash():278`, `cleanup():290` | Fresh `ssh bash -c` per command, ControlMaster sockets on non-Windows, BatchMode/connect timeout, **StrictHostKeyChecking=accept-new**, optional key path, SendEnv names in argv with values in client environment. Probe has separate socket; normal startup syncs `.hermes` then initializes a shell snapshot. |
| Modal | `tools/environments/modal.py:130–280 ModalEnvironment` | Async SDK driven from dedicated thread; profile-local `modal_snapshots.json`, namespaced direct task IDs; restore fails back to base image and drops stale reference. Cleanup snapshot_filesystem(ttl=None), persist snapshot ID, then terminate even if snapshot fails. Filesystem persistence, not process hibernation. |
| Managed Modal | `tools/terminal_tool_backends.py:160–178 _build_modal_env`, `tools/environments/managed_modal.py ManagedModalEnvironment` | Nous managed tool gateway selection/auth versus direct Modal credentials. Highly Hermes/Nous-specific; do not port managed gateway baggage. |
| Daytona | `tools/environments/daytona.py:24–207 DaytonaEnvironment` | Lookup by task-scoped name then legacy labels, start/resume or create, resources converted MB→GiB (disk capped 10 GiB), sync `.hermes`, SDK commands under threaded process handle. Interrupt stops the entire sandbox; next command restarts it. Persistent cleanup stops, ephemeral cleanup deletes. Errors on cleanup are logged and swallowed. Resume exceptions can fall through into a fresh create; do not reproduce unqualified retry/recreation around uncertain allocation outcomes. |
| Vercel | `tools/environments/vercel_sandbox.py:163–418 VercelSandboxEnvironment` | SDK availability/auth/runtime checks in `_check_vercel`; snapshot restore/task map in `vercel_sandbox_snapshots.json`; transient retry helper; snapshots during cleanup then stop. `_ensure_sandbox_ready():295` and recreation notices protect against silent sandbox loss. |
| Singularity | `tools/environments/singularity.py`, factory dispatch above | HPC/container backend. No demonstrated product requirement; IGNORE until demanded. |

`tools/environments/file_sync.py:128–142 iter_sync_files()` enumerates Hermes-specific state/artifacts. `FileSyncManager:188–489` hashes inputs, plans uploads/deletions, optionally batches uploads and stages reverse synchronization with bounds, locking and credential exclusions. OpenClaw already has richer workspace ownership/manifest/reconciliation and anchored fs bridges. Do not copy a broad host-home sync manager into OpenClaw cloud adapters.

### OpenClaw: owners, adapters and side effects

Keep four concepts distinct:

* **Terminal backend:** `SandboxBackendHandle` runs a command and serves filesystem operations in a selected runtime.
* **Whole-agent worker provider:** `WorkerProvider` allocates/adopts, bootstraps, inspects and destroys a machine/lease. It may run entire turns (`worker-turn`) or provide a remote executor (`remote-exec`).
* **Agent harness/model runtime:** `src/agents/harness/types.ts:465–648 AgentHarnessContract/AgentHarnessV2` owns runAttempt, native tools/compaction/session lifecycle and model transport. `src/agents/harness/execution-environment.ts:187 assertAgentHarnessExecutionEnvironment()` validates runtime restrictions. It is not a shell provider.
* **Computer transport:** `src/gateway/worker-environments/computer-transport.ts:28,240–266` forwards `screen.snapshot` and `computer.act` under worker/connection ownership. A desktop capability is optional on `WorkerLease`, not mandatory for shell execution.

#### Terminal backend contract

`backend.types.ts:13–81` has `SandboxBackendManager.describeRuntime/removeRuntime`, `CreateSandboxBackendParams` (session/scope/workspaces/config/prepared resource mounts/current authority), factories and static capability/workdir resolution. `backend-handle.types.ts:3–121` has opaque runtime identity, environment/workdir, host-vs-backend cwd validation, roots, `buildExecSpec({command, workdir, env, usePty})`, `runShellCommand()`, `createFsBridge()`, `finalizeExec()` and termination-only `prepareProcessCleanup()`.

`backend.ts:81–114 registerSandboxBackend()` returns a disposer and tracks generations so retiring an older plugin cannot resurrect stale authority. `createSandboxBackend():171–271` optionally reserves a durable runtime identity before allocation, locks the generation, composes `assertRuntimeCurrent`, rejects a provider returning a different identity, completes reservation and retries only the specifically retired generation once. The built-in registry includes Docker, Podman and SSH (`273–299`). This is already the desired agent→contract→backend architecture for sandbox commands.

Actual flow:

```text
resolveSandboxContext (sandbox/context.ts:520)
  -> createSandboxBackend (backend.ts:171)
  -> factory: Docker/Podman/SSH/OpenShell/plugin
  -> SandboxContext backend handle + FsBridge

createExecTool (bash-tools.exec-run.ts:87)
  -> resolve target (bash-tools.exec-runtime.ts:167)
  -> config/session/host security floor (exec-run.ts:306–357)
  -> cwd validation + run environment/secret preparation (373–456)
  -> node: executeNodeHostCommand (457)
     -> gateway node.invoke/system.run
     -> handleSystemRunInvoke (node-host/invoke-system-run.ts:1044)
     -> node-host local policy/approval/binding checks -> supervised launch
  -> gateway: processGatewayAllowlist (510–577)
  -> runExecProcess (592; exec-runtime.ts:521)
     -> sandbox.buildExecSpec (764–794) OR local shell execution spec
     -> process supervisor admission/current authority
     -> spawn, output/background management, timeout/cancel, finalization
```

The `gateway/node/sandbox` target branches select materially different authorities and transports. They are not giant per-vendor switches. Preserve them while adding vendor backend plugins.

`docker-backend.ts:151–175` wraps Docker/Podman; handle creation `182–309` supplies execution specs, temporary env files cleaned through finalization, filesystem shell operations and retained termination-only custody. The container path keeps PATH handling separate and identity-specific GitHub credentials constrained to the built-in container owner. `backend.ts:180–184` explicitly rejects GitHub identity on unsupported backends; adding a vendor must not accidentally bypass that limitation.

`ssh-backend.ts:105–149` delegates to `createRemoteShellSandboxBackend()`. `remote-shell-backend.ts:49–180` owns remote workdir validation, runtime bootstrap, remote skills refresh, transport session preparation and opaque cleanup tokens. Authority is rechecked after async work and before transport admission. Runtime bootstrap shares one promise and resets after failure. `remote-fs-bridge*` validates/canonicalizes paths, pins mutation frames and protects against parent aliases/symlink races. Reuse this where a vendor exposes SSH; SDK-only providers must preserve its invariants in their own fs bridge.

`ssh.ts:70–120` materializes identity/certificate/known-hosts with strict permissions and avoids argv/env secret values. Host-key behavior is operator configured, with `StrictHostKeyChecking yes/no`; do not claim all standalone sandbox SSH is pinned by default. Whole-agent workers have a stronger mandatory endpoint contract: `capability-provider.types.ts:72–100` has hostKey and SecretRef, and `src/gateway/worker-environments/ssh.ts:149` rejects missing pinnedHostKey. This differs from Hermes accept-new semantics.

`validate-sandbox-security.ts:23–143` blocks sensitive host mounts including system roots, Docker socket paths and credential directories, canonicalizes ancestor aliases and catches parent mounts exposing protected descendants. `sanitize-env-vars.ts:14–86` filters known provider credential names, suspicious names/values, NUL and oversized values. Existing explicit environment policies and secret-owner lifetimes must survive adapter additions.

#### Whole-agent workers

`WorkerProvider` requires allocation resolution, provision, inspect and destroy; optionally renewal, maintenance, machine/OS options, prepared intent, node enrollment and SSH identity resolution. `WorkerProviderError` (`capability-provider.types.ts:244–273`) separates proven allocation cleanup from indeterminate cleanup. `provider-lifecycle.ts:322–364,429–493,509–687` provisions/replays durable operation IDs, reconciles lost allocation replies, inspects lease states and handles expected/unexpected teardown. `provider-owner-lifecycle.ts:160–258,267–343` revalidates ownership, persists destroying state and keeps indeterminate teardown retryable instead of marking potentially paid live machines gone.

This is materially stronger than Hermes environment-object cleanup and snapshot JSON maps. Keep SQLite state, placement/run claims, enrollment identities and transport authority. Cloud vendors that can expose an OpenClaw node should implement WorkerProvider; a command-only SDK sandbox should begin with SandboxBackend. A provider can support both through one plugin with explicit adapters, without merging owners.

### Future provider shape and migration
A Muse product can expose a unified *selection/description facade* without a new state owner:

```text
Agent/harness
  -> existing tool admission + Trust Engine + execution permissions + action approval
  -> selected execution target
       local gateway / OpenClaw node -> existing exec/system.run owner
       sandbox -> SandboxBackendFactory -> SandboxBackendHandle
                    Docker | Podman | SSH | OpenShell | vendor plugin
       whole-agent placement -> WorkerProvider -> WorkerEnvironmentService
                                 provider lease + node/SSH + optional computer
```

Design-only facade types should reference existing contracts rather than replace them: an `ExecutionEnvironmentDescriptor` with identity, kind (`gateway|node|sandbox|worker`), backend ID, capabilities (`exec`, `filesystem`, `computer`, `checkpoint`), filesystem roots and authority owner; an `ExecutionEnvironmentSelection` can discriminate a sandbox registration ID from worker profile/node ID. Do not invent a universal `execute()` that silently normalizes disparate authorization models.

Stages:

1. Contract inventory and conformance tests around current adapters; no public behavior changes. **LOW**, 4–8 test/docs files, low risk, minimal divergence.
2. One vendor terminal plugin, preserving subprocess/stdin/output/cwd/abort/fs safety. **MEDIUM**, 6–14 files, medium risk, minimal plugin divergence. Prefer SSH reuse if the vendor supports it; SDK-only transport needs a narrow generic transport extension only if the current process-spec contract proves insufficient.
3. Optional WorkerProvider for vendors offering durable machine leases/node runtimes. **HIGH**, 12–25 plugin/integration files, medium–high risk, minimal–moderate divergence.
4. Optional checkpoint/suspend capability after concrete need. **HIGH** for consistent authority/process semantics; distinguish snapshot, stop/resume, process preservation and destructive eviction. 12–25 files; high risk; moderate divergence.
5. A universal consolidation across local/node/sandbox/workers/harness/computers would be **VERY HIGH**, high risk and severe divergence, roughly 60–100+ files. It crosses process authority, host-policy ownership, worker leases, protocol schemas, native harness tools and computer connections. **Do not undertake it.** A facade across existing contracts is medium at most and should be demand-driven.

## 8. Approvals

#### Hermes flow and guarantees

`tools/approval_detection.py:71–166` defines tiny hardline regex floors (root/system/home wipe, mkfs, raw disk writes, fork bomb, kill-all, shutdown). The broader classifier normalizes Unicode/path spellings and scans shell-carrier payloads; dangerous patterns include scripts, credential/security-config writes, package/git/container/system operations. Pattern matching is not a complete shell interpreter or semantic sandbox.

`tools/approval.py:1168–1232 check_all_command_guards()`:

1. Isolated container fast path skips ordinary checks but still applies operator `approvals.deny`.
2. Non-isolated path applies `_floor_block():1052–1075` (catastrophic commands, runtime self-delete, sudo stdin guard, operator deny).
3. Consume prepared batch verdict if exact command/env/host-access matches.
4. YOLO or approvals off allows recoverable commands; permanent allowlist can allow.
5. Unattended contexts apply configured deny/approve policy; if none applies the function permits execution (`1193–1201`).
6. Combine Tirith findings and regex warnings into one human/smart decision; permanent approval is pattern-oriented and pure Tirith stays session-only.

`_should_skip_container_guards():1024–1038` treats Modal/Daytona/Vercel/Singularity as isolated and plugins according to declared flags; Docker skips only without host access. `terminal_tool.py:_run_approval_guards():1018` accepts an internal `force` replay bypass. The source comments' “never bypass” floor applies inside the ordinary guard path; force can skip that entire function. The public model schema does not expose force. Do not interpret this as a public exploit without auditing all trusted replay callers, but do not advertise a universal unbypassable hardline across every internal entry point.

`approval_smart.py:74–131 _smart_approve()` invokes `call_llm(task="approval", temperature=0, max_tokens=16, configured timeout)`, placing operator policy in system instructions and quote-aware comment-stripped command in XML delimiters. Exact word APPROVE/DENY maps to approve/deny; empty, malformed, errors or ESCALATE ask the human. `_smart_verdict():134–160` emits redacted observer hooks. This has sensible fallback behavior, but no typed risk output, action evidence/origin model or executable binding.

#### OpenClaw guarantees

`src/infra/exec-approvals-core.ts:10–15,115–130` defines target, security deny/allowlist/full, ask off/on-miss/always, normalized modes deny/allowlist/ask/auto/full, decisions allow-once/allow-always/deny. `exec-approvals-policy.ts:11–39` owns approval requirement and conservative security/ask intersection. `exec-run.ts:306–357` intersects model-call overrides with configured/host floors. `src/node-host/invoke-system-run.ts:168–186` intersects node-local policy independently, so gateway intent alone is insufficient.

`src/infra/exec-approvals-allowlist.ts:780,1271 evaluateExecAllowlist/evaluateShellAllowlistWithAuthorization` resolves executables and command segments; `exec-approvals-analysis.ts:46–104` builds enforceable shell command representations. Auto skill binary permission remains an execution policy mechanism, not a generalized content scanner.

`src/agents/exec-auto-reviewer.ts:40–45` validates JSON decision/risk/rationale. `74–145` delimits untrusted request and detects reviewer directives; `154–284` rejects duplicate JSON keys, malformed output and high/unknown-risk allows. `359–510` controls preparation/model deadlines and cancellation; failed reviews fall back to human review. Its prompt (`exec-auto-reviewer.prompt.ts:3–48`) distinguishes operator transcript origins from channel/inter-session/internal text and treats transcript content as evidence, not reviewer instructions. Reviews grant only allow-once authority, never durable permission merely because the model said yes.

`src/infra/system-run-approval-binding.ts:57–193` binds argv/cwd/agent/session/env; `prepareSystemRunExecutableIdentityBinding():367–459` binds resolved executable identity; `prepareSystemRunMutableFileBinding():462–551` and `revalidateSystemRunMutableFileBinding():553–623` bind mutable shell/script inputs. `system-run-file-snapshot.ts:10–65` realpaths and hashes script operands and verifies content before execution. `system-run-cwd-binding.ts:15–59` verifies cwd filesystem identity. Gateway approval handling (`bash-tools.exec-host-gateway.ts:379–403,753–903,1234–1242,1417–1459`) revalidates before spawn and denies drift. Node handling (`invoke-system-run.ts:773–839`) rejects cwd/script/executable drift and missing bindings. This is substantially more than command-string approval.

Persisted approval owners are `src/infra/exec-approvals-store.ts`, `exec-approvals-sqlite.ts`, `exec-approvals-authorization.kernel.ts/.worker.ts`; gateway requests/resolution and channel forwarding remain separate transports. Permission records, approval decisions and current run authority must not be merged into content trust records.

**Verdict: KEEP_OPENCLAW. DO NOT PORT HERMES IMPLEMENTATION.** No demonstrated Hermes approval advantage warrants replacement. Its explicit catastrophic-floor examples can seed adversarial regressions when the OpenClaw policy layer changes; an immutable regex floor would be a new product restriction requiring an explicit policy design, not a routine source port.

## 9. APIs

### OpenAI-compatible APIs: KEEP_OPENCLAW
Hermes entry points are in `gateway/platforms/api_server.py:APIServerAdapter`, `_http_route_table` (approximately 1752–1789), and `api_server_openai_routes.py:OpenAICompatRoutesMixin`. `_handle_chat_completions` starts at 636; `_handle_responses` at 1034. The mixin parses requests, resolves route/model/session history, and delegates to `APIServerAdapter._run_agent` (4213 onward). `_run_agent` submits synchronous `AIAgent.run_conversation` to an executor with profile and approval scope. Response snapshots are stored by `api_server.py:ResponseStore` (722 onward), including separate stores per served profile (1875–1888). `_handle_get_response` (1216) and `_handle_delete_response` (1228) read/delete those snapshots. SSE handling in `_ResponsesStream` (212 onward) emits creation, deltas, tool/reasoning items and terminal outcomes; the stream's incomplete snapshots preserve continuation after interrupted streams. `_iter_stream_items` (28–59) supplies keepalive and queue draining.

OpenClaw `src/gateway/server-http.ts` admits `/v1/models` at 489–491, `/v1/embeddings` at 493–494, `/v1/responses` at 535–539, and `/v1/chat/completions` at 542–548. Endpoints remain configuration-gated. `openai-http.ts:handleOpenAiHttpRequest` (494 onward) and `openresponses-http.ts:handleOpenResponsesHttpRequest` (143 onward) authenticate and validate JSON, install disconnect cancellation, resolve agent/session/model authority, normalize client tools and tool choice, and call `openai-compatible-agent-run.ts:runOpenAiCompatibleAgentCommand` (87–188). That bridge captures current operator authority, combines abort signals, dispatches `agentCommandFromGatewayIngress`, transfers custody at admission, and releases its retained authority in `finally`. HTTP compatibility is not an unrestricted alternate path around Gateway authorization.

Responses continuation uses `openresponses-http.ts` lookup at 358 and persistence at 419, through `openresponses-session-store.ts:lookupResponseSession` / `rememberResponseSession`. The SQLite-backed core plugin-state store binds response IDs to authenticated subject, agent, and requested session; incognito continuations are not durably registered. This stores session linkage rather than Hermes's full response envelopes. GET/DELETE response resources are absent from the inspected OpenClaw compatibility HTTP dispatcher, so full REST response CRUD parity should not be claimed. Add it only if a named client needs those semantics; do not transplant Hermes's response database.

`models-http.ts:handleOpenAiModelsHttpRequest` (56–143) exposes configured OpenClaw agent targets, with GET-only semantics and read-scope checking. `embeddings-http.ts:handleOpenAiEmbeddingsHttpRequest` (165 onward) routes to the selected memory embedding adapter; validation caps 128 inputs, 8,192 UTF-16 units per input, 65,536 total, and 5 MiB JSON body. Requested provider must match the agent's configured memory provider. A model catalog of agent targets is not a claim to proxy every provider's model catalog.

Do not port duplicate Chat Completions, Responses POST/streaming/continuation, model listing, or embedding functionality. OpenClaw already owns them, with stronger typed authorization integration. Hermes does not expose an embeddings HTTP route in its inspected route table.

Tests inspected: Hermes `tests/gateway/test_api_server_runs.py` proves reconnect with `Last-Event-ID` (734 onward), concurrent subscribers (701), run-scoped approval resolution (790), bounded redacted result previews (604), and request authority before parse/admission (212). Its other actual suites cover response history dedupe/caps, reasoning streams, profile-scoped ResponseStore, session ownership, SSE keepalive, and turn boundaries. OpenClaw `src/gateway/openresponses-http.test.ts` tests parsing/tool choice, created-at stability, failure terminal semantics, stream finalization, authority, and continuity via `openresponses-http.continuation.test-support.ts`; `openai-compatible-agent-run.test.ts` checks transferred authority, cancellation/revocation, and detached child custody. Also retain `server-http.openai-compat.test.ts`, `models-http.test.ts`, `embeddings-http.test.ts`, `openresponses-session-store.test.ts`, and `openresponses-parity.test.ts`. Existing tests are evidence of intended contracts, not a claim that they were executed in this audit.

### Hermes runs REST surface: ADAPT_HERMES / future NEW_LAYER

Hermes's clear advantage here is a coherent external run resource, not the agent runtime itself. `api_server_runs.py:_http_routes` (234–240) defines POST runs, GET status/events, POST approval/steer/stop. `_handle_runs` (620 onward) authorizes, validates session/model/author, resolves live bot-chat routing, reserves an optional idempotency key (721), builds `_RunLaunch`, and dispatches `_execute_run` (915) or `_execute_run_via_live_owner` (864). `_execute_run` creates the agent, callbacks, run-scoped approval notifier, and executor work; `_run_agent_sync` (781–848) binds terminal/profile/session context and invokes `agent.run_conversation` (830). Terminal status and usage are projected, persisted when eligible, and emitted; worker lifetime is counted independently of HTTP handler lifetime by `_submit_api_worker` (49–77), preventing disconnect cancellation from prematurely closing the DB under a still-running thread.

`_handle_run_approval` (1168), `_handle_steer_run` (1219), and `_handle_stop_run` (1253) first load the authenticated owned run. Approval queues are run-scoped; steering calls the live agent's cooperative steer; stop requests interruption instead of assuming cancellation kills an executor thread. `_sweep_orphaned_runs_once` (1284 onward) reconciles expired/live/owner-dead status.

`api_server_run_idempotency.py:RunIdempotencyStore` (53–227) stores `(scope,idempotency_key)` PK, request fingerprint, unique run ID, status JSON, PID plus process start, retention and acknowledgement timestamps in `runs_idempotency.db`. `reserve` (133) uses a lock and `BEGIN IMMEDIATE` transaction to enforce cross-worker reservation. Same key+fingerprint replays, mismatched fingerprint conflicts. Terminal retention is normally 24 hours; room retention can extend it. SQLite open failure degrades to memory with a warning and `durable=false`; that degradation is unsuitable for any future Muse contract promising restart-safe admission.

Events are NOT all durable. `_RunStream` (116–157) holds an in-memory deque of at most 1,000 events and bounded subscriber queues (256 base). `_handle_run_events` (1064 onward) honors `Last-Event-ID` / last_seq within that live backlog. Queue overflow disconnects the subscriber; a write timeout prevents stalled clients blocking work. Restart loses token/tool event history even when run status survives. Do not describe this as a durable replay journal or exactly-once execution.

OpenClaw already has agent start/wait (`agent-run-handler.ts`, `agent-wait.ts`), chat send/abort, sessions steer/resume/control, exec approval request/resolve, lifecycle events, sharing scopes, SQLite dedupe owners and run liveness. `src/infra/agent-events.ts:emitAgentEvent` (571 onward) sequences live per-run events. Gateway protocol `EventFrameSchema` at `packages/gateway-protocol/src/schema/frames.ts:205–211` has event/payload/optional seq/stateVersion. `src/audit/audit-event-store.ts` persists metadata-only audit events, with stable cursor queries; it is deliberately not a full token/tool replay store. A new REST facade should call existing admitted owners, not create another run engine, approval queue or node dispatcher.

Optional future adapter estimate: medium complexity, medium risk, moderate divergence, approximately 10–18 files including schema/routes/client tests. Full durable Muse run/event contract: high complexity, high risk, moderate divergence, approximately 20–35 files, developed as a plugin/application control plane plus narrowly upstreamable owner capabilities. Postpone both beyond the four requested safety phases. No current code change is recommended merely for matching Hermes route spelling.

### Muse-class protocol feasibility

Reuse canonical owners and add resource projections. The current Gateway is a strong foundation but is not yet a single durable, versioned Muse resource protocol.

| Resource | Existing OpenClaw owner/seam | Remaining protocol work |
|---|---|---|
| Agents | `server-methods/agents*.ts`, agent config, harness registry | Stable resource identity, versioning and task scope; no second runtime |
| Tasks | Workboard contract, `src/gateway/server-methods/board.ts`, session dispatch | Durable task/run relation and lifecycle independent of one chat/session |
| Runs | `agent-turn/`, run registry, session state and dedupe | Unified durable status/read/control projection, resumable event contract |
| Plans | Todo/progress and board/session surfaces | Versioned plan steps, dependencies, edits and approval linkage; a displayed todo is not a durable plan resource |
| Goals | `config/sessions/goals*.ts`, `src/gateway/server-methods/sessions-goal.ts`, `src/agents/tools/goal-tools.ts` | Reuse session goals/budgets/status transitions; add task/agent scope only where required |
| Approvals | Exec approval store/manager, skill approval and Workshop | Resource-specific typed decisions, common presentation and hash/action binding |
| Computers | `src/gateway/server-methods/computer.ts`, node/computer plugin contracts | Stable computer lease, capability, authority and activity projections |
| Activity / Events | Agent events, session-state events, audit and activity summaries | Replay cursor, retention, privacy, resync and consumer acknowledgements |
| Memory | Memory provider SDK, search/read, memory-core | Authorized mutation/provenance API, canonical revision projections |
| Skills | Skill runtime/catalog, Workshop, approval runtime | Trust record and staged revision resources |
| Connectors | Plugins, portals, MCP runtime/auth | Normalized integration/install/connection/resource identities |
| Credentials | Secrets and model/MCP credential owners | Write-only references, scope/rotation/revocation and status; never expose raw values |
| Schedules | Cron service and gateway cron handlers | Project jobs/runs/receipts; retain existing scheduler |
| Artifacts | `src/gateway/server-methods/artifacts.ts`, session artifacts, downloads | Immutable IDs/version lineage, producer run and retention/access |

Concrete existing goal evidence: `sessions-goal.ts:handleSessionGoalMutation` (35–178) checks session-sharing permission, lifecycle and physical store identity, plugin ownership and operation fingerprint; it revalidates before mutation. Resume enters admitted chat, not arbitrary status mutation. `goals.ts` accounts token usage; only complete/blocked are model-updatable statuses. This contradicts an assumption that Goals must be invented from scratch.

Architecture: API facade → authenticated resource/method descriptor → existing authority/admission owner → runtime operation → synchronous authorized commit → resource/event projection. A durable journal must be a named storage owner with explicit privacy/retention; audit metadata cannot silently become a transcript recorder. Credential references and trust records must never become authority tokens. Stop acknowledgement, interruption, process exit and confirmed durable side effect are different states.

## 10. Additional Hermes Advantages

1. **Context engines: KEEP_OPENCLAW.** Hermes `agent/context_engine.py:ContextEngine` supplies lifecycle, compress, request-only selection, tool-result pruning and after-turn observation. `select_context` must not mutate durable transcript. OpenClaw `src/context-engine/types.ts` supplies bootstrap/ingest/assemble/compact/after-turn/maintain plus capability requirements, typed successor session, prompt authority and persistent-thread projection epochs. Both already provide plugin seams. No justified replacement.
2. **Retry/failover: KEEP_OPENCLAW; optional UX adaptation only.** Hermes `agent/turn_api_error.py` invokes `turn_recovery_autorecover.py:auto_recover_after_exhaustion` (86–128) after retries and fallback are spent. `ladder_eligible` (71–78) accepts transient overload/server/timeout only and no already-streamed answer; bounded cycles, interruptible waits, and a visible stop hint are useful behavior. OpenClaw `src/agents/embedded-agent-runner/run/assistant-failure.ts:handleEmbeddedAssistantFailure` rejects replay-unsafe attempts; `failover-retry-controller.ts:createEmbeddedRunFailoverRetryController` bounds same-model retries to eight, ordinary outage time to 90s, honors Retry-After floors, caps rotations and honors abort. `packages/retry/src/index.ts` already implements jitter, retry caps and Retry-After-aware delays. Hermes's ladder should not be stacked over this owner: it multiplies retry budgets and checks streamed text rather than proving no committed tool effects. If users need visible countdowns, adapt only the diagnostic presentation through existing onRetry/events, low complexity/low risk/minimal divergence, about 3–5 files; no changed retry policy in the initial plan.
3. **Iteration budgets/subagents: no verified Hermes advantage.** `run_agent.py` has a stale comment saying shared default budgets; actual `tools/delegate_tool.py:282` passes `iteration_budget=None` and `agent/agent_init.py:2439` creates a fresh counter, agreeing with `iteration_budget.py`'s independent-per-agent behavior. Source beats comments. OpenClaw already has goal token budgets, child run registry, spawn-depth/concurrency/authority, durable child status, restart recovery and parent wake/replay. Do not import Hermes iteration defaults or use its shared-budget claim as evidence.
4. **Recovery/checkpointing: KEEP_OPENCLAW for the inspected seams.** OpenClaw `agents/main-session-recovery/` has transcript-backed recovery checkpoints, replay-safety readers, explicit owner leases, admission and settlement; subagent registry has separate SQLite kernel/worker, queued launch recovery, terminal effects and requester wake claims. Hermes has session leases, persistent state and cron attempt recovery; nothing inspected establishes superiority sufficient to replace these owners. Broader provider-specific failure behavior still needs live validation before adding adapters.
5. **Scheduling/background work: KEEP_OPENCLAW.** Hermes `cron/scheduler_provider.py:CronScheduler` has start/stop/job-change/claim/fire and interrupted-attempt recovery; the provider calls the shared job execution path. `claim_fire` (200 onward) durably claims before acknowledgement. OpenClaw cron service already separates timer admission, execution, receipts/finalization, queues and notifications, with interruption and authority tests. Scheduler portability is a useful reference concept, but adding a second scheduler owner would increase divergence without a named requirement.
6. **Tool registration/plugins/observability: KEEP_OPENCLAW.** Hermes `tools/registry.py` and plugin ABCs are useful reference organization, not a missing OpenClaw capability. OpenClaw Gateway method descriptors, public plugin SDK, hooks, provider registries, diagnostic timelines and opted-in audit already exist. No source-backed case was found for copying Hermes's Python registration, model routing, tracing, or plugin loader.

These are scoped static comparisons, not exhaustive proof that no Hermes subsystem anywhere could ever be better. The materially useful additions supported by this audit are scanner rules/content identity, canonical memory sizing, and external run API presentation. All other candidates require an explicit demonstrated gap before porting.

Hermes's optional CJK bigram/trigram/LIKE session fallback is a second narrow advantage worth benchmarking. OpenClaw memory retrieval already supports trigram/CJK query processing; only canonical transcript search is a possible recall gap. See Section 6 and the optional port/test rows. No broad memory-search transplant follows from this.

Optional recovery-wait presentation: low complexity/low risk/minimal divergence, 3-5 files; bounded review-cost/scope hardening only if a real missing selected-runtime budget is established: medium/low/minimal, 4-7 files. Neither changes runtime retry or reviewer owners.

## 11. Recommended Final Architecture

```text
Muse UI / API facade / OpenClaw CLI / channels
    |
    v
Gateway method descriptors + authenticated principal + work admission
    |
    +--> Resource projections: agents/tasks/runs/goals/computers/artifacts
    |      Existing state owners remain authoritative
    |
    v
Agent turn + harness + context engine
    |
    +--> Canonical memory projection [USER <=2K, MEMORY <=4K]
    |      Session-stable, privacy-aware; native carrier capability where needed
    +--> Existing memory recall [SQLite/FTS/embeddings/hybrid/provenance]
    +--> Skill context/resource admission
    |      |
    |      v
    |    Trust Engine: observed immutable revision + verifier + record
    |      safe / caution approval / dangerous quarantine
    |
    v
Tool/action execution
    +--> PERMISSION owner: capabilities / host policies / credential scope
    +--> APPROVAL owner: exact current action / executable / inputs
    +--> CURRENT AUTHORITY: live run, session, placement, owner generation
    |
    +--> Local process / node system.run [existing owners]
    +--> SandboxBackendHandle [Docker/Podman/SSH/OpenShell/vendor plugin]
    +--> WorkerProvider [machine lease/node/whole turn/optional desktop]
    |
    v
Canonical side effect + SQLite publication + existing event projections
    |
    +--> Agent-end / idle review / memory maintenance
           → immutable staged change → diff → validation + trust
           → hash-bound approve/reject [explicit auto policy allowed]
           → existing activation/rollback owner → future-session refresh
```

#### Three independent security questions

| Concern | Question | Owner/output | Cannot substitute for |
|---|---|---|---|
| Trust | Are these exact observed bytes/metadata acceptable under this verifier profile? | Content attestation, coverage, verdict, quarantine | OS/process isolation, permission, action approval, factual truth |
| Permission | Which capabilities/resources can this component access? | Existing tool/host/plugin/node/credential policies | Evidence that the component has not changed |
| Approval | Does this exact current action/revision need human authorization? | Existing action owner or typed caution/activation decision | Trusting every future object revision or command |

Current run/placement/session authority is a fourth necessary condition for effectful use. A previously approved hash or a valid signature does not keep a revoked run alive. Preserve all current execution authority checks.

Trust records identify admitted immutable **revisions**, with a separate object head/current-state pointer. Policy/version/source changes invalidate a reusable verdict even if bytes stay identical. Caution requires a current decision tied to object+full hash+verifier/policy+scope; dangerous remains blocked. User-visible failed/incomplete state is separate from dangerous. An unchanged object continues only when its verified revision and required decision remain current. `publisher` is an observed/verified identity, not an arbitrary frontmatter claim.

Each object adapter defines what can honestly be attested:

| Object | Attested snapshot | Admission boundary | Unresolved external behavior |
|---|---|---|---|
| Skill | SKILL plus all delivered/executed support files, names/modes and source | Install/update, catalog/prompt/read/resource transfer, revision selection | Downloads or commands requested later need independent action policy |
| Plugin/tool package | Manifest, code/package revision and relevant dependency identity | Install/update/load, tool/provider registration | Transitive unpinned runtime downloads cannot inherit package trust |
| MCP server | Endpoint/transport identity, launch package, bounded schema/tool descriptions | Connect/discover/schema publication and reconnect/change | Remote implementation can change without schema change; endpoint hash is not remote-code proof |
| Execution provider | Provider package/revision/config identity, signing provenance where available | Registration/selection and allocation/execution admission | Guest/vendor operation remains governed by permission, credentials and live lease authority |
| Downloaded executable | Full binary digest, signature/publisher facts, optional platform scanner | Before installation/launch; exact executable binding retained | Regex text scans do not verify native binaries |
| Repository | Defined bounded revision/tree scope and runtime-reachable manifest | Project trust/candidate activation/resource admission | Never claim all code or network dependencies were scanned unless coverage proves it |
| Remote integration | Endpoint, descriptors/scopes, connector package and revision | Connection/descriptor refresh | Changing remote behavior is controlled with least capability and per-action checks |
| Canonical memory | Exact prompt-facing projection plus source hashes/provenance | Canonical write proposal and read/injection | A clean heuristic scan does not make a remembered statement true |

Do not hash only SKILL.md while trusting a changing executable support file. Canonical manifests need unambiguous path/length/content/mode boundaries, platform-independent sorting, root identity and explicit symlink/hardlink policy. Ignore files must not exclude runtime-reachable content. Build an immutable snapshot or hold anchored exact-read identity from hashing through use; a file watcher only invalidates, it does not attest. Store sensitive findings redacted, retain necessary private evidence behind existing access rules.

Staging is one skill change-set owner using existing Workshop infrastructure, with typed target adapters for canonical-memory proposals where appropriate. It is not a global interceptor that automatically converts every authorized user file edit into an approval prompt. All *autonomous* active-skill create/update/delete/rename/support changes pass through pending revisions; direct user-requested edits keep their authorization but newly changed content must be reverified before trusted runtime use. Auto changes how an activation decision is made and recorded, never whether a proposal exists or validation runs.

## 12. Exact Port Map

All targets below are OpenClaw-relative; proposed new paths are explicitly marked. Action language distinguishes **adapt/reimplement** from literal copying. Keep existing owners unless a demonstrated missing generic capability requires a narrow SDK addition.

| Priority | Hermes Source | Hermes Symbol | OpenClaw Target | Action | Reason |
|---|---|---|---|---|---|
| P0a | `tools/write_approval.py:46–56` (comparison, not copied) | `write_approval_enabled` | `src/skills/workshop/config.ts`, config help/schema, UI self-learning, Doctor | KEEP_OPENCLAW; patch policy | Propose + pending fallback; no implicit auto, UI enabling must not silently opt in |
| P0b | `tools/skills_guard.py:136–453,618–647` | `THREAT_PATTERNS`, `scan_file` | `src/skills/security/scanner.ts`, `scan-evidence.ts` | ADAPT_HERMES; reimplement rules in TS | Python/shell/Markdown/Unicode coverage with OpenClaw bounded reads and redacted findings |
| P0b | `tools/skills_guard.py:754–796` | `_check_structure` | Existing fs-safe scanner + proposed trust coverage profile | HYBRID | Use structural threat cases, reject unreadable/unsupported/incomplete coverage, keep bounded traversal |
| P0b | `tools/skills_guard.py:724–737` | `should_allow_install` | Existing skill/plugin policy hooks + proposed Trust Engine admission | ADAPT_HERMES policy | All dangerous objects blocked, including explicit force/publisher/auto cases; no builtin exemption |
| P0c | `tools/skills_guard.py:669–721` | `_content_digest`, `scan_skill_cached` | Proposed `src/security/trust/` + canonical SQLite state; existing Library manifests/digests | NEW_LAYER; adapt identity mechanics | Full content/source/verifier-bound attestations; immutable bytes and mandatory reverify |
| P0c | `agent/skill_utils.py:611–644` | `is_quarantined_project_skill`, `iter_project_skill_files` | Skill loading/runtime resources/refresh/harness and remote transfer admission | NEW_LAYER; reimplement gate | Logical quarantine and per-revision use without stale directory-only cache |
| P1 trust extension | `tools/plugin_guard.py:329–364` | `scan_plugin`, `should_allow_plugin_install` | Proposed plugin verifier + existing install/load/provenance owner | HYBRID | Profile-aware plugin scan; keep OpenClaw install hooks/exact registry/security contracts |
| P1 | `tools/write_approval.py:223–242,331+` | `evaluate_gate`, `skill_pending_diff` | Workshop proposal/services/types/schema + experience/cron/skill tool writers | ADAPT_HERMES concept; keep OpenClaw state machine | Common autonomous staging coverage, exact diff, revision-bound activation, delete/rename/consolidation |
| P1 optional cost hardening | `agent/background_review.py` | `_review_input_token_budget`, `_review_tool_whitelist` | Existing detached review budget/tool policy and background work owner | ADAPT_HERMES only if missing selected-runtime budget | Aggregate review-cost control; never copy agent fork or bypass current policy |
| P2 | `tools/memory_tool_store.py:99–108,220–224,276–296` | `MemoryStore.__init__`, `_char_count`, `add` | Common bootstrap builder/budget reporting + memory-core `memory-budget.ts` | ADAPT_HERMES | Distinct tiny canonical caps, combined shared/personal USER, read and write enforcement |
| P2 | `tools/memory_tool.py:307–330`, `memory_tool_store.py:318–334` | `apply_memory_pending`, `_locate` | Existing dreaming plan/commit guards + shared staged canonical adapter | HYBRID | Review against exact preimage/entries; retain OpenClaw atomic publication and indexed archives |
| P2 | `tools/memory_tool_store.py:118–134` | `_consolidation_failure` | Existing memory consolidation outcomes/diagnostics | ADAPT_HERMES small behavior only | Bound repeated saving attempts, visible deferred/pending state; existing fallback retained |
| P0/P2 | `tools/memory_tool_store.py:26–29,136–153` | `_scan_memory_content`, `load_from_disk` | Proposed canonical-memory trust adapter + `bootstrap-files.ts`, promotion validation | HYBRID | Persisted malicious prompt entries excluded while evidence remains inspectable |
| P2b | `agent/system_prompt.py:516–544` (concept) | `_memory_parts` | Existing harness workspace/thread context capability; Codex/AgentsAPI adapters | NEW_LAYER narrow carrier capability | Strict personal canonical profile needs bounded MEMORY carrier where upstream currently uses retrieval-only |
| P3 optional | `tools/environments/daytona.py:24–207` | `DaytonaEnvironment` | Proposed `extensions/daytona/` via public sandbox SDK; optional WorkerProvider | ADAPT_HERMES; reimplement SDK operations | Vendor coverage with exact allocation/cleanup/fs/credential contracts |
| P3 optional | `tools/environments/modal.py:130–280` | `ModalEnvironment`, snapshot methods | Proposed `extensions/modal/` using existing state lifecycle | ADAPT_HERMES | Vendor execution; no Python loop/thread or JSON snapshot store |
| P3 optional | `tools/environments/vercel_sandbox.py:163–418` | `VercelSandboxEnvironment` | Proposed `extensions/vercel-sandbox/` | ADAPT_HERMES | Optional vendor plugin, not core switch branch |
| Later only | Daytona/Modal/Vercel environment files | `cleanup`, restore/readiness/snapshot operations | Existing sandbox/worker capability contracts and provider plugins | HYBRID | Explicit snapshot/stop/resume capability if needed; retain Crabbox checkpoint owner |
| Optional benchmark | `hermes_state_search.py:1191–1218`, `hermes_state_fts.py` | `_search_cjk`, `FTS_CJK_TABLE_SQL` | Existing transcript schema/index/search owner | ADAPT_HERMES after evidence | CJK substring recall; OpenClaw memory trigram already exists, no duplicate search tool |
| Later API facade | `gateway/platforms/api_server_runs.py:234–240,620+` | `_http_routes`, `_handle_runs`, run control handlers | Plugin/API facade over Gateway admitted agent/session/approval owners | ADAPT_HERMES | Coherent external run resource, existing runtime reused |
| Later event protocol | `api_server_runs.py:116–157,1064+` | `_RunStream`, `_handle_run_events` | Proposed durable resource/event projection owner + existing event transport | NEW_LAYER; do not copy journal claim | Hermes in-memory backlog insufficient for durable Muse replay/resume |
| Optional wait UX | `agent/turn_recovery_autorecover.py:80–84` | `ladder_notice` | Existing failover onRetry/diagnostic events | ADAPT_HERMES presentation only | Visible wait/cancel status without increasing retry/replay budgets |
| Regression material only | Hermes guard/approval/provider/memory tests | Adversarial invariant cases | Existing OpenClaw suites for corresponding owners | KEEP_OPENCLAW; adapt fixtures with attribution | Reuse ideas without Python implementation or snapshot-shape tests |

No approval classifier/reviewer, retrieval engine, agent loop, scheduler, plugin loader or session database has a `PORT_HERMES` action. Both supplied LICENSE files are MIT: OpenClaw Foundation copyright 2026 and Nous Research copyright 2025. Preserve applicable copyright/permission notices for copied rules or fixtures, and check vendored-file licenses at the selected pinned revision during implementation. Reimplementation does not justify omitting attribution for copied material.

## 13. OpenClaw Files Likely To Change

#### Trust and skill admission

Existing: `src/skills/security/{scanner,scan-evidence}.ts`; `src/security/audit.deep.runtime.ts`; `src/security/install-policy.ts` only for verifier integration; `src/plugins/install-security-scan.runtime.ts`; `src/skills/lifecycle/{archive-install,source-install,clawhub-install-core,skill-tree-digest}.ts`; `src/skills/loading/{workspace-skill-loader,skill-root-loader}.ts`; `src/skills/runtime/{resources,refresh,session-snapshot}.ts`; `src/skills/library/bundle.ts` and revision/read admission; `src/plugins/loader.ts`, plugin provenance/registration owners; Gateway remote skill transfer and alternate harness skill delivery callers. The local scanner is currently used in deep audit and Workshop, not automatically by every install hook.

Proposed: a narrow `src/security/trust/` owner with types/service, coverage-aware verifier, object snapshot/adapters, store worker/kernel and tests. Authoritative DDL/migration/generated DB types stay in `src/state/` under the existing SQLite worker/writer-broker lifecycle. Trust HTTP/RPC projections belong at existing method owners. Generalized MCP/package/executable/repository adapters should follow measured use cases; do not change every provider loader at once merely because the object enum exists.

#### Safe learning defaults and staging

Defaults/config: `src/skills/workshop/config.ts`, its tests, `src/config/{types.skills,zod-schema.root-shape,schema.help.runtime}.ts`, `ui/src/pages/skill-workshop/self-learning.ts`, UI labels/i18n/e2e fixtures, `src/flows/doctor-core-checks.ts`, `src/commands/doctor-skill-workshop-automations.ts` and actual legacy config migration owner. Weekly job sync: `src/cron/skill-collection-review-monitor.ts` plus tests.

Staging: `src/skills/workshop/{experience-review,experience-review-prompt,maintenance-prompt,service,service-propose,proposal-draft,proposal-bundle,proposal-scan,apply-transition,reconcile-transition,types,store-proposal.kernel,store-transition,collection-backup,collection-restore}.ts`; foreground `src/agents/tools/skill-workshop-tool*.ts`; `src/agents/harness/agent-end-side-effects.ts` only if trigger/reporting must change; cron review dispatch; gateway skill proposal handlers; `packages/gateway-protocol/` skill proposal schemas; UI diff/lifecycle/change-set projection. Existing scheduler stays the owner; do not make a durable background queue just for best-effort learning.

#### Canonical memory budgets, migration and content trust

`src/agents/embedded-agent-helpers/bootstrap.ts`; `bootstrap-budget.ts`, `bootstrap-budget-warning.ts`, `bootstrap-files.ts`, `workspace-personal-bootstrap.ts`, `src/agents/harness/workspace-context.ts`, `realtime-bootstrap-context.ts`; policy config/help/SDK owner if made configurable. Existing embedded/CLI/Copilot/acpx carriers should inherit common enforcement, with changes only where source identity/budgets need propagation. Native canonical-memory support: `extensions/codex/src/app-server/attempt-workspace-context.ts`, `extensions/agentsapi/agentsapi-prompt.ts` and relevant harness capability types/tests; preserve first-request/thread epoch semantics.

`extensions/memory-core/src/{memory-budget,memory-budget-append,dreaming-consolidation,dreaming-consolidation-artifacts,short-term-promotion-apply,short-term-promotion-memory-write,dreaming,cli-index-search.runtime}.ts`; existing Doctor/memory migration modules, source artifact/provenance/index write owners; `extensions/migrate-hermes/memory.ts` only if existing importer needs canonical-admission integration. Keep retrieval `hybrid.ts`, `mmr.ts`, vector/embedding code, schemas/index ownership and session persistence intact except a separately justified CJK search change.

#### Execution plugins and future protocol

Provider plugins: selected `extensions/daytona/`, `extensions/modal/` or equivalent new files (manifest/config/backend/transport/fs/lifecycle/tests). Public `src/plugin-sdk/sandbox.ts` is the seam. A proven SDK-only streaming transport gap may touch `src/agents/sandbox/backend-handle.types.ts`, `src/agents/bash-tools.exec-runtime.ts`, supervisor adapter/contracts and tests. Worker plugins use `src/plugins/capability-provider.types.ts` and `worker-provider-registry.ts`; contract changes are conditional, not assumed.

Provider trust enforcement may touch sandbox/backend selection, worker registration/admission and plugin loader; keep allocation/provision/destroy authority owners. A future protocol should use Gateway method descriptors, `agent-turn/`, `server-methods/{agent,chat,sessions-*,exec-approvals,computer,board,artifacts,cron,memory-*,plugins-*,secrets}.ts`, existing protocol schemas, resource projections and canonical state. That is future scope, not Phase 4 implementation.

The counts in Sections 1, 4–7 describe scope ranges. Listing a module does not mean it must be edited; implementation must prove the smallest actual seam and avoid touching unaffected carriers.

## 14. Hermes Files Worth Studying

| Priority | Files / symbols | Why |
|---|---|---|
| 1 | `tools/skills_guard.py`, `tests/tools/test_skills_guard.py`, `test_skills_guard_agent_config.py` | Broad threat corpus, tri-state policy, full hash/version scan provenance; understand limits and false-positive demotions |
| 2 | `tools/plugin_guard.py`, `tests/tools/test_plugin_guard.py` | Object-specific verifier profiles; plugin code cannot use skill rules blindly |
| 3 | `tools/skills_hub_install.py`, `hermes_cli/skills_hub.py`, `tools/skills_hub.py` | Real acquisition→quarantine→scan→install/update side effects, lock/provenance and force policy |
| 4 | `agent/skill_utils.py`, `tools/skills_tool.py`, `tests/agent/test_project_skills.py` | Trusted project discovery and quarantine; directory-cache flaw is a regression to avoid |
| 5 | `tools/write_approval.py`, `hermes_cli/write_approval_commands.py`, `tools/skill_manager_tool.py`, `skill_manager_guards.py` | Common mutation gate/diff UX, exact replay limits, read-before-write and ownership guards |
| 6 | `agent/background_review.py`, `review_idle_queue.py`, `turn_finalizer.py`, `run_agent.py` | Post-turn review lifetime/cache isolation/tool whitelist/cancellation; reference only, not runtime transplant |
| 7 | `tools/memory_tool_store.py`, `memory_tool.py`, `threat_patterns.py`, `agent/system_prompt.py` | Tiny budgets, strict prompt snapshot filtering, pinned destructive approval and overflow feedback |
| 8 | `agent/memory_provider.py`, `hermes_state_common.py`, `hermes_state_search.py`, `hermes_state_fts.py`, `tools/session_search_tool.py` | Actual persistence/FTS/session navigation/provider checkpoint contracts and CJK recall |
| 9 | `agent/terminal_env_provider.py`, `terminal_env_registry.py`, `tools/terminal_tool_backends.py` | Distinguish plugin ABC from built-in dispatch and avoid assuming one universal registry |
| 10 | `tools/environments/{base,base_output,local,ssh,daytona,modal,vercel_sandbox,file_sync}.py`, terminal lifecycle modules | Vendor APIs/process/file semantics, interruption and snapshot failure cases; avoid host-home coupling |
| 11 | `tools/{approval,approval_detection,approval_smart}.py`, smart/deny/injection tests | Adversarial command scenarios; confirms why OpenClaw implementation should remain |
| 12 | `gateway/platforms/api_server_runs.py`, `api_server_run_idempotency.py`, `api_server_openai_routes.py`, `api_server.py` | External run REST resource, auth/profile ownership, bounded SSE, status durability limitations |
| 13 | `agent/turn_recovery_autorecover.py`, `turn_api_error.py`, `retry_utils.py`, `context_engine.py`, `cron/scheduler_provider.py` | Scoped UX/retry/context/scheduler comparisons; no demonstrated replacement need |

## 15. Things We Must NOT Copy

1. Duplicate Chat Completions/Responses, models, embeddings, session search, cron, Goals, Computers, Artifacts, plugin registration, MCP discovery, context engines, retries or memory provider managers already owned by OpenClaw.
2. Hermes's command approval implementation: simpler reviewer output, pattern-key permanent grants, environment-class guard skips, internal force bypass assumptions and unattended allow paths. **DO NOT PORT HERMES IMPLEMENTATION.** Its malicious-input cases can inform OpenClaw tests.
3. Lexical-only built-in memory in place of embeddings/hybrid/MMR/temporal/provenance; delimiter memory persistence; different session SQLite schema; provider background threads as new durability owners.
4. Default-off write safety, fail-open scanner/gate/config imports, staged-success replies after persistence failure, mutation replay without a full reviewed revision, or direct autonomous active-skill file tools.
5. Short authoritative hashes, directory-only quarantine caches, metadata-only caches as content attestations, unreadable/undecodable/partially scanned content called safe, attacker-controlled ignore coverage, dangerous builtin/source exemptions, or source-name allowlisting as proof of content.
6. Raw skill patterns applied indiscriminately to plugins/providers/executables. Legitimate subprocess/network/API-key handling must have an object-specific profile; generic source findings are facts, not automatically malware verdicts.
7. Mutable bash exports/functions/aliases as an implicit provider contract; broad `.hermes` host-home synchronization; JSON snapshot maps; duck-typed cleanup exceptions as proof destruction happened; unqualified recreation after an uncertain allocation response.
8. Nous managed Modal/tool gateway, Python cloud classes in TypeScript core, Singularity/HPC absent demand, or a universal terminal/worker/harness/computer rewrite.
9. Hermes desktop/TUI/slash/settings/wizard work, product strings/prompt identity, telemetry backends or SaaS memory integrations unrelated to this OpenClaw runtime goal.
10. A bounded injected file that deletes older facts from all durable retrieval sources; rotating backups or rebuildable embedding chunks treated as permanent knowledge storage; memory writes that invalidate stable historical prompts every turn.
11. MCP `full/untrusted` permissions or server `readOnlyHint` as a content-verification guarantee; remote schema hashes advertised as proof of the unseen server implementation.
12. A run SSE deque called a durable event journal, a status reservation called exactly-once side effects, or HTTP cancellation assumed to stop synchronous executor work.

## 16. Implementation Phases

### Safety baseline — small default patch first

Evidence for pulling this forward: absent mode and approval policy currently select auto (`src/skills/workshop/config.ts:26,28`), and UI enabled writes auto. Prepare a focused upstreamable patch switching fallback to propose+pending, UI enable→propose, and migrations preserving explicit off/propose/auto. Disable old implicit weekly auto jobs without deleting history; revalidate in-flight activation authority. This does not require a new scanner or staging database. Completion gate: no configuration omission/default/UI enable flow grants autonomous active-skill writes. Broad staging remains Phase 2.

### Phase 1 — Trust Engine

1. Extend/calibrate the existing scanner with Hermes rule categories and malicious/benign corpus; redact findings and make incomplete coverage explicit.
2. Define object/revision/verifier/policy/coverage records in existing SQLite state, full hashes, source/publisher identity, previous hash and immutable snapshots. Initially skills; then plugin install/load with a distinct profile.
3. Connect acquisition quarantine→verification→install/update activation; preserve ClawHub exact-release blocks, operator install policy, hooks and immutable Library integrity. Dangerous cannot be force-installed; caution requires exact-revision approval.
4. Connect runtime discovery, explicit read, resource delivery, refresh/alternate harness/remote-node admission. Same-process mutation, verifier upgrade and source/publisher change force reverify. Hold exact content identity through effectful use.
5. Keep logical quarantine/evidence and explicit remediation; do not mutate an unrelated user's repository or falsely label failed scans malware.
6. Define MCP/package/executable/provider/repository/remote adapters; implement each only at a concrete lifecycle boundary with honest coverage claims. Generic types alone do not satisfy generalized enforcement.

Completion gate: every supported skill path consumes admitted immutable content; changed dangerous bytes cannot enter prompt/resources/install/exec via a stale decision. Broad object enforcement is incremental and reported as such.

### Phase 2 — Safe Self-Learning

1. Finish any default/help/Doctor/UI migration work from the baseline; off means no autonomous mutation/review, propose is default, auto is explicit activation opt-in.
2. Route experience review, foreground repair, weekly maintenance, support writes/deletes, retirement/rename/consolidation through Workshop proposals/change sets. Remove direct active-store file/exec capability from autonomous reviewers; synthesis/validation operates in isolated candidates.
3. Extend operation manifests for all collection mutations; record exact preimages, full diffs, evaluator/security result, source evidence, decision and outcome in existing SQLite state.
4. Propose and auto share generated→pending→diff→validate→decision→activate; auto never bypasses trust/evaluators/CAS/rollback.
5. Resolve the existing propose-mode sandbox-source skip with a host-owned proposal capability or a visible non-outcome; never fall back to auto.
6. Preserve rejection feedback, caps/dedup, model/context budgets, idle queue and no-learning-recursion safeguards. Best-effort review queues may remain process-local; activation decisions and proposals must be durable.

Completion gate: every autonomous skill mutation has a staged revision and validation trail, and a revoked or changed proposal cannot activate. Current active skills and pending records remain compatible across upgrade.

### Phase 3 — Bounded Canonical Memory

1. Resolve a single per-kind budget policy using existing UTF-16 semantics: combined USER approximately 2K, MEMORY approximately 4K; account projection notices/wrappers deliberately and keep aggregate bootstrap caps.
2. Apply at both read/injection and canonical writers, including external/manual changes, overlays, aliases, realtime extras and remote carriers. Preserve privacy/group/subagent/lightweight exclusions and prompt stability.
3. Tighten existing promotion/consolidation budgets rather than replacing retrieval. Before canonical eviction/rewrite, save displaced facts to a durable indexed artifact with provenance, not only an eight-entry rotating backup or rebuildable chunk table.
4. Stage destructive canonical consolidation against exact preimages; reject/approve/explicit auto policy, then existing atomic commit and origin/index publication. Read projection remains bounded even if the original source is oversized or proposal rejected.
5. Add declared bounded-memory carrier support to native Codex/AgentsAPI for the personal Muse profile if the requested always-injected canonical MEMORY invariant is selected. A cap-only patch preserving retrieval-only routing does **not** fully meet that invariant. Use existing first-request/thread-context epoch transport, not raw repeated append or hidden harness rewrites.
6. Keep SQLite/FTS/embeddings/vector/hybrid/BM25/recency/importance/MMR and cross-session visibility unchanged. Retrieval storage has no canonical-memory size quota; explicit retention/forget/privacy still apply.

Completion gate: eligible personal sessions cannot receive over-budget canonical content from any supported carrier, while displaced knowledge remains retrievable after restart/reindex and intentional forget removes it. Unsupported/filtered contexts remain explicitly outside the canonical injection contract.

### Phase 4 — Execution Provider evolution

The source justifies changing the scope, not the order: **retain existing interfaces and wrap/adapt only missing transports**, rather than introducing competing registry/lifecycle owners.

1. Contract/conformance inventory of local/node/sandbox/worker/computer paths. Public product selection may use a descriptor/facade pointing at these existing owners.
2. Select one real cloud vendor and begin with a SandboxBackend plugin, preferably reusing SSH/remote-shell/fs invariants if supported. Validate live allocation/abort/output/stdin/path/cleanup behavior before broadening.
3. Add WorkerProvider only if whole-agent placement/node/desktop/durable leases are needed. Preserve idempotent operation IDs, pinned host keys, SecretRefs, placement authority, reconciliation and teardown proof.
4. Extend transport/checkpoint capabilities only when one implementation proves the current contract insufficient. Distinguish filesystems from processes and pause from destruction.
5. Add more optional plugins (E2B/Daytona/Modal/Fly/VPS) from the same contracts. Do not promise they already exist. No giant core vendor switch or big-bang migration.

Completion gate: existing Docker/Podman/SSH/OpenShell/node/local behavior remains supported, a selected new provider passes conformance/live tests, and lifecycle state has one authoritative owner. Universal unification remains rejected: VERY HIGH complexity/high risk/severe divergence, 60–100+ files.

### Later, separately scoped

Muse resource/event API, persistent Tasks/Plans/run projections, connector and credential resource identities, a durable resumable event journal, optional multilingual transcript recall, checkpoint capability and review-wait UX. They are architectural notes or evidence-gated improvements, not reasons to delay the four safety phases.

## 17. Tests Required

### Trust and self-learning: existing tests and required proof
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

### Memory: existing tests and required proof
**Budget unit/regression:** per-kind defaults, lower explicit caps, all sharing-agent minimum, surrogate pairs/CJK, empty/tiny cap, marker overhead, total bootstrap interaction, shared+personal USER aggregate, whole personal omission, duplicate sources, hook rename/alias and path remapping. Existing `embedded-agent-helpers.buildbootstrapcontextfiles.test.ts` (USER test 84–100), `bootstrap-budget.test.ts` (fixed USER accounting 213+), `bootstrap-files.personal.test.ts`, `realtime-bootstrap-context.test.ts`, `memory-budget.test.ts` (human mixed blocks, order, loss bound, overhead), `dreaming-consolidation.test.ts`, `short-term-promotion.test.ts` provide relevant contracts.

**End-to-end carriers:** embedded/remote worker, CLI first/live prompts, Copilot, ACP first/resume, native Codex persona plus tool-routed memory, AgentsAPI snapshots, realtime explicit extra files, custom context engine and compaction; prove no duplicate canonical payload and no lost instruction/visibility. Cap-only regression preserves tool-routed native memory; a separate personal canonical-profile test must prove the new bounded native carrier. Never paste the unbounded source file into it.

**Security:** malicious manual memory, injection/exfil/secret/invisible-character patterns, scanner fail/error with operator remedy, raw evidence remains viewable but not model-injected, stale source hash after scan, external editor change immediately before activation, symlink and remote source identity, system/untrusted origin exclusion, mixed agent/manual lineage, group/subagent and cross-profile isolation. Hermes `tests/tools/test_memory_tool.py` covers strict write/load scans, drift, lock symlinks, unreadable file refusal, pinned approval replay and background staging (notably 394 overlimit, 413 frozen snapshot, 736 poisoned snapshot, 898+ review gate). Do not adopt its overlimit injection expectation.

**Migration/consolidation:** lossless indexed archive before canonical change, archive failure leaves canonical untouched, proposal rejection, entry changed while pending, crash/uncertain publication reconciliation, preimage rotation does not destroy retrieval record, retrieval found after canonical eviction/reindex/restart, explicit forget erases archive/provenance too, import preserves source. Existing OpenClaw `memory-workspace-lock.cas.test.ts`, `short-term-promotion-memory-write.test.ts`, publication/settlement tests, `memory-forget-consolidation.test.ts`, `memory-forget-recovery.test.ts`, `tools.chunking-upgrade.test.ts` are conceptually reusable.

**Retrieval preservation:** lexical-only offline, embedding failure/fallback, hybrid ranking, importance, project ranking, MMR, recency and evergreen no-decay; unchanged source/index identity must yield comparable results after budget feature. Keep existing focused hybrid/mmr/temporal/provenance/session-visibility tests. Hermes `tests/tools/test_session_search.py` tests bounded discovery/scroll/read, compression lineage recovery, stale/live suppression and profile-local IDs; useful behavior ideas but OpenClaw already has equivalent split tools.

**Optional multilingual transcript work:** benchmark native sessions_search for 1–2 character CJK and mixed-script terms, compare current memory-core trigram behavior first; validate backend capability fallback, query escaping, corruption/rebuild, cold archives and privacy. Hermes's native cjk_unicode61 extension is an implementation reference; do not require its Unix .so path on OpenClaw's Windows-capable runtime.

### Execution and approvals: existing tests and required proof
OpenClaw useful existing tests:

* `src/agents/sandbox/backend.test.ts:28–75` reserves runtime authority before factory invocation; registration generations, Podman and resource capability tests.
* `src/agents/sandbox/context.state-owner.test.ts`, `context.managed-custody.test.ts`, `runtime-reservation.test.ts`, `registry-authority.test.ts`, `local-workspace-quiescence.test.ts`: owner/lifecycle correctness.
* `src/agents/sandbox/docker.partial-create-cleanup.test.ts`, `docker.config-hash-recreate.test.ts`, `podman-upgrade.test.ts`: failed creation, config drift and upgrades.
* `src/agents/sandbox/ssh-backend.test.ts`, `ssh.stream-errors.test.ts`, `ssh.spawn-env.test.ts`, `remote-shell-backend.test.ts`: transport/workdir/env/failure contracts.
* `src/agents/sandbox/remote-fs-bridge.parent-alias.test.ts`, `.path-bytes.test.ts`, `fs-bridge.anchored-ops.test.ts`, `validate-sandbox-security.test.ts`: hostile paths and filesystem mutation boundaries.
* `src/plugins/worker-provider-registry.test.ts`, `worker-provider-maintenance.test.ts`, `src/gateway/worker-environments/provider-provisioning.replay.test.ts`, `provider-provisioning.cancellation.test.ts`, `provider-owner-revocation.test.ts`, `provider-reconciliation.test.ts`, `worker-turn-launcher-failure-recovery.test.ts`, `computer-transport.takeover.test.ts`: provider validation, recovery and identity takeover.
* `src/agents/exec-auto-reviewer.test.ts:98–1045`: malformed/duplicate outputs, consistent risk, directive injection, timeouts, cancellation and one-shot concurrent approvals; `src/agents/exec-auto-reviewer.resources.test.ts` and `src/agents/exec-auto-review.stress.test.ts` cover retained resources.
* `src/agents/bash-tools.exec.security-floor.test.ts:112–660`, `exec-host-gateway` tests, `node-host/invoke-system-run*`, `infra/system-run-approval-binding*`: model override resistance, host-local floors, command/script/executable/cwd drift.

Hermes useful conceptual tests:

* `tests/agent/test_terminal_env_registry.py:56–200`: scoped registration, reserved names, raising classifications and credential key union.
* `tests/tools/test_daytona_environment.py:119–299`: persistent lookup/start, cleanup stop, interrupt stop/restart, resource conversion, SDK failure and quoted uploads.
* `test_modal_sandbox_fixes.py`, `test_modal_snapshot_isolation.py`, `test_vercel_sandbox_environment.py`: snapshot namespace/restore/fallback/SDK lifecycle.
* `test_ssh_environment.py`, `test_ssh_remote_cwd.py`, `test_ssh_bulk_upload.py`, `test_build_subprocess_env.py`, `test_hermes_subprocess_env.py`: quoting/path/environment exposure across backends.
* `test_smart_approval_injection.py`, `test_smart_approval_policy.py`, `test_approval_deny_rules.py`, `test_approval_mode_parity.py`: reviewer prompt boundary and operator floors.

Required future tests: one shared conformance suite per backend for byte-exact stdin/output, invalid UTF-8 filenames, cwd/workdir roots, credentials excluded from argv/logs/guest env, abort before allocation/during SDK/after dispatch, detached termination after run authority expires, bounded output, partial allocation cleanup, lost provision response/idempotent replay, config/publisher/hash change requiring reapproval/reverification, stale plugin generation, symlink/parent-alias swaps, resource/property failures, provider disappearance and visible result. Snapshot tests must show file restoration and explicitly show which processes cannot survive; retention/eviction must not discard paid live resources on indeterminate teardown. Migration tests must reopen old/new SQLite state, preserve existing Docker/Podman/SSH/OpenShell configuration and reject incompatible worker dialects rather than silently downgrade.

### Cross-feature release gates

— cross-feature release gates

Sections 4–9 identify the existing suites and feature-specific tests. Preserve their actual entry-point boundaries; copying a test name or static assertion is not behavioral proof. Future implementation should run targeted OpenClaw suites through package-defined tooling and Hermes conceptual references through its prescribed runner if comparing behavior; this audit executed neither.

| Change | Unit / property | Integration / regression | Security / malicious input | Upgrade / migration |
|---|---|---|---|---|
| Scanner profiles | Verdict aggregation, profile calibration, exact coverage, limits/redaction | Archive/source/registry/Workshop actual gates and benign fixtures | Python/shell/prose injection, secret exfil, Unicode, forged owner, symlink/hardlink, ignore abuse, unreadable/invalid UTF-8 | Rule/verifier/policy bump invalidates old attestation; old scans never become clean by omission |
| Trust lifecycle | Manifest identities, hashes/modes/names/source, status≠verdict, approval binding | Discovery/read/resource/refresh/CLI/native/remote-node and install/update use exact admitted bytes | Swap after hash/scan/approval, same-process clean→dangerous without cache reset, force/auto/permission cannot bypass dangerous, malicious cache/provenance | Old active skill migration, unavailable verifier, SQLite failure/reopen, changed publisher, quarantine recovery, downgrade tolerance |
| Propose default | Empty/invalid/explicit enum/policy resolution | UI enable, foreground patch, experience review, sandbox skip outcome, weekly job sync | Model lifecycle apply cannot exploit implicit approval auto; revocation before effect | Missing means propose, explicit auto/off retained, old job history retained, pending proposals unchanged |
| Common skill staging | Change-set operation validation, dedup/caps/diff, used-skill receipt | Every autonomous source/create/update/delete/rename/support/consolidation produces pending trail | Forged paths/revisions, literal secrets, evaluator failure, direct exec/write denied, source authority drift | Multi-file CAS failure/rollback, crash after fs effect before DB commit, reconciliation, old proposals/protocol |
| Canonical memory | UTF-16-safe quotas, combined overlays, markers/aliases, whole personal directives | All carriers, session-stable prompt hashes, oversized external files, retrieval preserved | Poisoned entries, provenance/session privacy, shell/manual edit bypass at injection, stale reviewed entry | Archive before eviction, failed archive leaves source, rejection, restart/reindex retrieval, explicit forget, native capability migration |
| Vendor adapters | Contract/capability config and SDK result mapping | Byte-exact stdin/stdout, PTY/process semantics, fs bridge, node/whole-turn reuse | Credential leakage, hostile cwd/filenames, symlink races, stale lease/registration authority, transport injection | Lost allocation reply/replay, partial create/cancel, indeterminate destroy, plugin replacement, config drift, pinned identity |
| Optional run facade | Status/control/schema and cursor validation | HTTP facade uses same runtime/dedupe/approval owners; detach/reconnect/steer/stop | Cross-profile/run access, approval theft, slow subscribers, redaction and untrusted input | Restart status vs event replay, durable admission fail-closed contract, gap/resync, retention/privacy migrations |

Cross-feature proof must include a generated benign skill entering pending by default, approval of its exact diff, activation/refresh, content mutation to a dangerous support script, mandatory reverification and quarantine before any use. Repeat through a remote worker and an alternate harness. Then revoke authority during awaited verification/approval and prove no side effect occurs. This composition is the decisive safety test, not only isolated scanner/state-machine tests.

For native canonical memory, verify bounded prepared context across first request, persistent thread reuse, explicit refresh, compaction/epoch rotation and resume, without duplicate memory or old private USER content. For provider snapshots, demonstrate which files survive and which processes do not; no “hibernation” claim without process-preservation proof.

Static audit limitations: no Git revisions/history, no dependency execution, no live vendor/API/OS probes, no measured recall/performance benchmarks, and no passing-suite claim. Source and existing tests establish contracts; implementation needs the tests above and live validation of any external API/transport added. The generalized all-object Trust Engine and full Muse protocol are proposed designs, not capabilities claimed to exist today.

## 18. Final Recommendation

1. **What I would implement first:** the focused `propose + pending` fallback/UI/migration safety patch, then broader scanner profiles and full content-bound skill trust admission on existing install/Library/runtime seams. Actual default direct writes justify making the small safety patch first; it does not warrant postponing Trust Engine work.
2. **What I would never port from Hermes:** its approval runtime/reviewer, agent loop, session schema/store, lexical retrieval as a replacement, Python plugin loader, terminal globals/JSON snapshot persistence, optional fail-open write gate, stale directory quarantine cache, or Hermes UI/home/Nous-managed gateway coupling.
3. **Highest-value Hermes subsystem:** the skills/plugin threat scanner corpus and version/content attestation concept. The value is multi-language/instructional security coverage and lifecycle discipline, not proof the existing Hermes skill security is universally stronger.
4. **Highest-risk port:** a universal execution-provider rewrite would be VERY HIGH/high/severe and is unnecessary. Among recommended work, complete mutable-object trust consumption across every harness/remote/resource path is the hardest security integration; broad autonomous collection change sets are next.
5. **Largest upstream maintenance burden:** replacing exec/node/process/worker authority owners, introducing a second event/run engine, duplicating SQLite storage, or altering native harness prompt semantics everywhere. Avoid the first three; keep bounded native-memory support additive and explicitly capability/profile scoped.
6. **What remains missing for a Muse-class personal agent:** a coherent durable versioned resource protocol for Tasks/Runs/Plans across sessions, complete object-type trust adapters, replayable scoped events with gap/resync/retention, unified activity/artifact/connector/credential projections, and user-facing cross-resource lifecycle. Goals, Computers, Schedules, Memory, Skills and many underlying owners already exist; expose/compose them instead of rebuilding. Exactly-once arbitrary external side effects are not promised by either runtime.
7. **Fork, plugin, adapter or upstream patches:** maintain a thin product/fork integration layer only where needed. Use upstreamable safety/default/scanner/SDK patches, provider plugins for vendors, and an adapter/application protocol layer over Gateway owners. This audit does not justify a giant permanent architecture fork or importing Hermes as a second runtime. Upstream compatibility cannot be measured against history without a pinned Git base, so treat divergence ratings as design estimates.
8. **Best upstream candidates:** propose/pending defaults and explicit-auto UI semantics; bounded USER/MEMORY budget/reporting consistency; widened calibrated scanner coverage and fail-closed incomplete results; generic content-verification/admission hooks; immutable revision/hash-bound caution decisions; common Workshop mutation/change-set coverage and validation/rollback fixes; narrowly proven SDK transport/capability enhancements. Product-specific Muse schema/UI, connector naming and vendor adapters can remain plugins/facades. A universal dangerous verdict policy needs explicit upstream product agreement; do not sneak broad lockout changes in as a scanner cleanup.

Acceptance of this report authorizes no code changes by itself. Implementation should begin as a separately requested phase with a pinned source identity and the concrete scope/tests above.

### Snapshot fingerprints

Git revisions are unavailable. These full SHA-256 values identify selected audited source files; they do not certify the entire trees or establish upstream ancestry.

| File | SHA-256 |
|---|---|
| `openclaw/package.json` | `0c362f53b615aa98a201189e0c9b808505414b130a2a3d707b17891180522089` |
| `openclaw/src/skills/workshop/config.ts` | `ede38d5ef79fbce7bc4b3da4296790495eb03ec21e15aa391128a071f9dbb441` |
| `openclaw/src/agents/sandbox/backend-handle.types.ts` | `cdbea7bc80c83d12f4d2bc5092e802c89e083d2b719f23726b1389a225b62c26` |
| `hermes-agent/pyproject.toml` | `3386548996f0b045147b2607aca3adff811997881a245430eeded04593835725` |
| `hermes-agent/tools/skills_guard.py` | `0c33d15095cff5f980d02e4f1bf056bf43f39789600604c885c673fb68d9cbb3` |
| `hermes-agent/agent/background_review.py` | `5f6c503f54e87d3fbeb637fbd583371e1eee4c64b72a48b87755f2199360dc86` |
