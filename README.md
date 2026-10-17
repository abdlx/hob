# hob

A custom dashboard backed by upstream Hermes Agent. Hermes owns agent execution,
tools, profiles, memory, skills and model integrations. The application owns its
interface, login and adapter. Hermes source is not patched.

This migration is still in progress. Real local Hermes has passed setup, separate
bot/session storage, streaming chat and a tool write against a deterministic local
model simulation. Linux image build, first boot and container recreation now pass
the [container smoke workflow](https://github.com/abdlx/hob/actions/runs/39036456635)
at `1dd39956`, including service UID checks and an isolated Chromium sandbox probe.
A real provider account has not been exercised.
Dashboard chat now uses Hermes' authenticated native session interface. Questions,
generation-bound controls and active work survive adapter reconnection. Older API
conversations remain available as read-only history. HTTP task references retain
their separate recovery path. Explicit groups now use native Hermes room workers,
with separate member sessions and shared history. Native group approval/denial,
in-flight cancellation and active-member removal have local verification. Full
setup UX, real-provider use and production deployment still need work.

Goals, Library, Workshop and the identity panel now use native Hermes scheduling,
workspace files, skills, pending skill reviews, personality and memory APIs.
The Browser panel sends a browsing request through the selected bot's native
chat/tools. Bot turns and unsent drafts can remain independent while switching
between conversations. These local changes require rebuilding/restarting an
existing deployment before its dashboard can use the migrated actions.

Dashboard routing uses the authenticated server runtime, independently of optional
bot metadata. Unknown runtime responses stop initialization with a retry action;
they never select OpenClaw implicitly. A stale dashboard's legacy requests are
rejected before OpenClaw RPC. Rebuild/redeploy the server and frontend together,
then reload the browser if an existing installation still displays legacy actions.

## Runtime boundary

The Dockerfile extends a public, digest-pinned `ghcr.io/abdlx/hob-hermes-runtime`
image built with upstream Hermes' own Dockerfile at commit
`7e9eb8d9a30f4a9bb9f8ecaf816b4b0ffdf47357`. The published official v0.22.2 image
lacks the native session authority this adapter requires. The runtime image is
currently **Linux amd64 only**. It preserves the upstream entrypoint, runtime,
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
2. Select **Main** and choose a provider from its native catalog. Save its API key
   under the suggested credential name, or use **Provider accounts** for a
   supported device sign-in. External CLI-only account flows are labeled explicitly.
3. Choose or enter an available model, then select it. For a custom/local endpoint,
   choose **Custom compatible endpoint**, enter its URL, a distinct
   endpoint name and its own key if needed. Confirm any model warning explicitly.
4. Start a new conversation and verify a reply and a tool task.
5. Create additional bots deliberately through Settings, configure their
   credentials/model, and select a bot in the chat header. Incomplete bot setup
   remains visible in Settings for an explicit retry; it does not activate silently.

**Tools & providers** supplies native toolset choices, provider credential forms
and explicit dependency setup. **Messaging channels** supplies each platform's
fields and allowed-user IDs. Saving fields does not connect a channel; connecting
is a separate confirmed action. Managed deployment listeners are excluded.
The advanced native config editor submits only edits and masks known credential
fields. **MCP servers** provides confirmed HTTP/bearer and local-executable setup,
enable/disable/remove and native connection/tool probes for each bot. Local
executables run on the Hermes host; profile separation is not an execution sandbox.
For a remote MCP server supporting OAuth registration, choose **OAuth sign-in**,
save the server, then select **Sign in to MCP server** on its card. Confirm the
attempt, review the authorization provider's page, and return to Settings for
status and connection testing. `MUSE_PUBLIC_URL` must name this dashboard's origin.
Closing an attempt does not disconnect credentials already saved by Hermes.
Pre-registered clients with a vendor-fixed loopback callback are not automated
through this hosted flow. **Memory providers** exposes native provider fields,
masked credentials, explicit dependency setup and confirmed provider selection
for the selected bot. Saving provider fields can also select that provider; the
confirmation states this before submission. Built-in memory remains available,
and selecting it again does not delete external data or stored credentials.
External projects/namespaces can share data across bots if configured identically;
choose separate partitions when independent external memory is required. Existing
sessions may need restarting after a provider change. Dependency setup submits no
unsaved form fields and may install packages on the Hermes host.
External account CLI flows, QR onboarding and actual vendor interoperability
still need work. MCP OAuth has
real-runtime verification against an isolated simulated provider; its rendered
UI interaction and real vendor sign-in remain unverified.

## Persistence and upgrades

The new `hermes-data` volume mounts at `/opt/data`. It contains Hermes state and
the application's private listener credentials and operator-created bot roster
under `.hob/`. Each enrolled bot has its own listener key. Existing configuration
bytes and listener credentials survive normal restarts. Native profiles found
outside this roster are preserved but are not automatically added as dashboard bots.

An older OpenClaw `muse-data` volume is not mounted or migrated by the new
configuration. Docker retains it; do not delete it if it contains needed history.

The upstream entrypoint initializes storage as root, then drops application/runtime
processes to its Hermes user. Compose grants only the initialization capabilities
listed in `compose.yaml`; it does not mount the Docker socket.

Back up the complete Hermes volume while stopped and keep the backup private.
Upgrade by changing the runtime image digest, building a candidate, testing it
against a copy of your data, and then promoting it. Do not use an in-container
source updater. The adapter reduces coupling but does not guarantee that every
future upstream version will be compatible without testing.

## Development and verification

The server uses Node's built-in HTTP and test APIs. The frontend uses its existing
npm lockfile.

```sh
node --test server/test/hermes-*.test.mjs deploy/*.test.mjs
node --test web/tests/*.test.mjs
cd web
npm ci
npm run lint
npm run build
```

For local native runtime testing, provision Hermes with its package manager in an
isolated home with the `web` and `messaging` extras, and activate that environment.
The supervisor uses `hermes` from
PATH, or `HERMES_EXECUTABLE` when explicitly supplied. Set an isolated
`HERMES_HOME` and the application login variables before running
`node deploy/start.mjs`.

See [the current implementation checkpoint](Hermes-Integration-Checkpoint.md)
for actual test results, known gaps and remaining work. No model response or
successful deployment is fabricated when the backend is unavailable.
