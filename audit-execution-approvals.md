# Supporting source audit: execution environments and command approvals

This is a read-only source investigation of the supplied `hermes-agent/` and `openclaw/` trees. No project source, dependencies, formatting or commits were changed. Tests below were inspected, not executed. Paths in this document are relative to the named repository; line intervals refer to this checkout.

## Findings to carry into the main report

1. **KEEP_OPENCLAW: OpenClaw already has execution backend abstractions.** `src/agents/sandbox/backend.types.ts` defines factories, management, workdir resolution, static capabilities and reserved runtime creation. `backend-handle.types.ts` defines execution, shell operations, filesystem bridge, finalization and termination custody. `backend.ts:81–114,171–271,273–299` registers, creates and selects Docker, Podman, SSH or plugin implementations. `extensions/openshell/index.ts:15–44` registers a real OpenShell adapter. Creating another competing registry called `ExecutionProvider` would duplicate these owners.
2. **KEEP_OPENCLAW: whole-agent worker provisioning is already separately abstracted.** `src/plugins/capability-provider.types.ts:277–434` defines `WorkerProvider`; `src/plugins/worker-provider-registry.ts:10–65` validates required lifecycle methods, supported execution modes and manifest ownership. `extensions/crabbox/index.ts:87` registers a production provider. It is not the terminal sandbox contract: workers allocate machines and can host entire turns, node runtimes and desktops.
3. **DO NOT PORT HERMES APPROVAL IMPLEMENTATION.** OpenClaw has stronger command analysis, host-policy intersection, one-shot reviewer decisions, executable/script/cwd/env binding, cancellation and live authority checks. Hermes' auxiliary reviewer is a simpler APPROVE/DENY/ESCALATE classification. Its regex classifier is valuable test material, not a replacement for OpenClaw authorization.
4. **ADAPT_HERMES, optionally: cloud vendor adapters.** Hermes has concrete Modal, Daytona and Vercel execution integrations absent from the inspected OpenClaw production provider set. Reimplement selected vendor operations in TypeScript plugins behind existing contracts. Do not copy Python inheritance, host-home synchronization or mutable bash snapshots.
5. **HYBRID, postponed: explicit provider suspension/snapshot capability.** Hermes Daytona stops/resumes persistent sandboxes; Modal/Vercel snapshot filesystems at cleanup. OpenClaw already has Crabbox checkpoints/warm images. There is no demonstrated need for a universal hibernation manager now; a future capability must distinguish filesystem restore from process continuation and persist provider state through existing SQLite owners.

| Compared subsystem | Winner | Verdict | Complexity of recommended action | Risk | Upstream divergence | Approximate OpenClaw files |
|---|---|---|---|---|---|---|
| Terminal execution contract/registry | OpenClaw | KEEP_OPENCLAW | None | Low | Minimal | 0 |
| Docker/Podman and SSH runtime adapters | OpenClaw | KEEP_OPENCLAW | None | Low | Minimal | 0 |
| OpenShell extension seam | OpenClaw | KEEP_OPENCLAW | None | Low | Minimal | 0 |
| Whole-agent worker machine lifecycle | OpenClaw | KEEP_OPENCLAW | None | Low | Minimal | 0 |
| Modal/Daytona/Vercel vendor coverage | Hermes | ADAPT_HERMES | Medium per selected terminal vendor; high for full worker/node support | Medium | Minimal plugin-only; moderate if lifecycle contract must expand | 6–14 per terminal plugin; 12–25 per worker plugin |
| Cross-vendor filesystem checkpoints | Mixed | HYBRID | Medium–high, only after concrete vendor demand | High | Moderate | 12–25 |
| Universal terminal+worker+computer+harness unification | Neither; unnecessary | IGNORE for current scope | VERY HIGH if insisted upon | High | Severe | Roughly 60–100+, including tests and protocol callers |
| Exec permissions/approvals/reviewer | OpenClaw | KEEP_OPENCLAW | None | Low | Minimal | 0 |
| Regex catastrophic command floor | Hermes has an explicit floor; different product policy | KEEP_OPENCLAW; reuse adversarial scenarios only | Low test additions when touching approval code | Low | Minimal | 2–5 tests; no implementation port |

## Hermes: exact execution contracts and flow

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

### Concrete Hermes backends

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

## OpenClaw: owners, adapters and side effects

Keep four concepts distinct:

* **Terminal backend:** `SandboxBackendHandle` runs a command and serves filesystem operations in a selected runtime.
* **Whole-agent worker provider:** `WorkerProvider` allocates/adopts, bootstraps, inspects and destroys a machine/lease. It may run entire turns (`worker-turn`) or provide a remote executor (`remote-exec`).
* **Agent harness/model runtime:** `src/agents/harness/types.ts:465–648 AgentHarnessContract/AgentHarnessV2` owns runAttempt, native tools/compaction/session lifecycle and model transport. `harness/execution-environment.ts:187 assertAgentHarnessExecutionEnvironment()` validates runtime restrictions. It is not a shell provider.
* **Computer transport:** `src/gateway/worker-environments/computer-transport.ts:28,240–266` forwards `screen.snapshot` and `computer.act` under worker/connection ownership. A desktop capability is optional on `WorkerLease`, not mandatory for shell execution.

### Terminal backend contract

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

`ssh.ts:70–120` materializes identity/certificate/known-hosts with strict permissions and avoids argv/env secret values. Host-key behavior is operator configured, with `StrictHostKeyChecking yes/no`; do not claim all standalone sandbox SSH is pinned by default. Whole-agent workers have a stronger mandatory endpoint contract: `capability-provider.types.ts:72–100` has hostKey and SecretRef, and `gateway/worker-environments/ssh.ts:149` rejects missing pinnedHostKey. This differs from Hermes accept-new semantics.

`validate-sandbox-security.ts:23–143` blocks sensitive host mounts including system roots, Docker socket paths and credential directories, canonicalizes ancestor aliases and catches parent mounts exposing protected descendants. `sanitize-env-vars.ts:14–86` filters known provider credential names, suspicious names/values, NUL and oversized values. Existing explicit environment policies and secret-owner lifetimes must survive adapter additions.

### Whole-agent workers

`WorkerProvider` requires allocation resolution, provision, inspect and destroy; optionally renewal, maintenance, machine/OS options, prepared intent, node enrollment and SSH identity resolution. `WorkerProviderError` (`capability-provider.types.ts:244–273`) separates proven allocation cleanup from indeterminate cleanup. `provider-lifecycle.ts:322–364,429–493,509–687` provisions/replays durable operation IDs, reconciles lost allocation replies, inspects lease states and handles expected/unexpected teardown. `provider-owner-lifecycle.ts:160–258,267–343` revalidates ownership, persists destroying state and keeps indeterminate teardown retryable instead of marking potentially paid live machines gone.

This is materially stronger than Hermes environment-object cleanup and snapshot JSON maps. Keep SQLite state, placement/run claims, enrollment identities and transport authority. Cloud vendors that can expose an OpenClaw node should implement WorkerProvider; a command-only SDK sandbox should begin with SandboxBackend. A provider can support both through one plugin with explicit adapters, without merging owners.

## Command approval comparison

### Hermes flow and guarantees

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

### OpenClaw guarantees

`infra/exec-approvals-core.ts:10–15,115–130` defines target, security deny/allowlist/full, ask off/on-miss/always, normalized modes deny/allowlist/ask/auto/full, decisions allow-once/allow-always/deny. `exec-approvals-policy.ts:11–39` owns approval requirement and conservative security/ask intersection. `exec-run.ts:306–357` intersects model-call overrides with configured/host floors. `node-host/invoke-system-run.ts:168–186` intersects node-local policy independently, so gateway intent alone is insufficient.

`infra/exec-approvals-allowlist.ts:780,1271 evaluateExecAllowlist/evaluateShellAllowlistWithAuthorization` resolves executables and command segments; `exec-approvals-analysis.ts:46–104` builds enforceable shell command representations. Auto skill binary permission remains an execution policy mechanism, not a generalized content scanner.

`agents/exec-auto-reviewer.ts:40–45` validates JSON decision/risk/rationale. `74–145` delimits untrusted request and detects reviewer directives; `154–284` rejects duplicate JSON keys, malformed output and high/unknown-risk allows. `359–510` controls preparation/model deadlines and cancellation; failed reviews fall back to human review. Its prompt (`exec-auto-reviewer.prompt.ts:3–48`) distinguishes operator transcript origins from channel/inter-session/internal text and treats transcript content as evidence, not reviewer instructions. Reviews grant only allow-once authority, never durable permission merely because the model said yes.

`infra/system-run-approval-binding.ts:57–193` binds argv/cwd/agent/session/env; `prepareSystemRunExecutableIdentityBinding():367–459` binds resolved executable identity; `prepareSystemRunMutableFileBinding():462–551` and `revalidateSystemRunMutableFileBinding():553–623` bind mutable shell/script inputs. `system-run-file-snapshot.ts:10–65` realpaths and hashes script operands and verifies content before execution. `system-run-cwd-binding.ts:15–59` verifies cwd filesystem identity. Gateway approval handling (`bash-tools.exec-host-gateway.ts:379–403,753–903,1234–1242,1417–1459`) revalidates before spawn and denies drift. Node handling (`invoke-system-run.ts:773–839`) rejects cwd/script/executable drift and missing bindings. This is substantially more than command-string approval.

Persisted approval owners are `infra/exec-approvals-store.ts`, `exec-approvals-sqlite.ts`, `exec-approvals-authorization.kernel.ts/.worker.ts`; gateway requests/resolution and channel forwarding remain separate transports. Permission records, approval decisions and current run authority must not be merged into content trust records.

**Verdict: KEEP_OPENCLAW. DO NOT PORT HERMES IMPLEMENTATION.** No demonstrated Hermes approval advantage warrants replacement. Its explicit catastrophic-floor examples can seed adversarial regressions when the OpenClaw policy layer changes; an immutable regex floor would be a new product restriction requiring an explicit policy design, not a routine source port.

## Future provider shape and migration

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

## Exact port map

| Priority | Hermes source | Hermes symbol | OpenClaw target | Action | Reason |
|---|---|---|---|---|---|
| P3 optional | `tools/environments/daytona.py:24–207` | `DaytonaEnvironment` lifecycle/SDK operations | New `extensions/daytona/` implementing public sandbox SDK; optional WorkerProvider | ADAPT_HERMES | Vendor coverage; retain OpenClaw ownership, fs safety and cancellation rather than Python class |
| P3 optional | `tools/environments/modal.py:47–51,130–280` | `ModalEnvironment`, `_store_direct_snapshot` | New `extensions/modal/`; existing SQLite runtime owner | ADAPT_HERMES | Vendor execution/snapshot mechanics; do not copy JSON persistence, dedicated Python event-loop thread or managed gateway |
| P3 optional | `tools/environments/vercel_sandbox.py:163–418` | `VercelSandboxEnvironment` | New `extensions/vercel-sandbox/` | ADAPT_HERMES | Vendor capability/reference failure cases; selected only if product needs this backend |
| P4 deferred | `tools/environments/daytona.py:128–138,186–207`; `tools/environments/modal.py:253–280`; `tools/environments/vercel_sandbox.py:281–313,405–418` | `DaytonaEnvironment._ensure_sandbox_ready/cleanup`, `ModalEnvironment.cleanup`, `VercelSandboxEnvironment._snapshot_sandbox/cleanup` | Existing SandboxBackend/WorkerProvider capability extension; Crabbox checkpoint owner reference | HYBRID | Generalize explicit capability only after a live vendor use case; filesystem state is not process hibernation |
| Whenever approval code changes | `tests/tools/test_approval.py`, `test_approval_deny_rules.py`, `test_smart_approval_injection.py` | Catastrophic shell/obfuscation/injection scenarios | Existing OpenClaw exec security/analysis/reviewer tests | KEEP_OPENCLAW (conceptual test reuse) | Broaden relevant regressions without a second policy/reviewer |

No direct PORT_HERMES transplant is justified in these lanes.

## OpenClaw files likely touched if optional additions are approved

* Vendor plugin entry, manifest, config/schema, transport/backend, fs adapter, lifecycle/state support and focused tests (new files). `src/plugin-sdk/sandbox.ts` remains the intended public seam.
* If SDK-only process transport cannot fit `buildExecSpec`: `src/agents/sandbox/backend-handle.types.ts`, `src/agents/bash-tools.exec-runtime.ts`, process supervisor adapter/tests, SDK export/contract tests. First prove this gap with one vendor; do not preemptively rewrite the process system.
* Worker additions: new plugin WorkerProvider, `src/plugins/capability-provider.types.ts` only for a proven missing generic capability; existing registry and lifecycle owners should usually remain unchanged.
* Checkpoint capability only: existing sandbox manager/handle contracts, worker capability types, worker environment state/migrations/service contracts, selected provider plugin; preserve Crabbox lifecycle rather than copy its provider-private code.
* Trust Engine enforcement on providers: existing sandbox backend creation/registration and worker provider selection/admission, plugin trust/install owner; provider authorization remains at its current action boundaries.

## Existing tests and required proof

OpenClaw useful existing tests:

* `src/agents/sandbox/backend.test.ts:28–75` reserves runtime authority before factory invocation; registration generations, Podman and resource capability tests.
* `sandbox/context.state-owner.test.ts`, `context.managed-custody.test.ts`, `runtime-reservation.test.ts`, `registry-authority.test.ts`, `local-workspace-quiescence.test.ts`: owner/lifecycle correctness.
* `sandbox/docker.partial-create-cleanup.test.ts`, `docker.config-hash-recreate.test.ts`, `podman-upgrade.test.ts`: failed creation, config drift and upgrades.
* `sandbox/ssh-backend.test.ts`, `ssh.stream-errors.test.ts`, `ssh.spawn-env.test.ts`, `remote-shell-backend.test.ts`: transport/workdir/env/failure contracts.
* `sandbox/remote-fs-bridge.parent-alias.test.ts`, `.path-bytes.test.ts`, `fs-bridge.anchored-ops.test.ts`, `validate-sandbox-security.test.ts`: hostile paths and filesystem mutation boundaries.
* `plugins/worker-provider-registry.test.ts`, `worker-provider-maintenance.test.ts`, `gateway/worker-environments/provider-provisioning.replay.test.ts`, `provider-provisioning.cancellation.test.ts`, `provider-owner-revocation.test.ts`, `provider-reconciliation.test.ts`, `worker-turn-launcher-failure-recovery.test.ts`, `computer-transport.takeover.test.ts`: provider validation, recovery and identity takeover.
* `agents/exec-auto-reviewer.test.ts:98–1045`: malformed/duplicate outputs, consistent risk, directive injection, timeouts, cancellation and one-shot concurrent approvals; `agents/exec-auto-reviewer.resources.test.ts` and `agents/exec-auto-review.stress.test.ts` cover retained resources.
* `agents/bash-tools.exec.security-floor.test.ts:112–660`, `exec-host-gateway` tests, `node-host/invoke-system-run*`, `infra/system-run-approval-binding*`: model override resistance, host-local floors, command/script/executable/cwd drift.

Hermes useful conceptual tests:

* `tests/agent/test_terminal_env_registry.py:56–200`: scoped registration, reserved names, raising classifications and credential key union.
* `tests/tools/test_daytona_environment.py:119–299`: persistent lookup/start, cleanup stop, interrupt stop/restart, resource conversion, SDK failure and quoted uploads.
* `test_modal_sandbox_fixes.py`, `test_modal_snapshot_isolation.py`, `test_vercel_sandbox_environment.py`: snapshot namespace/restore/fallback/SDK lifecycle.
* `test_ssh_environment.py`, `test_ssh_remote_cwd.py`, `test_ssh_bulk_upload.py`, `test_build_subprocess_env.py`, `test_hermes_subprocess_env.py`: quoting/path/environment exposure across backends.
* `test_smart_approval_injection.py`, `test_smart_approval_policy.py`, `test_approval_deny_rules.py`, `test_approval_mode_parity.py`: reviewer prompt boundary and operator floors.

Required future tests: one shared conformance suite per backend for byte-exact stdin/output, invalid UTF-8 filenames, cwd/workdir roots, credentials excluded from argv/logs/guest env, abort before allocation/during SDK/after dispatch, detached termination after run authority expires, bounded output, partial allocation cleanup, lost provision response/idempotent replay, config/publisher/hash change requiring reapproval/reverification, stale plugin generation, symlink/parent-alias swaps, resource/property failures, provider disappearance and visible result. Snapshot tests must show file restoration and explicitly show which processes cannot survive; retention/eviction must not discard paid live resources on indeterminate teardown. Migration tests must reopen old/new SQLite state, preserve existing Docker/Podman/SSH/OpenShell configuration and reject incompatible worker dialects rather than silently downgrade.

## Things not to copy

Hermes approval regex engine, broad pattern-key permanent grants, simple word-only reviewer, shell snapshot/functions/aliases as an implicit backend state contract, `.hermes` host-home synchronization, process-resident environment registry as the durable source of truth, JSON snapshot maps, best-effort silent cleanup as proof of machine destruction, assumed `is_container` approval bypass, Nous managed tool gateway, vendor classes in core, TUI setup/wizard presentation and Singularity absent a product requirement. Preserve OpenClaw's security/permission/approval owners and put vendor-specific work in plugins.

