# Coolify deployment

## Upgrade to the hob namespace

For an existing resource, preserve its current secrets and storage before deploying:

1. Copy the existing `SERVICE_PASSWORD_64_MUSE` value into `SERVICE_PASSWORD_64_HOB`, and `SERVICE_REALBASE64_64_MUSE` into `SERVICE_REALBASE64_64_HOB`. Do this privately in Coolify; never paste the values into logs or Git. The new references can otherwise generate different secrets.
2. Move the existing domain/proxy assignment from service `muse` to `hob`. Use `SERVICE_URL_HOB_3000` / `HOB_PUBLIC_URL` for the same public origin. Keep the same resource/project and existing `hermes-data` volume; do not create an empty replacement volume.
3. Rename operator-supplied `MUSE_*` application settings to `HOB_*`. The source-launch configuration adapter accepts old names only when the corresponding canonical setting is absent. Compose interpolation uses the variables shown in the current files.
4. Build the whole image. The native review/schedule-preview endpoints and timezone-cache fix are installed by `apply-hermes-compat.py`; replacing only the frontend bundle is insufficient. The heartbeat, skills-router and clock source checksums must match the pinned runtime, or the build stops.
   If the deployed `/api/version` reports commit `unknown`, provide the public
   checkout SHA as build-time `HOB_GIT_COMMIT` when Coolify does not export
   `SOURCE_COMMIT`. The CI image passes and verifies the exact checkout SHA.
5. Sign in again, because the browser cookie is now `hob_session`. Verify the retained bot roster, a known conversation, provider metadata, and a Library file before allowing new work. Install the updated mobile client to use the canonical authentication event.

Back up the Hermes volume, any external isolated workspace root, and HOB state as one stopped snapshot. For rollback, restore that matching snapshot and the previous image/Compose configuration. Keep the original historical volume names in backups; this rename does not rename Docker volumes or import the old OpenClaw database.

An interrupted native review leaves a `.hob-claimed-*.claim` file and a visible unresolved-decision notice. Preserve the claim, native state, and review audit before operator reconciliation. Compare the proposed change with current memory/skills through their native owners. Do not blindly put a claim back into the queue or call its applier again: the change may already have succeeded. Automatic rollback and reconciliation of uncertain native writes are not provided.

The runtime base is a public, digest-pinned upstream Hermes image. The app adds
checksum-guarded native heartbeat and review/preview extensions and the custom hob application. It currently supports
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
   | Public service | `hob` |
   | Internal service port | `3000` |

   The Compose `build` block selects the root `Dockerfile` automatically. Do not
   choose Dockerfile-only, Docker Compose Empty, or `compose.standalone.yaml`.
   Keeping the repository allows Compose to resolve `deploy/chromium-seccomp.json`
   when recreating the service.
3. Point your domain's DNS to the Coolify server. In the `hob` service's Domains
   field, enter `https://hob.example.com:3000`, replacing the hostname with yours.
   The suffix selects the container port for Coolify's proxy. Your browser URL
   is `https://hob.example.com`, without that suffix.
4. Add these runtime environment variables, substituting the same hostname:

   ```text
   HOB_PUBLIC_URL=https://hob.example.com
   HOB_SECURE_COOKIES=true
   ```

   `HOB_PUBLIC_URL` must be the browser origin; do not append the internal port.
5. Save and **Deploy**. Coolify generates `SERVICE_PASSWORD_64_HOB` and
   `SERVICE_REALBASE64_64_HOB` from the Compose references. Retrieve the generated
   password from Environment Variables and sign in at your domain. Keep both
   generated values stable on redeploy; do not publish their values.
6. Open **Settings → Main**, save a provider credential, select its provider/model,
   then start a new conversation and verify a reply and a tool task. Main is the
   only enrolled bot initially. Create additional bots explicitly in Settings.
7. For a remote OAuth MCP connection, choose **OAuth sign-in** when adding its
   endpoint, save it, then select **Sign in to MCP server**. Confirm and open its
   authorization provider. The callback uses the same public dashboard origin;
   no additional port needs exposing. Return to Settings to observe completion
   and use **Test connection**. Servers requiring a vendor-fixed loopback callback
   need a different onboarding flow; this hosted callback does not replace it.
8. Optional: in **Settings → Memory providers**, choose a provider, edit its
   native fields, then review and confirm **save and select**. This may send the
   bot's memory/conversations to the provider. Use separate external projects or
   namespaces to preserve separation between bots. Dependency setup is a separate
   confirmed action; it does not submit unsaved fields or select the provider.
   Selecting built-in memory again preserves stored external settings and data.
   Existing sessions may need restarting to use a changed provider.
9. Review **Settings → Learning & write approvals** for each bot. Require native
   skill approval to stage agent skill changes, then use Workshop for pending
   proposals, diffs and explicit decisions. Built-in memory approval separately
   prompts foreground writes and stages background writes. Review complete pending
   memory proposals in Learning & write approvals and skill proposals in Workshop.
   Decisions require the displayed revision; interrupted claims require native-state
   reconciliation and are never automatically applied again. Turning off background review does not block
   foreground skill/memory tools; built-in gates do not cover external-provider
   writes. Changes preserve existing data and do not cancel in-flight work.

No custom build/start command is needed. Do not publish ports 8080 or 8642, add a
host port mapping, or mount the host Docker socket. The application Dockerfile
includes the frontend build and the supervised runtime.

See [Coolify's Git-based Docker Compose instructions](https://coolify.io/docs/applications/builds/docker-compose).

Coolify supplies the app session signing secret through
`SERVICE_REALBASE64_64_HOB`. These generated login values remain stable on
redeployment. Private Hermes listener credentials are managed by the supervisor
and persisted on the data volume; do not enter model keys in the Compose file.

If the browser origin differs from Coolify's generated URL, set
`HOB_PUBLIC_URL=https://your-domain` explicitly. HTTPS access should use secure
cookies. There is no public Hermes dashboard/API port and no host Docker socket.

## Manual deploys and commit verification

### Frontend dependency installation fails with EUSAGE

If the build reports missing `@emnapi/core` / `@emnapi/runtime` entries during
`npm ci`, the frontend lockfile is missing dependencies bundled inside Tailwind's
optional WASM package. This can pass an older npm's local check and still fail
with npm 11.19.0 in the pinned Docker build image. The repaired lockfile records
the actual bundled packages; it does not upgrade application dependencies.

Keep `npm ci` in the Dockerfile. Regenerate lockfile metadata using npm 11.19.0
and verify a clean install from only `package.json` and `package-lock.json`,
without an existing `node_modules` directory. The web CI job explicitly uses
that npm version to catch this mismatch before deployment. The pnpm lockfile
already describes the bundled dependencies and needs no dependency change.

### Verify the deployed commit

If **Deploy** appears to build an older commit than the one shown in GitHub,
the running image now states exactly what it contains. The build bakes Coolify's
`SOURCE_COMMIT` and `COOLIFY_BRANCH` into the image, and the app exposes them:

```text
GET https://hob.example.com/api/version
{"commit":"<40-character sha>","ref":"main","builtAt":"<build timestamp>"}
```

`/healthz` includes the same fields, and the container startup log prints
`hob <commit> (<ref>)`. Compare the reported commit with the one you intended to
deploy before diagnosing a behavioural difference.

When the reported commit is wrong:

1. In the application's **General** settings, confirm **Branch** is `main` and
   that the repository is `https://github.com/abdlx/hob`.
2. Use **Deploy** from the application header, not a webhook replay or an older
   deployment entry. Open the deployment's build log and confirm its checkout
   step names the intended commit.
3. If the UI still shows an older deployment, choose **Deploy** again and enable
   **Force rebuild** / clear the build cache for that deployment. Coolify caches
   `npm ci` and the frontend build layers; the source copy is invalidated by the
   checkout, but a stale queue entry can still redeploy the previous image.
4. Confirm the new container actually started: a failed health check or a
   start-loop leaves the previous container serving traffic while the new
   deployment is marked failed. Inspect the deployment logs and the `hob`
   service logs.
5. Re-check `/api/version`. If the commit matches but the UI is stale, hard
   refresh the browser once; the frontend bundle is served from the new image.

`unknown` means the build did not receive `SOURCE_COMMIT` (for example a local
`docker compose build` without build args). It does not mean the checkout
failed. Locally, pass the values explicitly:

```sh
docker compose build \
  --build-arg HOB_GIT_COMMIT="$(git rev-parse HEAD)" \
  --build-arg HOB_GIT_REF="$(git branch --show-current)" \
  --build-arg HOB_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

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
The [MCP OAuth container verification](https://github.com/abdlx/hob/actions/runs/39037792969)
at `469e8575` passed 40 checks across recreation, including the native SDK's
discovery, client registration, PKCE exchange, callback replay refusal, bot binding
and persisted credential/tool probe. This uses an isolated simulated OAuth/MCP
server, not a real vendor account. Rendered UI interaction remains unverified.
Native groups, durable admission tracking, guided setup and native workspace
controls are implemented and have local verification. Active-work recovery across
a full runtime restart, graceful shutdown, backup/restore, candidate upgrades,
remaining setup surfaces and production-host behaviour still need verification;
see `Hermes-Integration-Checkpoint.md` in the repository root.

The [external-memory setup verification](https://github.com/abdlx/hob/actions/runs/39040025685)
passed at `d844f1e1`, with 48 checks across container recreation. It uses the
bundled RetainDB schema/config/selection owners with a synthetic key and isolated
endpoint, including per-bot settings and credential persistence. It does not
start external memory sessions or verify a vendor account, recall quality,
dependency installation or the rendered memory settings UI.

### Relay credentials and proactive work

Upgrading repairs relay credentials on boot. Hermes deliberately filters its listener key from terminal commands; the generated helper now uses a distinct relay-only key in each bot's private `.hob/relay.json`. The registry migrates to version 3 without changing native listener keys. Back up the data volume before upgrading; older application versions cannot read this registry version. A failed bot synchronization participates in boot retries and is reported in the server log.

Co-located bots call the private loopback app listener, independently of `HOB_PUBLIC_URL`, the TLS proxy and host-published ports. An operator configuring a genuinely remote execution backend may explicitly set the complete `HOB_BOT_RELAY_URL`; normal Coolify deployments need no override.

Exchange database version 2 adds a durable result outbox. Newly completed handoffs wake their caller and Main through the pinned runtime's native Bot Chat ingress. Delivery acknowledgements are distinct from completed model turns, and retries reuse the same native delivery ID. Inspect **Automatic follow-up** inside an exchange for its delivery status. Existing historical exchanges are not replayed on upgrade. Heartbeats are configured per native conversation in **Settings → Automation** and require the gateway to remain online. Scheduled jobs remain native Hermes jobs.

These changes have local adapter and Chromium coverage. Their new native automation paths still require image-level and live-model verification. The default container continues to share an OS user between bots; relay credentials and private folders do not create a hostile-bot sandbox.

## Optional per-bot OS users

The standard Compose configuration retains shared execution for existing installs.
To enable distinct Linux users, apply `compose.isolation.yaml` after `compose.yaml`.
The equivalent CLI invocation is:

```sh
docker compose -f compose.yaml -f compose.isolation.yaml up -d --build
```

In Coolify, apply all of the overlay's environment, volume and capability changes
together in the deployment's Compose configuration. Setting only `HOB_ISOLATION`
is insufficient: OpenSSH also needs `SYS_CHROOT`, and persistent UID/key/workspace/
browser data need the `hermes-isolation` volume. Public ports remain unchanged.

Back up the existing `hermes-data` volume before enabling this mode. Initial
migration copies independent workspace/browser files into `hermes-isolation` and
preserves the originals; allow space for that copy. Links and foreign-owned files
require review. Enroll/remove existing native profiles before enabling isolation;
an unenrolled or revoked native profile blocks gateway startup.

After migration, back up and restore both volumes together. A missing UID registry
or accidental shared-mode deployment fails closed. Rollback requires the matching
pre-migration state backup, rather than removing the isolation marker or changing
only an environment variable. The [deployment guide](README.md#per-bot-linux-process-isolation)
describes the trusted gateway/plugin/MCP boundary.
