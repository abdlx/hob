# Deployment

The image combines the custom hob UI/server with a digest-pinned
upstream-source Hermes runtime (`7e9eb8d9`, built with upstream's Dockerfile and
published to public GHCR). This runtime image supports Linux amd64 only.
The app image applies a checksum-guarded fix to `gateway/run_goals.py`: native
LOCAL heartbeats reach Hermes's admission queue before the legacy adapter-handler
check. Unknown source bytes fail the build. `hob-compat.json` records the fix;
Hermes still owns scheduling, admission, execution and persistence.
Local reference and archived runtime source trees are
excluded from the app build context.

## Processes and first-run setup

The inherited Hermes entrypoint performs its normal initialization and privilege
drop. Our application supervisor then launches:

- `hermes -p default serve --host 127.0.0.1 --port 8080 --isolated`: private settings service.
- `hermes -p default gateway run --no-supervise --external-supervisor`: the private
  runtime API, bound to 127.0.0.1:8642.
- The custom web server on port 3000.

The upstream container's separate dashboard slot is disabled to avoid binding a
second settings server. The image takes `02-reconcile-profiles` out of automatic
boot and preserves it under `/app/deploy/upstream-reconcile-profiles.disabled`.
This intentionally gives Gateway process ownership to our foreground supervisor:
stock persisted s6 gateway autostart must not launch a competing instance on
restart. Upstream init, package management, volume setup and privilege drop remain
in place. The image build refuses a changed/missing hook path rather than silently
assuming that a future image has the same contract. Linux first boot and container
recreation pass the container smoke workflow linked below.

A missing config is seeded without a provider and with external CLI login adoption
disabled. Existing config bytes are kept.
Listener credentials are generated once in `/opt/data/.hob/listener-auth.json`,
read privately by the adapter, and reused on restart. A corrupt record fails
startup rather than silently rotating credentials. No credentials are CLI arguments.
After settings becomes available, bootstrap persists Main's API listener key through
Hermes' own credential API before launching Gateway. Multiplexed secret scopes do
not accept an inherited process API key as profile credential consent.

The runtime child environment excludes the app login/session credentials and
dashboard administration token. This is environment separation; filesystem and
process isolation still require the appropriate Hermes execution backend.

Settings and the web service are critical processes. Failure of either stops the
container. Agent runtime exit instead retries after five seconds while Settings
remains available, allowing model/config errors to be repaired from the UI.

## Health

`/healthz` checks the application's private settings service. It can be healthy
before model credentials are configured or while the agent runtime is restarting.
Authenticated `/api/readiness` separately reports whether the runtime's required
run API is available. A successful model/tool task is a further verification step.

## Storage

The `hermes-data` named volume mounts at `/opt/data`; the official entrypoint owns
its initialization and migrations. New app state is under `.hob/`. The Main
working directory defaults to `workspaces/main`; existing operator config may
override execution settings.

The old OpenClaw volume is left untouched and is not implicitly imported.
The operator-created roster persists in `.hob/bots.json`. Named bots receive distinct
keys and working directories under `workspaces/bots/<name>` through the native
settings/credential owners before dashboard activation. A bot called `main` cannot
collide with Main's `workspaces/main` directory. Unenrolled profiles do not become
dashboard bots merely because Hermes discovers them. Partial setup remains pending
for explicit operator recovery; revoked enrollment stays revoked if setup was in flight.
These are application routing/state boundaries; a local backend with shared OS access
can still reach other files/processes. Execution sandbox isolation remains required.

Dashboard conversations use the authenticated Gateway-owned native session socket,
with a separate connection per enrolled bot. New conversations never fall back to
raw HTTP agents. Pre-migration API conversations remain read-only history; their
existing task/recovery controls continue to use their original owner. The dashboard
chooses a native conversation on startup and offers a new one when only old API
history exists.

HTTP run and native admission references persist in `.hob/runs.json`. Include the
journal and matching bot credentials in backups. Startup never resubmits work.
Native pending acceptance can be recovered by observation of the owner ledger;
an unknown acceptance absent from the pending projection remains fenced rather
than being blindly replayed. HTTP recovery retains its original explicitly
confirmed, credential-bound durable replay window. Do not clear the journal to
bypass unknown work. Native `unknown` outcomes require an explicit current
admission/generation resolution. Missing receipts do not prove completion, and
native conversation history remains readable when a receipt disappears.

The local native/custom-server proof now covers question display and actual answer
delivery to a managed worker across adapter restart, plus a real tool side effect
and persisted history, using a deterministic model. Linux image build and first
boot also pass CI; real-provider verification remains outstanding. Local source launches must use a
supported Hermes Python (`HERMES_PYTHON`) with its PM-managed dependencies; the
runtime image sets that interpreter. No bootstrap helper installs dependencies
or starts a second Gateway.

## Standalone access

Use `compose.standalone.yaml` alongside `compose.yaml`. Its host binding defaults
to loopback. Supply the app password/session secret through a private environment
file or your platform's secret manager. Model/tool credentials belong in Settings.

An HTTPS proxy should forward to port 3000 and preserve streaming connections.
Set `MUSE_PUBLIC_URL` to the exact browser origin and secure cookies for HTTPS.
Hermes' two loopback APIs must not be published as host ports.

## Container security and browser

The upstream root initializer needs CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID and
KILL to prepare volume ownership and supervise/drop users. Compose drops other
capabilities and retains `no-new-privileges`. Normal app/runtime processes use
the upstream Hermes user, not root.

Chromium comes from Hermes' managed image. The supplied seccomp profile permits
its namespace sandbox; host kernel/AppArmor support must also be verified.
Coolify must retain the repository so Compose can resolve that profile.

No host Docker socket is mounted. Configuring a Docker execution backend requires
a separately designed execution service; selecting that backend alone cannot
create a missing Docker daemon.

## Backup and upgrade

Stop the application and back up the complete `hermes-data` volume. Preserve its
private credentials and database companion files together. Test restore before
relying on the backup.

The Dockerfile's runtime image digest is the dependency pin. Build a
candidate after a deliberate digest update, test APIs, setup, model/tool turns,
profile isolation, groups and recovery against copied state, then deploy. Keep a
matching state backup for rollback; an older runtime may not read upgraded state.

The local reference snapshot has not been proven identical to the runtime image.
The [Coolify image first run workflow](https://github.com/abdlx/hob/actions/runs/40377004694)
passed at `e66b05cd`, including image build, native relay/worker/coordinator execution,
a fired heartbeat and retained state across container recreation using a deterministic
model fixture. It verifies
hardening configuration, native session/tool execution and persisted state.
Service UID checks verify the supervisor, web server, gateway and settings service
are unprivileged before and after recreation. The isolated Chromium probe
(`deploy/probe-browser.mjs`) launches the browser on the same
`--remote-debugging-pipe` transport production uses, speaks CDP over the pipe, asserts
namespace and seccomp sandbox status, and fails if the browser writes a
`DevToolsActivePort` file or listens on any TCP port. It gates CI success.
This is a binary capability check, not proof of Hermes browser-tool isolation:
the pinned upstream `agent-browser` automatically adds `--no-sandbox` in Docker
(see its [container detection](https://github.com/vercel-labs/agent-browser/blob/v0.26.0/cli/src/native/cdp/chrome.rs)).
No upstream browser executable or runtime source has been patched to change that.
Graceful shutdown, active-work recovery across full runtime restart, backup/restore,
candidate upgrades, actual provider accounts and production-host behaviour remain
unverified. No local Docker daemon is available.
