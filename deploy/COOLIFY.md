# Coolify deployment

The current runtime is a public, digest-pinned image built from unchanged upstream
Hermes source, with the custom hob application added. It currently supports
**Linux amd64 only**. The imported Hermes reference source is not compiled or
modified by this deployment.

## Exact application settings

1. In the target project/environment, choose **New Resource → Application** and
   connect this Git repository. Use your GitHub integration if the repo is private.
2. Select **Docker Compose** as the build pack / build strategy. Use these values:

   | Field | Value |
   | --- | --- |
   | Repository | `https://github.com/abdlx/hob` |
   | Branch | `main` |
   | Base Directory | `/` |
   | Docker Compose Location | `/compose.yaml` (or `compose.yaml` when the field is relative) |
   | Preserve Repository During Deployment | Enabled |
   | Public service | `muse` |
   | Internal service port | `3000` |

   The Compose `build` block selects the root `Dockerfile` automatically. Do not
   choose Dockerfile-only, Docker Compose Empty, or `compose.standalone.yaml`.
   Keeping the repository allows Compose to resolve `deploy/chromium-seccomp.json`
   when recreating the service.
3. Point your domain's DNS to the Coolify server. In the `muse` service's Domains
   field, enter `https://hob.example.com:3000`, replacing the hostname with yours.
   The suffix selects the container port for Coolify's proxy. Your browser URL
   is `https://hob.example.com`, without that suffix.
4. Add these runtime environment variables, substituting the same hostname:

   ```text
   MUSE_PUBLIC_URL=https://hob.example.com
   MUSE_SECURE_COOKIES=true
   ```

   `MUSE_PUBLIC_URL` must be the browser origin; do not append the internal port.
5. Save and **Deploy**. Coolify generates `SERVICE_PASSWORD_64_MUSE` and
   `SERVICE_REALBASE64_64_MUSE` from the Compose references. Retrieve the generated
   password from Environment Variables and sign in at your domain. Keep both
   generated values stable on redeploy; do not publish their values.
6. Open **Settings → Main**, save a provider credential, select its provider/model,
   then start a new conversation and verify a reply and a tool task. Main is the
   only enrolled bot initially. Create additional bots explicitly in Settings.

No custom build/start command is needed. Do not publish ports 8080 or 8642, add a
host port mapping, or mount the host Docker socket. The application Dockerfile
includes the frontend build and the supervised runtime.

See [Coolify's Git-based Docker Compose instructions](https://coolify.io/docs/applications/builds/docker-compose).

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
The stock automatic profile-gateway boot hook is retained outside `cont-init.d`,
and Gateway uses the native foreground/external-supervisor flags so only our
supervisor owns its lifetime. Linux first boot and container recreation passed
the container smoke workflow linked below.
A runtime failure retries while Settings stays available. A settings/web failure
stops the container, allowing the restart policy to recover it.

Health means the settings service is reachable. Runtime readiness, valid provider
credentials, and a successful task are additional checks. Inspect logs and the
UI if chat is unavailable despite a healthy service.

## Updates and validation

Updates use an explicit image digest in the Dockerfile, followed by a candidate
build, backup and verification. No source patch rebasing is required; API/config
changes may still require adapter updates. Do not run an in-container source
updater.

The runtime base is not the published official v0.22.2 image: its diagnostic
`identify` and `status` responses lack the session-authority contract, and it has
no `session-ticket` verb. It cannot serve the native sessions this application
uses. The runtime is instead built from upstream commit
`7e9eb8d9a30f4a9bb9f8ecaf816b4b0ffdf47357` by
`.github/workflows/hermes-runtime-image.yml` and pinned by digest in the
Dockerfile. Once an official release supports the required contract, verify its
image through the smoke workflow before replacing the pin and retiring the build
workflow. The previous official digest, `sha256:36099926da316742423544e055d4734777105ffe6341873af5459b957d0c2919`,
is recorded for provenance; it is incompatible with the current adapter and must
not be restored as a working runtime. The GHCR image is public, so Coolify and CI
pull it without registry credentials.

The [Coolify image first run workflow](https://github.com/abdlx/hob/actions/runs/39036456635)
passed at `1dd39956`: Linux image build, authenticated first-run setup, native
session/tool execution against an isolated simulated provider, and 33 checks
across container recreation. It asserts Compose hardening and data persistence.
It also asserts that all four application services use UID 10000 before and after
recreation, and that an isolated Chromium renderer reports namespace and seccomp
sandboxing through DevTools. This does not prove another host's kernel supports
the same sandbox or that Hermes' browser tool uses it: upstream's pinned
`agent-browser` automatically adds `--no-sandbox` when it detects Docker.
Browser-tool isolation needs separate verification; the probe does not override
upstream tool behaviour.
No actual provider account has been exercised.
Native groups, durable admission tracking, guided setup and native workspace
controls are implemented and have local verification. Active-work recovery across
a full runtime restart, graceful shutdown, backup/restore, candidate upgrades,
remaining setup surfaces and production-host behaviour still need verification;
see `Hermes-Integration-Checkpoint.md` in the repository root.
