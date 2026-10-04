## Recommended architecture

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

### Three independent security questions

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

## Exact port map

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

No approval classifier/reviewer, retrieval engine, agent loop, scheduler, plugin loader or session database has a `PORT_HERMES` action. Review third-party licensing/attribution before copying any rule text or fixture literally; both projects' LICENSE files should be checked at the chosen pinned source revision during implementation. Reimplementation does not justify omitting attribution for copied material.

## OpenClaw modules likely to change

### Trust and skill admission

Existing: `src/skills/security/{scanner,scan-evidence}.ts`; `src/security/audit.deep.runtime.ts`; `src/security/install-policy.ts` only for verifier integration; `src/plugins/install-security-scan.runtime.ts`; `src/skills/lifecycle/{archive-install,source-install,clawhub-install-core,skill-tree-digest}.ts`; `src/skills/loading/{workspace-skill-loader,skill-root-loader}.ts`; `src/skills/runtime/{resources,refresh,session-snapshot}.ts`; `src/skills/library/bundle.ts` and revision/read admission; `src/plugins/loader.ts`, plugin provenance/registration owners; Gateway remote skill transfer and alternate harness skill delivery callers. The local scanner is currently used in deep audit and Workshop, not automatically by every install hook.

Proposed: a narrow `src/security/trust/` owner with types/service, coverage-aware verifier, object snapshot/adapters, store worker/kernel and tests. Authoritative DDL/migration/generated DB types stay in `src/state/` under the existing SQLite worker/writer-broker lifecycle. Trust HTTP/RPC projections belong at existing method owners. Generalized MCP/package/executable/repository adapters should follow measured use cases; do not change every provider loader at once merely because the object enum exists.

### Safe learning defaults and staging

Defaults/config: `src/skills/workshop/config.ts`, its tests, `src/config/{types.skills,zod-schema.root-shape,schema.help.runtime}.ts`, `ui/src/pages/skill-workshop/self-learning.ts`, UI labels/i18n/e2e fixtures, `src/flows/doctor-core-checks.ts`, `src/commands/doctor-skill-workshop-automations.ts` and actual legacy config migration owner. Weekly job sync: `src/cron/skill-collection-review-monitor.ts` plus tests.

Staging: `src/skills/workshop/{experience-review,experience-review-prompt,maintenance-prompt,service,service-propose,proposal-draft,proposal-bundle,proposal-scan,apply-transition,reconcile-transition,types,store-proposal.kernel,store-transition,collection-backup,collection-restore}.ts`; foreground `src/agents/tools/skill-workshop-tool*.ts`; `src/agents/harness/agent-end-side-effects.ts` only if trigger/reporting must change; cron review dispatch; gateway skill proposal handlers; `packages/gateway-protocol/` skill proposal schemas; UI diff/lifecycle/change-set projection. Existing scheduler stays the owner; do not make a durable background queue just for best-effort learning.

### Canonical memory budgets, migration and content trust

`src/agents/embedded-agent-helpers/bootstrap.ts`; `bootstrap-budget.ts`, `bootstrap-budget-warning.ts`, `bootstrap-files.ts`, `workspace-personal-bootstrap.ts`, `harness/workspace-context.ts`, `realtime-bootstrap-context.ts`; policy config/help/SDK owner if made configurable. Existing embedded/CLI/Copilot/acpx carriers should inherit common enforcement, with changes only where source identity/budgets need propagation. Native canonical-memory support: `extensions/codex/src/app-server/attempt-workspace-context.ts`, `extensions/agentsapi/agentsapi-prompt.ts` and relevant harness capability types/tests; preserve first-request/thread epoch semantics.

`extensions/memory-core/src/{memory-budget,memory-budget-append,dreaming-consolidation,dreaming-consolidation-artifacts,short-term-promotion-apply,short-term-promotion-memory-write,dreaming,cli-index-search.runtime}.ts`; existing Doctor/memory migration modules, source artifact/provenance/index write owners; `extensions/migrate-hermes/memory.ts` only if existing importer needs canonical-admission integration. Keep retrieval `hybrid.ts`, `mmr.ts`, vector/embedding code, schemas/index ownership and session persistence intact except a separately justified CJK search change.

### Execution plugins and future protocol

Provider plugins: selected `extensions/daytona/`, `extensions/modal/` or equivalent new files (manifest/config/backend/transport/fs/lifecycle/tests). Public `src/plugin-sdk/sandbox.ts` is the seam. A proven SDK-only streaming transport gap may touch `src/agents/sandbox/backend-handle.types.ts`, `src/agents/bash-tools.exec-runtime.ts`, supervisor adapter/contracts and tests. Worker plugins use `src/plugins/capability-provider.types.ts` and `worker-provider-registry.ts`; contract changes are conditional, not assumed.

Provider trust enforcement may touch sandbox/backend selection, worker registration/admission and plugin loader; keep allocation/provision/destroy authority owners. A future protocol should use Gateway method descriptors, `agent-turn/`, `server-methods/{agent,chat,sessions-*,exec-approvals,computer,board,artifacts,cron,memory-*,plugins-*,secrets}.ts`, existing protocol schemas, resource projections and canonical state. That is future scope, not Phase 4 implementation.

The counts in Sections 1, 4–7 describe scope ranges. Listing a module does not mean it must be edited; implementation must prove the smallest actual seam and avoid touching unaffected carriers.

## Hermes files worth studying

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

## Things we must not copy

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

## Implementation phases

### Safety baseline — small default patch first

Evidence for pulling this forward: absent mode and approval policy currently select auto (`workshop/config.ts:26,28`), and UI enabled writes auto. Prepare a focused upstreamable patch switching fallback to propose+pending, UI enable→propose, and migrations preserving explicit off/propose/auto. Disable old implicit weekly auto jobs without deleting history; revalidate in-flight activation authority. This does not require a new scanner or staging database. Completion gate: no configuration omission/default/UI enable flow grants autonomous active-skill writes. Broad staging remains Phase 2.

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

## Tests required — cross-feature release gates

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

## Final recommendation

1. **What I would implement first:** the focused `propose + pending` fallback/UI/migration safety patch, then broader scanner profiles and full content-bound skill trust admission on existing install/Library/runtime seams. Actual default direct writes justify making the small safety patch first; it does not warrant postponing Trust Engine work.
2. **What I would never port from Hermes:** its approval runtime/reviewer, agent loop, session schema/store, lexical retrieval as a replacement, Python plugin loader, terminal globals/JSON snapshot persistence, optional fail-open write gate, stale directory quarantine cache, or Hermes UI/home/Nous-managed gateway coupling.
3. **Highest-value Hermes subsystem:** the skills/plugin threat scanner corpus and version/content attestation concept. The value is multi-language/instructional security coverage and lifecycle discipline, not proof the existing Hermes skill security is universally stronger.
4. **Highest-risk port:** a universal execution-provider rewrite would be VERY HIGH/high/severe and is unnecessary. Among recommended work, complete mutable-object trust consumption across every harness/remote/resource path is the hardest security integration; broad autonomous collection change sets are next.
5. **Largest upstream maintenance burden:** replacing exec/node/process/worker authority owners, introducing a second event/run engine, duplicating SQLite storage, or altering native harness prompt semantics everywhere. Avoid the first three; keep bounded native-memory support additive and explicitly capability/profile scoped.
6. **What remains missing for a Muse-class personal agent:** a coherent durable versioned resource protocol for Tasks/Runs/Plans across sessions, complete object-type trust adapters, replayable scoped events with gap/resync/retention, unified activity/artifact/connector/credential projections, and user-facing cross-resource lifecycle. Goals, Computers, Schedules, Memory, Skills and many underlying owners already exist; expose/compose them instead of rebuilding. Exactly-once arbitrary external side effects are not promised by either runtime.
7. **Fork, plugin, adapter or upstream patches:** maintain a thin product/fork integration layer only where needed. Use upstreamable safety/default/scanner/SDK patches, provider plugins for vendors, and an adapter/application protocol layer over Gateway owners. This audit does not justify a giant permanent architecture fork or importing Hermes as a second runtime. Upstream compatibility cannot be measured against history without a pinned Git base, so treat divergence ratings as design estimates.
8. **Best upstream candidates:** propose/pending defaults and explicit-auto UI semantics; bounded USER/MEMORY budget/reporting consistency; widened calibrated scanner coverage and fail-closed incomplete results; generic content-verification/admission hooks; immutable revision/hash-bound caution decisions; common Workshop mutation/change-set coverage and validation/rollback fixes; narrowly proven SDK transport/capability enhancements. Product-specific Muse schema/UI, connector naming and vendor adapters can remain plugins/facades. A universal dangerous verdict policy needs explicit upstream product agreement; do not sneak broad lockout changes in as a scanner cleanup.

Acceptance of this report authorizes no code changes by itself. Implementation should begin as a separately requested phase with a pinned source identity and the concrete scope/tests above.
