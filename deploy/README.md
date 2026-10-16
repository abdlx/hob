# Deployment

The image combines the custom hob UI/server with an unchanged, digest-pinned
official Hermes runtime. Local reference and archived runtime source trees are
excluded from the app build context.

## Processes and first-run setup

The inherited Hermes entrypoint performs its normal initialization and privilege
drop. Our application supervisor then launches:

- `hermes serve --host 127.0.0.1 --port 8080 --isolated`: private settings service.
- `hermes gateway run`: the private runtime API, bound to 127.0.0.1:8642.
- The custom web server on port 3000.

The upstream container's separate dashboard slot is disabled to avoid binding a
second settings server. Its entrypoint and package/runtime lifecycle are retained.

A missing config is seeded without a provider. Existing config bytes are kept.
Listener credentials are generated once in `/opt/data/.hob/listener-auth.json`,
read privately by the adapter, and reused on restart. A corrupt record fails
startup rather than silently rotating credentials. No credentials are CLI arguments.

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
Additional-bot workspace enforcement and durable app roster/recovery are still
being implemented; separate profile memory does not by itself prove complete
execution isolation.

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

The Dockerfile's official image digest is the runtime dependency pin. Build a
candidate after a deliberate digest update, test APIs, setup, model/tool turns,
profile isolation, groups and recovery against copied state, then deploy. Keep a
matching state backup for rollback; an older runtime may not read upgraded state.

The local reference snapshot has not been proven identical to the published image.
Container builds and live provider verification remain pending in this environment.
