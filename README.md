# OpenMuse

OpenMuse connects the existing chat interface to the **modified OpenClaw checkout
in this workspace**. A Node adapter serves the frontend and bridges authenticated
requests to the local OpenClaw Gateway. One Docker image contains all three parts;
OpenClaw owns conversations, agent state, scheduling, identity files, approvals,
and browser operation.

Library files come from OpenClaw's authorized session file APIs. Text previews are
limited to 256 KiB; local image, audio, and video previews/downloads can use its
asset API up to 1 MiB per file. Larger media returns a visible size-limit error.
The Gateway does not currently provide unrestricted binary artifact downloads.
Library discovery combines transcript file references and bounded workspace
search, including files created by command execution. Large workspace searches
can be truncated by OpenClaw's file-browser limits.

## Source requirement

The modified OpenClaw source lives at `./openclaw` and is versioned in this
repository alongside the frontend and deployment files. Its frozen
`pnpm-lock.yaml`, workspace packages, patches, plugins, licenses, and `HEADLESS.md`
are included; local credentials, dependencies, generated builds, and runtime state
are excluded. A Git checkout contains the build inputs. The Dockerfile copies and
builds this source; it never downloads an upstream replacement or uses an upstream
OpenClaw image. Commit and push later backend edits before redeploying in Coolify.
The complete app and backend must be committed and pushed before the first
Git-based Coolify import; changes present only on your workstation are unavailable
to the build server.

The image pins the same Node 24 and Bun images as this backend's Dockerfile.
OpenClaw requires Node `>=24.16.0 <25 || >=26.1.0` and pins pnpm `12.5.1` in its
`packageManager` field. Backend installs use the existing frozen pnpm lock; the
frontend uses `npm ci` and its existing npm lock. Do not use Node 25 for the
Gateway. The adapter uses native Node WebSocket support and has no npm dependencies.

## Deploy with Coolify

Import the Git repository as an Application and select **Docker Compose** as its
Build Pack. Use repository root `/` as Base Directory and `/compose.yaml` as Docker
Compose Location. Enable **Preserve Repository During Deployment** so the browser
seccomp profile remains available to Compose; keep Raw Compose Deployment disabled.
Set the domain for the `muse` service, for example `https://muse.example.com:3000`.
The suffix selects the internal container port; the public URL uses HTTPS port 443.

Coolify generates the app login password, session signing secret, and public URL
from the Compose variables. Find the generated password in the application's
Environment Variables, sign in, and add your provider/model in Settings. The named
volume retains OpenClaw and workspace data across redeployments. Coolify owns the
HTTPS proxy; no separate Caddy instance or host port mapping is needed.

See [the complete Coolify first-deployment guide](deploy/COOLIFY.md) for required
settings, generated credential names, resource requirements, and verification.

## Run on a VPS without Coolify

Install Docker Engine with Compose v2. Use an x86-64 or ARM64 Linux host supported
by the backend's native addons; allocate enough build memory (8 GB or build on a
larger machine and transfer the image). Chromium is included by default.

```sh
cp .env.example .env
```

Edit `.env` with a strong `MUSE_PASSWORD` and an independent random
`MUSE_SESSION_SECRET` (for example, generate each with `openssl rand -hex 32`).
These protect the app login and signed sessions. Keep `.env` private. Then:

```sh
docker compose -f compose.yaml -f compose.standalone.yaml build
docker compose -f compose.yaml -f compose.standalone.yaml up -d
docker compose -f compose.yaml -f compose.standalone.yaml logs --tail=100 muse
```

The standalone override binds to `127.0.0.1:3000` on the VPS. For a private first visit,
forward that port from your workstation:

```sh
ssh -L 3000:127.0.0.1:3000 user@your-vps
```

Open `http://localhost:3000`, sign in, and use Settings to add your provider
credentials and model, connect channels, and configure OpenClaw. The first boot
creates a local Gateway config without a provider credential. Chat becomes usable
after a valid provider/model is configured; there is no fabricated demo response.

For a public URL, point your DNS to the VPS, run an HTTPS reverse proxy such as
Caddy on the host, and adapt [deploy/Caddyfile.example](deploy/Caddyfile.example)
with your domain. Forward HTTP and WebSocket traffic to `127.0.0.1:3000` and set
`MUSE_PUBLIC_URL=https://your-domain` and `MUSE_SECURE_COOKIES=true` in `.env` before
recreating the app. The public URL allows the adapter to validate request origins
behind TLS termination. Keep ports 18789 and
browser CDP internal. The browser receives the app session; the Gateway token
stays on the server. The Compose file exposes only the app port.

The default container runs as UID/GID 1000, drops capabilities, and uses
`no-new-privileges`. The Chromium seccomp profile permits its user-namespace
sandbox; the host kernel/AppArmor policy must also support it. Browser sandbox
errors require a compatible host policy or a configured remote browser. See
[deploy/README.md](deploy/README.md). The app container does not mount the host
Docker socket; optional OpenClaw agent sandbox backends need separate setup.

## Persistence, updates, and recovery

The named `muse-data` volume stores `/data/openclaw` (config, credentials, sessions,
scheduled tasks, and other OpenClaw state), `/data/workspace` (identity, memory,
and agent-created files), and `/data/home` (tool state). Config is initialized only
when missing; boot preserves existing settings. Runtime arguments enforce a local
Gateway on port 18789 with token authentication. Change user settings through the
app; those deployment transport constraints stay managed by the supervisor.
Settings rejects removal of `gateway.mode=local` or a change to remote mode,
because the standalone Gateway's startup admission requires local mode.

`restart: unless-stopped` restarts the app after crashes and host reboots when the
Docker service starts. Tini and the supervisor terminate both services gracefully.
The container health check requires the adapter's Gateway connection and the
Gateway's canonical startup probe to be ready. Chat waits for background workspace
preparation while Settings remains accessible.
Docker marks a stalled container unhealthy but does not restart it solely because
of that status; monitor health and inspect logs. Reliable service still requires
a running VPS, available disk, valid provider credentials, and working networking.

Back up the complete named volume while the app is stopped so database and
workspace state are consistent. This example uses the standalone deployment;
for Coolify, use its backup tooling or the preserved application deployment
directory and generated environment:

```sh
docker compose -f compose.yaml -f compose.standalone.yaml stop muse
mkdir -p backups
docker compose -f compose.yaml -f compose.standalone.yaml run --rm --no-deps --entrypoint tar \
  -v "$PWD/backups:/backup" muse -czf /backup/openmuse-data.tgz -C /data .
docker compose -f compose.yaml -f compose.standalone.yaml start muse
```

The archive includes credentials: restrict its access and store it securely. If
the backup directory is not writable by UID 1000, grant that user access to this
specific directory before retrying. Do not change ownership of unrelated paths.
Rebuild after changing `web/`, `server/`, or your modified `openclaw/` checkout:

```sh
docker compose -f compose.yaml -f compose.standalone.yaml build
docker compose -f compose.yaml -f compose.standalone.yaml up -d
```

The same volume survives recreation. Take a backup before upgrades that migrate
state. Roll back an incompatible migration by restoring both the prior image and
its matching backup. `docker compose down` retains data; `down -v` deletes it.

## Local development and checks

Use a supported Node version. Build your modified backend with its own toolchain:

```sh
cd openclaw
pnpm install --frozen-lockfile
pnpm build
cd ../web
npm ci
npm run build
cd ..
```

Run the adapter and Gateway together with isolated local state:

```sh
export MUSE_PASSWORD='a-private-development-password'
export MUSE_SESSION_SECRET='a-private-development-session-signing-secret'
export OPENCLAW_DIR="$PWD/openclaw"
export OPENCLAW_STATE_DIR="$PWD/.openmuse-dev/openclaw"
export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
export OPENCLAW_WORKSPACE="$PWD/.openmuse-dev/workspace"
export MUSE_SERVER_ENTRY="$PWD/server/index.mjs"
export MUSE_HOST=127.0.0.1
node deploy/start.mjs
```

On PowerShell, set those variables with `$env:NAME = 'value'` instead of `export`;
use `npm.cmd` / `pnpm.cmd` if PowerShell policy blocks the launcher scripts. Open
the adapter at port 3000. For frontend editing, the Vite development server proxies
API requests to the adapter; rebuild `web/dist` when testing the production server.

```sh
node --test server/test/*.test.mjs deploy/start.test.mjs web/tests/*.test.mjs
npm --prefix web run build
npm --prefix web run lint
docker compose -f compose.yaml -f compose.standalone.yaml config --quiet
```

Before relying on an image in production, build it on your Linux Docker host and
check its first boot, login, provider-backed chat, approvals, browser launch,
scheduled task execution, and persistence after recreation. Container build and
runtime validation require a Docker daemon; source-level tests cannot prove those
host-dependent behaviors.

The frontend retains the demo's layout and serves its Inter font locally. Library
has Artifacts and Media; Goals manages OpenClaw schedules; Ideas and Feed are
intentionally empty. The right panel has Activity, Approvals, Browser, Daily goals,
and Identity, including formatted and editable `SOUL.md` and `MEMORY.md`. Settings
offers provider API keys, model selection, provider sign-in and guided setup,
connector management, channel QR connection, secret storage, permissions,
notifications, appearance, and the complete Gateway configuration schema.

Validation includes frontend build/lint, 35 adapter/bootstrap/stream tests,
desktop/mobile browser checks against synthetic Gateway fixtures, and a successful
runtime build of the modified OpenClaw under Node 24.16.0 using its `qaRuntime`
profile. An isolated real Gateway passed protocol-v4 authentication, app login and
startup readiness, conversation creation/history, identity updates, guarded
SOUL.md/MEMORY.md edits, settings/schema/model-catalog reads, disabled schedule
creation/update/deletion, a completed local system-event scheduled run, and
Library/secret-store listing. A native command approval also passed admission,
canonical session replay, rejection through the app, and terminal queue removal.
Full declaration builds,
provider-backed chat, and the Linux Docker image have not yet been verified.
The real frontend also loaded the Gateway's Library and settings schema, and its
managed Chrome browser opened a page, returned a snapshot, and displayed a
screenshot on Windows outside the shell sandbox. Linux container browser sandbox
and persistence-after-recreation checks still require a Docker host.
Public registry metadata confirms the pinned Node build and runtime images contain
Node 24.21.0 on Linux amd64 and arm64, meeting this fork's Node version floor.
That metadata check does not replace building and running the complete image.
