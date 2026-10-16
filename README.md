# hob

A custom dashboard backed by upstream Hermes Agent. Hermes owns agent execution,
tools, profiles, memory, skills and model integrations. The application owns its
interface, login and adapter. Hermes source is not patched.

This migration is still in progress. Chat and setup have adapter tests; a real
Hermes/model task and Linux container boot still need verification. Group chats,
durable run recovery and several older dashboard sections are not finished.

## Runtime boundary

The Dockerfile extends a digest-pinned official
`nousresearch/hermes-agent` image. It preserves the upstream entrypoint, runtime,
package manager and privilege drop, and adds the custom UI and server. It does
not copy the local `hermes-agent/` reference or archived OpenClaw sources.

Only port 3000 serves the custom application. Hermes' runtime API on 8642 and
settings API on 8080 bind to loopback. The supervisor provisions their credentials
and keeps them server-side. Model and tool credentials are entered in Settings.

## Deploy with Coolify

Create a Docker Compose application for this repository using `compose.yaml`.
Enable **Preserve Repository During Deployment**, which keeps the repository's
Chromium seccomp profile available to Compose. Assign a domain to the `muse`
service at port 3000.

Coolify generates `SERVICE_PASSWORD_64_MUSE` and
`SERVICE_REALBASE64_64_MUSE`. Use the generated password to sign in. If a reverse
proxy needs an explicit origin, set `MUSE_PUBLIC_URL` to the exact HTTPS origin.

See [Coolify deployment](deploy/COOLIFY.md).

## Run without Coolify

Use Docker Engine with Compose v2 on Linux. Copy the public template:

```sh
cp .env.example .env
```

Set a strong `MUSE_PASSWORD` and an independent `MUSE_SESSION_SECRET` in your
private file, then run:

```sh
docker compose -f compose.yaml -f compose.standalone.yaml build
docker compose -f compose.yaml -f compose.standalone.yaml up -d
docker compose -f compose.yaml -f compose.standalone.yaml logs --tail=100 muse
```

The standalone overlay binds to `127.0.0.1:3000`. For a VPS, forward that port:

```sh
ssh -L 3000:127.0.0.1:3000 user@your-vps
```

Open `http://localhost:3000`. For public access, configure your HTTPS reverse
proxy and set `MUSE_PUBLIC_URL` and `MUSE_SECURE_COOKIES=true`.
[Deployment details](deploy/README.md) cover storage, health and updates.

## First-run setup

1. Sign in and open **Settings**.
2. Select **Main**. Save the provider's API key under its Hermes credential name,
   such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.
3. Enter the Hermes provider identifier and your available model identifier;
   select the model.
4. Start a new conversation and verify a reply and a tool task.
5. Create additional bots deliberately through Settings, configure their
   credentials/model, and select a bot in the chat header.

The native config editor submits only edits and masks known credential fields.
The current editor is not a complete guided onboarding experience; richer
configuration forms and the remaining feature surfaces are part of this migration.

## Persistence and upgrades

The new `hermes-data` volume mounts at `/opt/data`. It contains Hermes state and
the application's private listener credentials under `.hob/`. Existing
configuration bytes and listener credentials survive normal restarts.

An older OpenClaw `muse-data` volume is not mounted or migrated by the new
configuration. Docker retains it; do not delete it if it contains needed history.

The official image initializes storage as root, then drops application/runtime
processes to its Hermes user. Compose grants only the initialization capabilities
listed in `compose.yaml`; it does not mount the Docker socket.

Back up the complete Hermes volume while stopped and keep the backup private.
Upgrade by changing the official image digest, building a candidate, testing it
against a copy of your data, and then promoting it. Do not use an in-container
source updater. The adapter reduces coupling but does not guarantee that every
future upstream version will be compatible without testing.

## Development and verification

The server uses Node's built-in HTTP and test APIs. The frontend uses its existing
npm lockfile.

```sh
node --test server/test/hermes-*.test.mjs deploy/start.test.mjs
node --test web/tests/*.test.mjs
cd web
npm ci
npm run lint
npm run build
```

For local native runtime testing, provision Hermes with its package manager in an
isolated home and activate that environment. The supervisor uses `hermes` from
PATH, or `HERMES_EXECUTABLE` when explicitly supplied. Set an isolated
`HERMES_HOME` and the application login variables before running
`node deploy/start.mjs`.

See [the current implementation checkpoint](Hermes-Integration-Checkpoint.md)
for actual test results, known gaps and remaining work. No model response or
successful deployment is fabricated when the backend is unavailable.
