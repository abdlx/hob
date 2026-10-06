# Daytona sandbox plugin

This optional plugin adapts Daytona to the existing `SandboxBackend` registration,
reserved runtime generation, remote-shell transport and filesystem bridge. It does
not introduce an execution registry, WorkerProvider, model harness or approval
policy. It is disabled by default. Allocation can incur charges when the operator
enables it and selects `daytona` as the sandbox backend.

The adapter uses Daytona's documented REST lifecycle and token-based SSH access:
[API reference](https://www.daytona.io/docs/tools/api/),
[sandbox lifecycle](https://www.daytona.io/docs/en/typescript-sdk/daytona/),
[SSH access](https://www.daytona.io/docs/en/ssh-access/).
Live Daytona conformance has not been run for this implementation. Treat it as an
experimental adapter until the release gates below pass on an approved host.

## Operator setup

1. Create a Daytona snapshot with `/bin/sh`, `python3`, `tar` and a writable home
   directory. Choose the snapshot explicitly; the plugin never silently changes it.
2. Obtain and verify the host keys for `ssh.app.daytona.io` through a trusted
   channel. Store them in a dedicated, protected known-hosts file. No
   `StrictHostKeyChecking=no`, ambient SSH config or automatic first-use trust is used.
3. Configure a host-managed SecretRef for the Daytona API key and explicitly enable
   the plugin. The manifest owns the `apiKey` SecretInput contract; unresolved refs
   fail admission without borrowing an ambient API key.
4. Select `agents.defaults.sandbox.backend = "daytona"` and a sandbox mode such as
   `"all"`. Keep the existing exec/tool approval configuration.

Example partial configuration (`knownHostsFile` must be absolute for your host):

```json5
{
  plugins: {
    entries: {
      daytona: {
        enabled: true,
        config: {
          apiKey: { source: "env", provider: "default", id: "DAYTONA_API_KEY" },
          snapshot: "your-reviewed-snapshot",
          knownHostsFile: "/etc/openclaw/daytona_known_hosts",
          workspaceRoot: "/home/daytona/.openclaw",
          timeoutSeconds: 120,
        },
      },
    },
  },
  agents: { defaults: { sandbox: { mode: "all", backend: "daytona" } } },
}
```

The API endpoint and SSH hostname are fixed to the official service. This first
adapter does not support arbitrary self-hosted endpoints, Docker binds,
read-only host resource mounts, OpenClaw browser sandboxes, desktop/computer
placement, checkpointing, process hibernation or whole-agent execution. Those
capabilities are not advertised. Unsupported mounts/browser settings are refused
before allocation. Files are remote-canonical after the existing initial guarded
workspace upload; there is no broad host-home synchronization.

## Lifecycle and recovery

Core reserves `openclaw-<UUID>` in the existing sandbox registry before allocation.
The remote sandbox name and ownership/configuration labels must match that exact
generation. A lost POST reply leaves the reservation pending; retry checks the same
name before creating anything. No unconditional create retries or alternate names
are used. If a response is lost and the API still reports no sandbox while the
original creation remains unsettled, the service's unique name constraint is the
remaining idempotency boundary; live verification of that constraint is required.

The adapter uses private SSH config files for the short-lived username token. Tokens
are not placed in argv or forwarded environment variables. Each session's disposal
revokes only its own token and deletes its private local config. Commands, uploads,
workdir validation, output, stdin, PTY selection, abort handling, environment staging
and filesystem mutation frames reuse OpenClaw's remote-shell owners.

Automatic idle stop is set to 15 minutes; automatic deletion is disabled. Stopped
sandboxes must be resumed explicitly in Daytona. Cleanup requests DELETE only after
an exact name/ownership/configuration match and observes `destroyed` or 404 before
returning success. A timeout, unreachable service or configuration mismatch leaves
the core registry entry retryable; inspect the matching sandbox in Daytona rather
than deleting the registry row or allocating a replacement. Rotating the API key
does not change the configuration hash. Changing snapshot, workspace root or pinned
host file path requires retiring the old generation under its old configuration.

## Contract inventory

| Target | Existing owner retained | Provider scope |
| --- | --- | --- |
| Local exec | `src/agents/bash-tools.exec-host-gateway.ts`, process supervisor | Host process and host-local executable/action approvals |
| OpenClaw node | `bash-tools.exec-host-node.ts`, node `system.run` binding | Authenticated remote node execution and executable/cwd/script identity |
| Docker / Podman | `sandbox/backend.ts`, `docker-backend.ts` | Container allocation, environment staging, local resource confinement |
| SSH | `ssh-backend.ts`, `remote-shell-backend.ts`, `remote-shell-transport.ts` | Remote shell sessions, guarded workdirs and filesystem bridge |
| OpenShell | `extensions/openshell/` | Plugin-owned OpenShell provisioning and existing sandbox handle |
| Daytona | This plugin and the same remote-shell owners | Reserved cloud sandbox with fixed HTTPS control plane and pinned SSH transport |
| Whole-agent workers | `WorkerProvider`, worker environment lifecycle | Separate machine/node/turn/desktop lease owner; unchanged |

## Verification gates

The authored `src/client.test.ts` cases cover name/label admission, lost allocation
reply reconciliation, stale authority before allocation, token cleanup after
revocation, proven versus indeterminate destruction and credential-safe errors.
`src/config.test.ts` covers unhydrated secrets, unsafe paths, SSH config injection
and endpoint redirection. They require the repository's approved runtime and frozen
dependency installation; syntax checks are not a test-suite pass.

Before declaring vendor support complete, run live creation/reconciliation,
byte-exact stdin/stdout/stderr, PTY/non-PTY, abort plus remote process inspection,
host-key mismatch, cwd/path/symlink containment, workspace upload and file round-trip,
long-lived session, token expiration/revocation, idle stop/resume and observed
destruction. Verify unique-name allocation after a lost reply and confirm timeout
does not cancel server-side allocation. Do not claim process hibernation from
filesystem persistence.
