# Coolify deployment

The current runtime is a pinned official Hermes image with the custom hob
application added. The imported Hermes reference source is not compiled or
modified by this deployment.

1. Create a **Docker Compose** application from this repository.
2. Select `compose.yaml`, without the standalone override.
3. Enable **Preserve Repository During Deployment** so Compose can resolve
   `deploy/chromium-seccomp.json` on recreation.
4. Assign the browser domain to service `muse`, port **3000**.
5. Deploy, retrieve the generated `SERVICE_PASSWORD_64_MUSE` value from Coolify,
   and sign in to the custom UI.
6. Open Settings, connect a provider credential, select a provider/model, and
   verify a real conversation and tool task.

Coolify supplies the app session signing secret through
`SERVICE_REALBASE64_64_MUSE`. These generated login values remain stable on
redeployment. Private Hermes listener credentials are managed by the supervisor
and persisted on the data volume; do not enter model keys in the Compose file.

If the browser origin differs from Coolify's generated URL, set
`MUSE_PUBLIC_URL=https://your-domain` explicitly. HTTPS access should use secure
cookies. There is no public Hermes dashboard/API port and no host Docker socket.

## Storage and startup

The `hermes-data` volume mounts at `/opt/data`. The old OpenClaw `muse-data`
volume is preserved by Docker but is neither mounted nor automatically migrated.

The official Hermes entrypoint initializes storage and drops privileges. Our
supervisor launches the private settings/runtime APIs and the custom server.
A runtime failure retries while Settings stays available. A settings/web failure
stops the container, allowing the restart policy to recover it.

Health means the settings service is reachable. Runtime readiness, valid provider
credentials, and a successful task are additional checks. Inspect logs and the
UI if chat is unavailable despite a healthy service.

## Updates and validation

Updates use an explicit official image digest in the Dockerfile, followed by a
candidate build, backup and verification. No source patch rebasing is required;
API/config changes may still require adapter updates. Do not run an in-container
source updater.

Compose parsing and isolated bootstrap/adapter tests pass locally. There is no
running Docker daemon in the current development environment, so a Linux image
build, actual first-run setup and live model execution are not yet proven.
The broader migration also still includes group chats, durable recovery and
remaining UI surfaces; see `Hermes-Integration-Checkpoint.md`.
