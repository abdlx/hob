# Phase 4 — production deployment validation

This phase executes the Linux/container checklist from
[`phase3_pipe_validation.md`](./phase3_pipe_validation.md) §6.3 against the image built
from the committed repository. Nothing was redesigned. The checks that failed were real
deployment defects and are listed in §3 with the fix that closed them.

Result of the validation run: **73/73 browser tests, 60/60 Hermes-tool checks, profile
persistence across a container restart, a zero-listener sandbox probe, and a clean
`docker compose stop` with exit code 0** — all inside the shipped image and the shipped
Compose hardening.

---

## 0. Verdict

**CONDITIONAL — the image and the deployed Compose configuration are verified. One
environment-specific check could not be executed: the browser sandbox on the production
host's Ubuntu 24.04 kernel/AppArmor policy.**

The production host (`vmi3433386`, Ubuntu 24.04.4, Docker 29.6.1) has
`kernel.apparmor_restrict_unprivileged_userns=1`, and an unconfined login shell cannot
create a user namespace:

```text
$ ssh alync 'unshare -Ur true; echo userns_exit=$?'
unshare: write failed /proc/self/uid_map: Operation not permitted
userns_exit=1
```

The shell has no Docker group membership and no passwordless sudo, so the production
container cannot be entered and the probe cannot be run there. The container image itself
passes the probe on a Linux Docker host where unprivileged user namespaces are available
(§2), and Chromium fails closed — it aborts rather than silently running without its
sandbox. Docker 29's built-in `docker-default` AppArmor profile is expected to grant
`userns`, but that expectation was not directly observed.

What is **not** claimed:

- that a browser has been launched inside the **live production container** on the 24.04
  host;
- that Coolify has finished replacing the running container (the push was made; the
  health endpoint is green, §6).

What would move this to **READY**: one authenticated dashboard action on
<https://hob.idkwihl.site> — open a bot's browser and confirm it starts and loads a page —
or, with host access:

```bash
docker compose exec --user hermes --env HOME=/opt/data muse \
  node /app/deploy/probe-browser.mjs
# expect: SANDBOX_OK (Chrome/…; zero TCP listeners; /opt/hermes/tools/chromium-1208/chrome-linux64/chrome)
```

If that fails on 24.04, the error is explicit (`No usable sandbox` / `SUID sandbox helper`).
The fix is host-level (Docker's `docker-default` profile or an AppArmor profile granting
`userns,`), never `--no-sandbox`.

---

## 1. What ran, and where

| Property | Value |
| --- | --- |
| Commit | `a6d8c9945a87521333da444d45b9f87cea0542d8` |
| Validation run | GitHub Actions run `39402625635`, job `118560809276`, conclusion **success** |
| Runner | `ubuntu-22.04`, Linux Docker daemon, 4 vCPU, 16 GiB, unprivileged user namespaces enabled |
| Image | built by `docker build -t openmuse:phase4 .` from that checkout |
| Base image | `ghcr.io/abdlx/hob-hermes-runtime:hermes-7e9eb8d9@sha256:18633293b436b15b8fb306cc065f9b86b21ddf4a9ac60601e07520044b6c00bc` |
| Chromium | `Chrome/145.0.7632.6` at `/opt/hermes/tools/chromium-1208/chrome-linux64/chrome` |
| Isolation | Compose project `openmuse-phase4-<random>`, loopback-only port, own named volume, synthetic password/session secret |
| Production data | none read, written, or used |

The harness is [`deploy/phase4-validation.mjs`](../../deploy/phase4-validation.mjs); it is
also runnable by hand with `node deploy/phase4-validation.mjs`, and by the
[`phase4-validation` workflow](../../.github/workflows/phase4-validation.yml). It never
touches a deployed stack: the project name, port and volume are unique to the run, the
port is bound to `127.0.0.1`, and the project is torn down with `docker compose down
--volumes`.

The validation used the deployment’s own `compose.yaml` (cap_drop ALL, the six runtime
capabilities, `no-new-privileges`, the repository seccomp profile, `shm_size: 1gb`,
`stop_grace_period: 40s`) with only image, project name and loopback port overridden.

---

## 2. Checklist results

### 2.1 Build the actual production image

`docker build` succeeded. The runtime layer is the pinned Hermes image digest above; the
application layers copy this repository (`server/`, `web/`, `deploy/`). The validation is
against the same Dockerfile and build context Coolify uses.

### 2.2 Sandbox, pipe, and the absence of a TCP door

```text
Sandbox/transport probe: SANDBOX_OK (Chrome/145.0.7632.6; zero TCP listeners; /opt/hermes/tools/chromium-1208/chrome-linux64/chrome)
```

The probe launches Chromium through the production path, with
`--remote-debugging-pipe`. It then opens `chrome://sandbox` over the pipe and requires:

- **Layer 1 Sandbox: Namespace** — enabled;
- **Seccomp-BPF Sandbox** — enabled;
- **zero TCP listeners** owned by any process whose command line contains the private
  profile directory, proven by intersecting `/proc/<pid>/fd` socket inodes with the
  LISTEN rows of `/proc/net/tcp` and `/proc/net/tcp6`;
- no `DevToolsActivePort` file.

The listener proof no longer depends on `ss`. This was a real defect: the image has no
`ss`, and the previous probe skipped the check while still printing “zero TCP
listeners” (§3, D1).

Chromium only reports **Layer 1 Sandbox: Namespace** as enabled when it actually created
the user namespace, so this is stronger evidence than a standalone `unshare --user
--map-root-user true`; the separate command was not needed. The runtime user is uid 10000
and the probe refuses to run as root.

### 2.3 Browser suite inside the container, pipe mode

```text
docker exec --user hermes --env HOME=/opt/data --env HOB_CDP_TRANSPORT=pipe <container> \
  sh -lc 'cd /app/server && node --test --test-reporter=spec \
    --test-timeout=180000 --test-concurrency=1 test/browser-*.test.mjs'
```

```text
tests 73 / pass 73 / fail 0 / cancelled 0 / skipped 0
```

The suite includes the transport and mux tests against real Chromium, the lease and
takeover matrix, the production no-TCP-door test, load/reliability tests, the manager,
registry, routes and policy tests. The new executable-discovery tests also ran (not
skipped) because this is Linux.

### 2.4 Real Hermes browser tools against the containerized application

```text
docker exec --user hermes --env HOME=/opt/data --env HERMES_REPO=/opt/hermes \
  --env HOB_CDP_TRANSPORT=pipe <container> \
  /opt/hermes/.venv/bin/python /app/server/e2e/hermes-tools-e2e.py
```

17 phases, **60/60 checks passed, 0 failures**, using Hermes’ own `browser_navigate`,
`browser_snapshot`, `browser_click`, `browser_type`, `browser_console`, `browser_cdp`, tabs,
reconnect, two bots, idle restart, crash recovery and human takeover. Phase 17 reported:

```text
[PASS] the dashboard reports the pipe transport  -> {"state": "running", "transport": "pipe"}
[PASS] no raw DevTools endpoint and no DevToolsActivePort anywhere  -> no listeners across 1 browser(s)
[PASS] at least one running browser was actually inspected  -> inspected=1
```

### 2.5 Persistent profile across a container restart

Phase 1 (`write`) opened a real `http://127.0.0.1:18794` origin through the managed
`BrowserManager`, wrote `localStorage.phase4 = "kept"`, and closed the browser gracefully.
`docker compose restart muse --timeout 40` replaced the process but kept the volume. Phase 2
(`read`) reopened the same profile and read the value back:

```text
Profile written: PROFILE_WRITTEN /opt/data/.phase4-profile/browsers/phase4/chromium
Profile survived the container restart: PROFILE_OK /opt/data/.phase4-profile/browsers/phase4/chromium
```

The fixed origin port matters: `localStorage` is keyed by scheme, host and port, so a new
random port after the restart would have proved nothing. The profile path is on the
`hermes-data` volume (`/opt/data`), not the container filesystem.

### 2.6 Resource measurements

`server/measure-browser.mjs` ran inside the container as uid 10000:

| Scenario | Browsers | Chromium processes | Chromium RSS (MiB) | Chromium CPU (%) | HOB server RSS (MiB) | HOB server CPU (%) | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| idle host, no browser | 0 | 0 | 0 | 0 | 64 | 0 | manager created, nothing launched |
| 1 browser, 1 agent connection, no viewer, static page | 1 | 11 | 997 | 0 | 70 | 0.2 | viewers=0 agents=1 |
| 1 browser, agent + 1 viewer, static page | 1 | 11 | 1006 | 0 | 71 | 0 | viewers=1 |
| 1 browser, agent + 2 viewers, static page | 1 | 11 | 1006 | 0 | 71 | 0 | viewers=2 |
| 1 browser, agent + 2 viewers, animating page (worst case) | 1 | 11 | 1032 | 83.3 | 75 | 2.3 | viewers=2 framesA=21 framesB=21 |
| 1 browser, agent only, animating page (no screencast) | 1 | 10 | 927 | 0 | 75 | 0 | viewers=0; compare with the scenario above |
| 2 browsers, one agent each, static pages | 2 | 21 | 1940 | 0 | 80 | 0.1 | separate pipes, tokens and profiles |
| both browsers stopped by the idle policy | 0 | 0 | 0 | 0 | 80 | 0 | alpha=stopped beta=stopped |
| 1 browser after a fresh start | 1 | 11 | 1015 | 0 | 81 | 0.1 |  |
| 1 browser after a crash and restart | 1 | 11 | 992 | 0 | 85 | 0.1 | state=running lastError=none |

Container cgroup snapshots (whole application, via `docker stats --no-stream`):

| Point | Memory | PIDs | CPU |
| --- | --- | --- | --- |
| idle, just after first boot | 354 MiB / 15.61 GiB | 43 | 109.05% (startup burst) |
| after the Hermes E2E | 446.5 MiB | 55 | 0.53% |
| after measurements | 441.1 MiB | 54 | 1.03% |

Reading these numbers:

- Each browser is **11 processes** (browser, renderers, GPU, utility, zygotes). The RSS
  column is the sum of their RSS, so shared pages are counted more than once; the unique
  cost is lower than ~1.0 GiB, but the sum is the conservative sizing figure.
- Two browsers cost ~1.94 GiB summed RSS. On the production host’s ~7.9 GB, budget about
  **three to four concurrently active browsers**, and cap bot concurrency accordingly.
- The screencast is the CPU cost: 83.3% of one core for two viewers on an animating page,
  versus 0% for the same browser with no viewer. The HOB server itself stayed at 2.3%.
- An idle application (no browser) is ~354 MiB at startup and settles around 440 MiB after
  a full workload. `/dev/shm` is 1 GiB per Compose service.

### 2.7 Graceful stop and orphans

After the measurements, the harness ran `docker compose stop --timeout 40` and inspected
the container:

```text
Graceful stop exit code: 0
No Chromium process survived the stop.
```

`docker ps` no longer lists the application container. The orphan check runs on the host
and matches real Chromium processes by `--user-data-dir=/opt/data`; the pattern is written
with a bracket (`[c]hrome`) so the checking shell itself cannot match. The app’s own
shutdown path is also exercised by the container recreation in the release smoke (the
`coolify-build` job), which passes on this commit.

### 2.8 Filesystem permissions and runtime users

```text
runtime uid=10000 data_owner=10000
Runtime service users: {"supervisor": [10000], "web": [10000], "gateway": [10000], "settings": [10000]}
```

- The probe refuses to run as root (`process.getuid() > 0`).
- `/opt/data` and the profile tree belong to uid 10000; the profile is created `0700` by the
  launcher.
- The supervisor, web server, gateway and settings service all run as uid 10000, not root.
- The container starts as root only long enough for s6 to drop the services; no application
  process retains privilege.

### 2.9 Container hardening

Parsed from `docker inspect .HostConfig` of the running container:

```text
Hardening verified: no privilege, cap drop ALL, no-new-privileges, errno seccomp, no Docker socket.
Capabilities granted: ["CAP_CHOWN","CAP_DAC_OVERRIDE","CAP_FOWNER","CAP_KILL","CAP_SETGID","CAP_SETUID"]
```

- `Privileged: false`; `CapDrop: ["ALL"]`; the six capabilities above are the only additions.
- `no-new-privileges` is set, so a setuid helper cannot elevate.
- The repository seccomp profile is loaded with `defaultAction: SCMP_ACT_ERRNO`.
- No `docker.sock` bind, no host PID/network namespace, no `--no-sandbox`.
- `agent-browser` is **not on `PATH`** in this image (`command -v agent-browser` is empty).
  Hermes resolves the CLI through its package manager (`pm.installed_package`); the 17-phase
  E2E proves the real tools work. The diagnostic is recorded so a future change that moves
  the CLI is noticed, not treated as a missing dependency.

### 2.10 Human takeover blocks both APIs

The container suite passed the takeover matrix, including:

```text
takeover: an id-less CDP command cannot mutate the page
takeover: a target session id cannot smuggle a mutation past the lease
takeover: capability injection requires the lease
takeover: in production the browser has no DevTools TCP door at all
  transport=pipe chromiumPort=null DevToolsActivePort=absent listeners=[]
takeover: an agent cannot freeze frames the person's page loads
takeover: the HTTP tab endpoint cannot open a page while the person is in control
lease: takeover waits for an in-flight agent command and never interleaves
```

The live E2E independently shows both layers refusing while the person holds control:

```text
[PASS] the person holds control
[PASS] the refusal is reported to the bot rather than hanging
  -> CDP error (Page.navigate): Browser control is held by the human operator. "Page.navigate" was not sent to the browser.
[PASS] raw CDP is refused loudly
  -> CDP error: {'code': -32001, 'message': 'Browser control is held by the human operator. ...'}
```

The high-level refusal is the Hermes tool, the raw refusal is a direct CDP call; both stop
at the same lease. The person can still drive the page, and control returns to the agent
afterwards.

---

## 3. Defects found and fixed

All fixes are minimal, covered by tests, and are in the validated commit.

### D1 — the sandbox probe could claim a listener proof it had not performed

`deploy/probe-browser.mjs` used `pgrep` plus `ss -ltnp`. The production image has **no
`ss`** (iproute2 is not installed), so the probe printed a `PROBE_NOTE` and skipped the
listener check, then still printed `SANDBOX_OK (…; zero TCP listeners)`. The release smoke
also asserted the bare string `SANDBOX_OK`, which Phase 3 had changed, so CI failed — and
that failure exposed the vacuous proof.

Fix: the probe now finds the browser’s PIDs and socket inodes from `/proc`, intersects them
with the LISTEN rows of `/proc/net/tcp` and `/proc/net/tcp6`, and **fails** if it cannot
prove the result. No external binary is required. The smoke and the Phase 4 harness assert
the detailed line, including the resolved executable. Tests: `deploy/probe-browser.mjs` is
the gate; the smoke runs it in the image.

### D2 — HOB could not find the browser in its own image

The launcher’s Linux candidates only knew `root/chrome`, `root/chrome-linux/chrome` and
`root/<name>`. The shipped image installs Chrome for Testing at
`/opt/hermes/tools/chromium-1208/chrome-linux64/chrome`. On Linux, HOB would have reported
“install Chromium” even though Chromium was present. The old probe hid this by searching
recursively with its own logic, so the probe and the product disagreed.

Fix: new dependency-free `server/browser-executable.mjs` owns discovery. It knows the
revisioned `chrome-linux`/`chrome-linux64` layouts and falls back to a bounded search
(depth 4) for an unknown layout. `browser-launcher.mjs` re-exports the resolver, and the
container probe imports the same module, so the probe cannot pass with a layout the
application cannot launch. Tests: `server/test/browser-launcher.test.mjs` (candidate list,
`chrome-linux64` resolution, unknown-layout fallback). Verified in the image:
`SANDBOX_OK (…; /opt/hermes/tools/chromium-1208/chrome-linux64/chrome)`.

### D3 — two container-only test races

- The fallback test asserted that `resolveChromiumExecutable()` returns a temporary layout,
  but on a host that also has `/opt/hermes/tools` the fixed candidates correctly win first.
  The test now asserts the bounded fallback directly.
- The pipe-drop test issued a browser-level internal request and immediately killed
  Chromium; on Chrome 145 the request could resolve before the kill. On POSIX the child is
  now stopped with `SIGSTOP` so the request is deterministically in flight; the client-side
  never-settling promise still covers the close path.

Commit sequence: `7f02303c` (harness and proof), `1cd12d08` (resolver), `032fd8ae` (surface
test output), `8c4701ef` (deterministic tests), `a6d8c994` (orphan self-match). The
validation run above is on `a6d8c994`.

---

## 4. Production deployment

`main` was advanced from `8df33757` to `a6d8c994` (fast-forward, push exit 0). That push
triggers:

- the `Coolify image first run` workflow, which rebuilds the image and reruns
  `deploy/smoke-container.mjs` (first boot, probe, recreation persistence, hardening,
  provider fixture) — run `39403740927`, conclusion **success**;
- Coolify’s auto-deploy, which rebuilds the same image and recreates the stack.

`https://hob.idkwihl.site/healthz` returned `200 {"ok":true,"gatewayConnected":true}`
before and after the push. Deployment pickup cannot be read from GitHub (Coolify has no
public deployment endpoint), and there are no dashboard credentials in this environment.

What the deployment inherits from this validation: the **image content** is the validated
one (same commit, same Dockerfile, same base digest), the **Compose hardening** is the one
tested, and the **Chromium resolver** is fixed. What it does not inherit: proof that the
24.04 host’s AppArmor policy permits the namespace sandbox (§0).

---

## 5. Remaining gaps, precisely

| Gap | Why it remains | How to close it |
| --- | --- | --- |
| Browser sandbox on the production host (Ubuntu 24.04, AppArmor `userns` restriction) | No Docker group, no sudo on the host; the container cannot be entered; an unconfined shell cannot create a user namespace | One dashboard browser launch, or run the probe on the host; expect `SANDBOX_OK`; if it fails, use Docker 29’s default profile or a host AppArmor profile granting `userns,` — never disable the sandbox |
| Coolify deployment pickup | No public Coolify status; no credentials | Confirm the container’s image/restart time in Coolify, or `docker inspect` on the host |
| Long-horizon profile growth | Measured across restarts, not weeks | Re-measure profile size periodically; the 0700 profile directory is on the persistent volume |
| `browser.controller.register` over `/api/ws` | Pre-existing and deliberately unused; the gateway owns session registration | Out of scope for this phase (unchanged by it) |

The `contabo` host was excluded from this phase because its SSH host key changed; it was
not used for any check.

---

## 6. Reproduction

On any Linux host with Docker (no sandbox bypass, no external infrastructure):

```bash
node deploy/phase4-validation.mjs
```

It builds `openmuse:phase4`, starts an isolated Compose project, and runs:

1. hardening and capability inspection;
2. `probe-browser.mjs` as uid 10000 (sandbox layers + zero listeners + executable);
3. runtime-user and `/opt/data` ownership checks;
4. the full browser suite in pipe mode;
5. the 17-phase Hermes E2E with `HERMES_REPO=/opt/hermes`;
6. profile write → `docker compose restart` → read (`localStorage`);
7. `measure-browser.mjs` plus `docker stats` snapshots;
8. `docker compose stop`, exit-code assertion, and the host orphan check.

`PHASE4_SKIP_BUILD=1` reuses an existing `openmuse:phase4`; `PHASE4_IMAGE` overrides the
tag. The workflow is `.github/workflows/phase4-validation.yml` (manual dispatch, or push to
`phase4-validation`). Artifacts for this report: run `39402625635`, job `118560809276`,
commit `a6d8c994`.
