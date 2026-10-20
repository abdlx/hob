# Production Hardening, Security Audit & Reliability Validation

**Subsystem:** the HOB-managed persistent browser (Hermes native browser tools → HOB CDP
gateway → HOB-launched persistent Chromium → Atrium viewer).

**Phase:** 2 — hardening of the Phase-1 implementation. Phase 1 proved the architecture
end to end; this phase attacks it, fixes what the attacks found, measures it, and states
what is still not safe to claim.

**Hermes:** unmodified. Every check below runs the real Hermes browser tools
(`browser_navigate`, `browser_snapshot`, `browser_type`, `browser_click`, `browser_console`,
`browser_cdp`) against the real `agent-browser` CLI. No file under `hermes-agent/` was
changed.

---

## 0. Verdict

**CONDITIONAL — ready for a single-operator or trusted-tenant deployment; not yet
"READY" unconditionally, for one architectural reason.**

One finding could not be fixed without redesigning the transport, and it is the one that
matters most:

> **A process running on the same host as the gateway can open Chromium's own DevTools
> port directly and bypass the control lease entirely.** (`H1`)

That is real, it is reproducible in one command, and it is *not* a bug in the lease — the
lease is enforced by the only thing in the chain that can enforce it, the gateway, and a
client that skips the gateway skips the lease. Hermes ships `terminal_tool.py` and
`code_execution_tool.py`, so a bot with those tools enabled can reach `127.0.0.1`. The
gateway still makes the port hard to *find* and impossible to reach from off-host, and
that is where the mitigation stops. Section 2.1 states exactly what a deployment has to
accept, and section 9 lists the three conditions for moving the verdict to READY.

Everything else found in the audit is fixed and covered by a regression test, including a
real bug that would have frozen the person's page during a takeover (`H4`), a real
limitation from Phase 1 that turned out to be fixable with a supported Chromium switch
(`H7`: session cookies now survive a restart), and — found by the suite itself rather than
by reading the code — a lifecycle race that leaked a whole browser process whenever a stop
landed while a launch was in flight (`H8`).

> **Update — Phase 3 (the finding above is closed).** HOB now launches Chromium with
> `--remote-debugging-pipe` by default and multiplexes every client onto that pipe. There is
> no DevTools TCP port and no `DevToolsActivePort` file, so the bypass described in §2.1 no
> longer has an address to connect to. The design, the adversarial re-validation and the
> Linux/container status are in `phase3_pipe_validation.md`. The verdict in this section is
> kept as the Phase 2 record; the TCP transport still exists only as an explicitly
> configured development fallback (`HOB_CDP_TRANSPORT=tcp`).

---

## 1. What was audited, and how

| Area | Files | How it was checked |
| --- | --- | --- |
| CDP authorization and classification | `browser-policy.mjs`, `browser-gateway.mjs` | allow-list read line by line; classification pinned by test; adversarial probes against a real Chromium |
| Takeover bypass | `browser-lease.mjs`, `browser-gateway.mjs` | raw CDP, nested sessions, target attachment, id-less frames, indirect mutation — all tried against a live browser |
| Cross-bot isolation | `browser-registry.mjs`, `browser-manager.mjs` | two live bots, separate ports/tokens/profiles/pages |
| WebSocket auth | `browser-routes.mjs` | ticket TTL, single use, replay, forged ticket, no-ticket, cookie reconnect, cross-site origin |
| Credential exposure | `browser-routes.mjs`, `browser-gateway.mjs` | dashboard payload, viewer URL, gateway response bodies, logs, error text |
| Unauthorized profile access / path traversal | `browser-registry.mjs`, `browser-routes.mjs` | bot-id grammar, malformed ids, absolute paths, `..`, unknown bots |
| Input validation, rate/size bounds | `browser-gateway.mjs`, `browser-routes.mjs` | frame size, ticket map, viewer cap, malformed frames, unknown message types |
| Process and lifecycle safety | `browser-launcher.mjs`, `browser-manager.mjs` | flags, sandbox, port discovery, ownership, crash handling, idle shutdown |
| Deployment | `Dockerfile`, `compose.yaml`, `deploy/` | static inspection + the repository's own container probes (Docker unavailable on this host — see §5) |

Method note: "observational" is not inferred from a method's name. Every entry in the
observation allow-list was read against its CDP semantics, and the classification is
pinned by a test that fails if a method changes side (`browser-takeover-bypass.test.mjs`,
`browser-policy.test.mjs`).

---

## 2. Findings

| ID | Severity | Finding | State |
| --- | --- | --- | --- |
| H1 | **High** | Raw loopback DevTools port bypasses the lease | **Fixed** (Phase 3: `--remote-debugging-pipe`; see `phase3_pipe_validation.md`) |
| H2 | Medium | CDP commands without an `id` were forwarded with no policy check | **Fixed** |
| H3 | Medium | Capability injection classified as observational | **Fixed** |
| H4 | Medium | Auto-attach could freeze the person's page during a takeover | **Fixed** |
| H5 | Medium | Viewer tickets were replayable for 15 minutes | **Fixed** |
| H6 | Low | Unbounded CDP frame size (memory DoS) | **Fixed** |
| H7 | Medium | Session cookies were lost on every restart | **Fixed** |
| H8 | **High** | A browser launched while a stop was in flight was never killed | **Fixed** |

### 2.1 H1 — the raw DevTools port bypasses the lease (fixed in Phase 3)

**What happens.** HOB gives each bot a persistent Chromium with
`--remote-debugging-port=0 --remote-debugging-address=127.0.0.1`. The port is published
in `<profile>/DevToolsActivePort`. Any process on the host can read that file, connect
to the port, and speak CDP directly — no gateway, no lease, no policy.

**Verified, not assumed** (`test/browser-takeover-bypass.test.mjs`, plus a live probe):

- with a person holding control, `Page.navigate` through the gateway is refused with
  `-32001` and the page does not change;
- the same command sent straight to `http://127.0.0.1:<port>` **changes the page**
  (`document.title = 'VIA-RAWPORT'` was observed on the live page);
- the port answers on `127.0.0.1` only: a test enumerates the host's non-loopback IPv4
  addresses and connects to each; every attempt is refused (`t.diagnostic` records this
  in the test output).

**Why it was not fixed in Phase 2.** The correct fix is `--remote-debugging-pipe`, which
removes the TCP port entirely. It was investigated and rejected *for that phase* on
evidence: tracing a live Hermes/`agent-browser` session (129 CDP commands) shows each
client depends on **per-connection browser-level state** — `Target.setAutoAttach`,
`Target.setDiscoverTargets`, `Fetch.enable`, `Page.addScriptToEvaluateOnNewDocument`,
`Runtime.runIfWaitingForDebugger`. A single pipe is exactly one browser-level CDP
session, so multiplexing several clients onto it without a design would merge their event
streams and their enable-set state: one client's `Fetch.enable` would intercept the other's
traffic, and one client's auto-attach would steal the other's targets. Multi-client
operation is a requirement (the live scenario runs two agent clients and up to eight
viewers), so the pipe needed a per-client multiplexer, which was made the next phase.

**Fix (Phase 3).** `server/browser-pipe.mjs` terminates each client's CDP session and
re-implements the browser-level state on top of one pipe: per-client id spaces, per-client
virtual session ids for auto-attached targets, aggregated `setAutoAttach`/`setDiscoverTargets`,
per-client event routing by ownership, bounded queues, and explicit backpressure. Chromium
is launched with `--remote-debugging-pipe` and **no** `--remote-debugging-port`; there is no
`DevToolsActivePort` file and no listener. The H1 test in
`test/browser-takeover-bypass.test.mjs` was rewritten from "the port is loopback-only" to
"the browser has no DevTools TCP door at all": it asserts `chromiumPort === null`, no
`DevToolsActivePort`, and zero listening sockets in the browser's process tree, and fails if
any of those appear. The same suite run in the TCP fallback prints
`chromiumPort=54055 DevToolsActivePort=54055 listeners=[54055]`, which is what the assertion
is refusing.

**What a deployment must accept now.** The loopback trust assumption is gone from the
default configuration. A process that can read a bot's profile directory can no longer
speak CDP to that bot's browser at all — HOB holds the only channel. Two residuals remain,
both documented in `phase3_pipe_validation.md` §9: the explicit `HOB_CDP_TRANSPORT=tcp`
development fallback restores the old port (it is off by default and must not be used in
production), and the agent's own shell can still ask the *gateway* to act through the
lease-limited, policy-checked path, which is the intended design.

### 2.2 H2 — id-less commands were forwarded unchecked (fixed)

`message.method === undefined || message.id === undefined` used to fall through to
`this.#forward(text)`, so **a message that named a real CDP method but carried no `id` was
proxied to Chromium with no classification and no lease check**.

Probed against Chromium 155: an id-less `Runtime.evaluate` is *ignored* by the browser, so
this was not a live page mutation — the hole was in HOB's own gate, not in Chromium's
behaviour. That is exactly the kind of thing that changes without notice, so it was closed
rather than relied upon.

Now the gateway refuses it explicitly:

```json
{"id":null,"error":{"code":-32001,
  "message":"The gateway requires a CDP command id. \"Runtime.evaluate\" was not sent to the browser."}}
```

Regression: `takeover: an id-less CDP command cannot mutate the page` (asserts the page is
unchanged *and* that the refusal is explicit). A check of all 129 traced commands from
real clients found zero id-less commands, so no client regressed.

### 2.3 H3 — capability injection was classified as observational (fixed)

Four methods were listed as read-only and are not. They were removed from the observation
allow-list and are now mutations (refused during a human takeover):

| Method | Why it is not observational |
| --- | --- |
| `Target.exposeDevToolsProtocol` | injects a CDP-sending binding into the page: a scripting console by proxy |
| `Target.setAutoAttach` | auto-attaches into new targets, including cross-site iframes |
| `Log.clear` | destroys the evidence an operator is looking at |
| `DOM.setInspectedNode` | mutates inspector state |

`Target.attachToTarget`, `detachFromTarget`, `setDiscoverTargets` and
`receiveMessageFromTarget` stay observational because classification is **session-agnostic**:
a mutation sent *with* a target `sessionId` is still gated by the lease. That claim is not
reasoning alone — `takeover: a target session id cannot smuggle a mutation past the lease`
attaches to a target and sends a mutation with its `sessionId`, and the gateway refuses it.

### 2.4 H4 — auto-attach could freeze the person's page (fixed)

`Target.setAutoAttach({waitForDebuggerOnStart: true})` leaves every newly created target
suspended until someone calls `Runtime.runIfWaitingForDebugger`. Real clients request
exactly that (observed in live traffic), so:

1. the person takes control;
2. the page they are driving creates a new target (a cross-site iframe, a popup);
3. the new frame starts up **suspended**, waiting for a resume;
4. the resume is a mutation, and mutations are refused while the person holds control.

Result: the person's page hangs on a frozen frame with no way to fix it from the UI.
Probe evidence: a real out-of-process iframe reported `waitingForDebugger: true`; a
browser-level new page target did too.

**Fix.** The gateway now remembers auto-attach state per session and, *while a human holds
control*, rewrites `waitForDebuggerOnStart` to `false` (the attach still happens, so
clients keep their target events and reads). On a successful handover to a human it also
re-issues `Target.setAutoAttach({..., waitForDebuggerOnStart: false})` for each session
that had it on, so targets created before the takeover are un-suspended too. Gateway-issued
neutralisers use negative ids (`INTERNAL_ID_BASE = -100000`) and their replies are
swallowed, so they can never be mistaken for client traffic.

Regression: `takeover: an agent cannot freeze frames the person's page loads` — two cases
(rewrite during control, neutralise across a handover). The test was proven load-bearing:
with the fix disabled it fails with `actual: ['iframe']`.

### 2.5 H5 — viewer tickets were replayable (fixed)

A viewer ticket was valid for its whole 15-minute TTL and could be presented any number of
times. A ticket that leaked — into a proxy log, a screenshot, a `Referer`, a crash report —
stayed usable. Tickets are now **single-use**: `redeemTicket` deletes the ticket on first
use. The intended reconnect path is unchanged and deliberate: a tab that reloads has no
live ticket, so it is authenticated by its **same-origin session cookie**, which
`assertOrigin` has already proven cannot be sent by a cross-site page.

Regression: `browser routes: a viewer ticket is single-use and cannot be replayed` (fresh
ticket opens + `hello`; replay refused; spent ticket **plus** session cookie reconnects;
new ticket works). Live: E2E phase 10.

### 2.6 H6 — unbounded WebSocket frames (fixed)

`maxPayload: 0` (no limit) on both the agent WebSocket server and the upstream Chromium
socket let a peer force HOB to allocate an arbitrary amount of memory. Both are now capped
at `MAX_CDP_FRAME = 64 MiB`, far above any real CDP message (the largest observed is a
screencast frame or a full-page snapshot).

### 2.7 H7 — session cookies were lost on every restart (fixed, new)

Phase 1 recorded this as a Chromium limitation. It is, but it is a *switchable* one, and
the switch is supported. Full write-up in §4. In short:

- **Root cause:** Chromium only loads *session* cookies from the profile when it is told to
  restore the last session (`ShouldRestoreOldSessionCookies()`); otherwise it discards
  them at shutdown, by design.
- **Fix:** launch with `--restore-last-session`, and delete the saved *tab* state
  (`Sessions/`, `Last Session`, …) before each launch so a restart still comes back with
  one clean page instead of yesterday's window. The cookie jar is a different file and is
  untouched.
- **Verified:** clean restart → session cookie present; without the switch → absent; a
  hard kill loses even durable cookies (which is why the graceful close stays).

### 2.8 H8 — a browser launched during a stop was never killed (fixed, found by the suite)

This one was not found by reading the code. It was found by asking why
`browser-routes.test.mjs` finished all seven of its tests and then **never exited**, which
is what made a whole-suite run sit for tens of minutes instead of printing a summary. The
first suspect — the `/activity` SSE heartbeat, a 20-second `setInterval` — was unref'd
(which is correct on its own merits: a liveness trickle must never be a reason for a
process to stay alive), and the file still hung. Naming the live handles at the end of the
test process gave the answer in one run:

```
ChildProcess { pid: 22264, file: 'C:\Program Files\Google\Chrome\Application\chrome.exe',
               args: ['--headless=new', '--remote-debugging-port=0', ...],
               exitCode: null, killed: false }
```

A real Chromium, still running after every test had torn its browser down.

**Why.** `#ensureChromium()` records the launched browser *after* the launch resolves, and
`BrowserSession.stop()` killed `this.#chromium` — which is still `null` while a launch is in
flight. So this race leaked a browser **permanently**:

1. a first viewer (or agent) connection calls `start()`, and the launch is in flight;
2. the idle policy, or a host shutdown, calls `stop()` before it lands;
3. `stop()` sees no browser, tears the rest down and returns;
4. the launch lands afterwards and installs a browser that nothing owns any more —
   no viewer, no agent, no idle sweep (the session was already dropped from the manager),
   holding a profile directory and a process slot for the life of the host.

The user-visible version of that is worse than a stuck test: **a container or service
restart could leave an orphaned Chromium holding a profile lock, and the host would not
shut down.** It is also the shape of bug that only appears under concurrency, which is
exactly why it survived Phase 1.

**Fix.** A launch epoch. Every `stop()` bumps `#launchEpoch`; a launch captures the epoch
it started under, and if it lands with a stale one it closes the browser it just started
and rejects instead of reporting success. `stop()` additionally awaits any in-flight launch
(bounded by the launcher's own timeouts) so it never returns with a child on the way.

**Regression:** `manager: a browser that starts while a stop is in flight is not left
behind` — deterministic (`start()` is not awaited, so the launch is always in flight when
`stop()` runs), and it asserts the *process* is gone by counting `chrome.exe` processes
that carry the profile directory in their command line, not merely that bookkeeping looks
right. Proven load-bearing: with the epoch check disabled the test fails with
`actual: 'started'` and leaves eight Chromium processes behind.

---

## 3. Takeover: the adversarial stress matrix

Every row below was exercised. "Test" names the file in `server/test/`; "E2E" refers to
`server/e2e/hermes-tools-e2e.py`, driven by the real Hermes tools.

| Attack / scenario | Expected | Evidence |
| --- | --- | --- |
| Command in flight when a takeover is requested | handover waits for it to finish; never interleaves | `lease: takeover waits for an in-flight agent command and never interleaves` |
| Concurrent agent commands during human control | they queue, then resume on handback | `lease: agent mutations queue during human control and resume on handback` |
| Queue that never drains | bounded wait, then a structured refusal (not a hang) | `lease: a bounded wait turns into a structured refusal, not a hang`; E2E phase 3 asserts `"success": false` |
| `Runtime.evaluate` with no `id` | refused, page unchanged | `takeover: an id-less CDP command cannot mutate the page` |
| Mutation smuggled with a target `sessionId` | refused | `takeover: a target session id cannot smuggle a mutation past the lease` |
| Capability injection (`exposeDevToolsProtocol`, `setAutoAttach`) | refused while the human holds control | `takeover: capability injection requires the lease` |
| Freezing the person's frames via `waitForDebuggerOnStart` | newly created frames run | `takeover: an agent cannot freeze frames the person's page loads` |
| Multiple attached targets | the page a mutation lands on is still gated | same test as above (an attached iframe target is the delivery vector) |
| Human closes the panel without releasing | control returns to the agent, no stranded queue | `gateway: the last viewer leaving returns control to the agent`; implementation at `browser-gateway.mjs` (`#dropViewer` → `releaseControl`) |
| Person drives, then handback | the same tab, on the person's page, and the bot continues there | E2E phases 4–6; `gateway: the viewer streams frames and drives the browser while in control` |
| Crash while a human holds control | the crash is reported, the bot gets a working browser back on the same endpoint | E2E phase 16; `manager: a crashed browser restarts only while somebody is watching` |
| Rapid take/return | every transition announced exactly once, no lost state | `lease: every holder transition is announced exactly once` |
| Reconnect during an active lease | the new viewer is told the current holder; nothing is reset | E2E phases 10–11; `browser routes: a viewer socket needs a real ticket or a real session` |
| Failed handover | control stays with the current holder | `lease: a failed handover leaves control with the current holder` |
| Two bots at once | separate ports, tokens, profiles, pages; one bot's crash does not touch the other | `manager: two bots never share a browser process or a profile`; `manager: stopping one bot does not stop another bot's viewers`; E2E phase 12 |
| Idle shutdown with a live lease | lease released, browser stopped, endpoint kept for the next use | `manager: an idle browser is shut down, and a watched one is kept`; E2E phases 7–8 |

No deadlock or starvation was observed: every wait in the gateway is bounded (handover,
lease queue, gateway start, browser start, viewer attach), and the E2E's refusals arrive
as structured errors rather than timeouts.

---

## 4. Session cookies: investigation and fix

**Question.** A bot signs in, goes idle, the browser is shut down and later restarted. Does
it come back signed in?

**Phase 1 answer.** Durable cookies (with an expiry) and `localStorage` survive; *session*
cookies (no expiry) do not. Both were attributed to Chromium.

**Phase 2 investigation.** A controlled probe compared three shutdown styles for a session
cookie and a durable cookie on the same profile
(`server/zz-cookie-probe.mjs`, later deleted; results recorded here and in the tests):

| Shutdown | Durable cookie | Session cookie |
| --- | --- | --- |
| Clean close, no extra flags | survives | **lost** |
| Clean close, `--restore-last-session` | survives | **survives** |
| Hard kill (`taskkill /F`), no flags | **lost** | **lost** |

Three conclusions, each of which changed the implementation:

1. The limitation is a **launch-flag/policy decision inside Chromium**, not a
   HOB bug and not a sign of a non-persistent profile.
2. A **supported** switch fixes it: `--restore-last-session`. Nothing is patched; the
   browser does exactly what it is documented to do.
3. A hard kill loses *even durable* cookies, because Chromium flushes asynchronously.
   The existing graceful-close-first design is therefore **load-bearing**, and was left
   exactly as it was.

**The side effect, and what was done about it.** The switch also reopens the last
session's *tabs* (verified: after relaunch the target list was `["about:blank",
"RESTORE-ME@data:…"]`). Tabs are not state HOB promises, and silently re-opening every tab
of the last session would grow memory on every idle restart. So
`clearStaleProfileState()` now also deletes the saved tab state (`Default/Sessions`,
`Last Session`, `Last Tabs`, `Current Session`, `Current Tabs`) before each fresh launch.
The cookie jar is a different file and is not touched.

**Verification.**

- `manager: a bot keeps its logins, cookies and page state across a shutdown` now asserts
  `localStorage`, a durable cookie **and** a session cookie all survive an idle
  shutdown, and that the restarted browser holds **exactly one** page target.
- E2E phase 13/15 plants a session cookie and `localStorage` with the bot's own
  `browser_console` tool (the supported way to run JS in the page; `browser_cdp` speaks
  browser-level CDP, where Chromium correctly refuses `Runtime.evaluate`), idles the
  browser down, brings it back and reads both back.
- Nothing is written to logs or serialised: the cookie never leaves the profile.

---

## 5. Docker / Linux validation

**Docker is not available on this development host** (no daemon, no CLI). Nothing in this
section is claimed as *executed* unless it says so. What follows is (a) static inspection,
(b) described evidence the repository already produces in CI, and (c) the exact commands
to run the outstanding checks.

### 5.1 Static inspection (executed here)

- **Runtime base:** `ghcr.io/abdlx/hob-hermes-runtime:hermes-7e9eb8d9@sha256:1863…` — the
  upstream Hermes runtime, digest-pinned, Linux amd64. Chromium and `agent-browser` come
  from that image (`/opt/hermes/tools`), which is why `browser-launcher.mjs` looks there
  first (`PLAYWRIGHT_BROWSERS_PATH`, `/opt/hermes/tools`, …).
- **Privilege:** the stock entrypoint initialises the volume, then drops to the Hermes
  runtime user (uid 10000). `cap_drop: ALL` with only `CHOWN`, `DAC_OVERRIDE`, `FOWNER`,
  `SETGID`, `SETUID`, `KILL` re-added for that initialisation; `no-new-privileges: true`.
- **Sandbox — not disabled.** `browser-launcher.mjs` adds `--no-sandbox`/`--disable-setuid-sandbox`
  **only** when `process.getuid?.() === 0`, which does not happen in the container. The
  sandbox is enabled by shipping a seccomp profile instead
  (`compose.yaml` → `seccomp=./deploy/chromium-seccomp.json`). Inspected: `defaultAction:
  SCMP_ACT_ERRNO`, 31 allow rules covering 414 syscalls, with argument filters on `socket`,
  `personality` and `clone` — i.e. Docker's default allow-list plus the namespace calls
  Chromium's sandbox needs.
- **Shared memory:** `shm_size: "1gb"`. Worth knowing: without it, a 64 MB `/dev/shm` is a
  classic cause of headless renderer crashes; run the provided compose file, or set
  `shm_size`, or add `--disable-dev-shm-usage`.
- **Signal handling:** `stop_grace_period: 40s`; `deploy/start.mjs` sends `SIGTERM` to HOB
  and escalates to `SIGKILL` after 30 s. `server/index.mjs` now *awaits* the browser
  shutdown on `SIGTERM`/`SIGINT` under a 25 s bound (it used to fire it and forget it), so
  the graceful `Browser.close` that flushes cookies and storage — the whole mechanism `H7`
  depends on — actually completes inside the supervisor's window, and the process cannot
  sit on a drained-but-open loop until `SIGKILL`. The handler is idempotent, so a second
  signal during shutdown is ignored.

  **Not verified here:** SIGTERM delivery to a handler is a POSIX thing. On Windows,
  `TerminateProcess` is used and the handler never runs (verified: a child with a
  `SIGTERM` handler reports `signalCode=SIGTERM` and prints nothing), so this path can
  only be exercised in the container. In-container command in §5.3, step 9.
- **Persistence:** the named volume `hermes-data` mounts at `/opt/data`; `HOB_STATE_DIR=/opt/data/.hob`
  holds the registry and the per-bot Chromium profiles (`/opt/data/.hob/browsers/<bot>/chromium`).
  Container recreation therefore keeps logins. Profile directories are created mode `0700`.
- **Multi-bot:** one gateway port per bot, chosen from a per-(bot, state-dir) hash with a
  free-port walk, so two bots cannot collide and a stale run cannot keep a port.

### 5.2 In-container evidence that already exists

`deploy/probe-browser.mjs` runs in the image's CI workflow. It launches the image's own
Chromium as the unprivileged user and reads `chrome://sandbox` over DevTools, asserting:

- *Layer 1 Sandbox: Namespace* is enabled, and
- *Seccomp-BPF Sandbox* is enabled, and
- the DevTools endpoint answers on `127.0.0.1` only.

So "does Chromium actually have its sandbox in this image" is already a CI gate. Note what
it does **not** cover: it hand-writes a flag list rather than using
`browser-launcher.mjs`, so it does not prove the exact production flag set (now including
`--restore-last-session`) starts and persists state in the container. That is an
outstanding test, listed below.

### 5.3 Outstanding container checks — exact commands

```bash
# 1. Build and start (Coolify-equivalent, standalone overlay)
docker compose -f compose.yaml -f compose.standalone.yaml up -d --build

# 2. Sandbox + loopback-only DevTools (existing CI probe)
docker compose exec muse node /app/deploy/probe-browser.mjs

# 3. The production launch path: start a bot's browser through HOB itself and prove
#    a *session* cookie survives a restart, inside the container. (Not yet written as a
#    probe: run the equivalent of the manager test against the running container.)
docker compose exec muse node --test --test-timeout=120000 /app/server/test/browser-manager.test.mjs

# 4. Full live scenario in the container (needs Hermes python deps, already in the image)
docker compose exec muse /opt/hermes/bin/python /app/server/e2e/hermes-tools-e2e.py

# 5. Server tests, container context
docker compose exec muse node --test --test-reporter=spec /app/server/test/*.test.mjs

# 6. Restart with data: recreate the container and confirm the bot is still signed in
docker compose restart muse
docker compose exec muse node -e "console.log('see step 3 again')"

# 7. Idle shutdown/relaunch inside the container, with measurements (same scenarios as §6)
docker compose exec muse node /app/server/measure-browser.mjs /tmp/hob-measure.md

# 8. Host kernel/AppArmor check for the namespace sandbox
docker compose exec muse sh -lc 'unshare --user --map-root-user true && echo USERNS_OK'

# 9. Graceful shutdown on SIGTERM, with a browser running (step 3 leaves one up).
#    The container must exit on its own inside stop_grace_period (SIGKILL shows as 137),
#    and no Chromium may survive the stop. Step 3 covers the cookie flush that depends
#    on this close actually happening.
docker compose stop muse
docker inspect -f '{{.State.ExitCode}}' "$(docker compose ps -aq muse)"   # expect 0, not 137
docker compose start muse
docker compose exec muse sh -lc 'pgrep -af "chromium|chrome" | grep -v grep || echo NO_CHROME'
```

Not verified here, and therefore not claimed: first boot, container recreation with real
state, agent-browser's own container detection inside the image, and Linux-specific
process counts. On this host the equivalent logic is exercised on Windows.

---

## 6. Resource measurements

Measured with `server/measure-browser.mjs`, which drives the real manager and session
through ten scenarios and samples Chromium's whole process tree (by profile directory), the
HOB server process, and the gateway's own connection counts. Raw numbers, method, run-to-run
variance and the reasoning behind every optimisation decision are in
**`production_hardening_measurements.md`**. The shape:

| Scenario | Chromium procs | Chromium RSS | Chromium CPU (1 core) | HOB RSS |
| --- | --- | --- | --- | --- |
| idle host, no browser | 0 | 0 | 0 % | 67 MiB |
| 1 browser, agent only, static page | 10 | ~490 MiB | 9–10 % | 68 MiB |
| 1 browser, agent + 2 viewers, static page | 9 | ~480 MiB | 14–22 % | 70 MiB |
| 1 browser, agent + 2 viewers, **repainting** page | 9 | ~500 MiB | **78–85 %** | 71 MiB |
| same page, viewers gone (screencast stopped) | 9 | ~485 MiB | **2–3 %** | 72 MiB |
| 2 browsers, one agent each | 19 | ~970 MiB | 14–16 % | 71 MiB |
| after idle shutdown (both) | 0 | 0 | 0 % | 72 MiB |
| after crash + restart | 10 | ~485 MiB | 15–21 % | 72 MiB |

What this establishes, and what it changed:

- **A browser costs what Chromium costs (~0.5 GiB, 9–10 processes); HOB costs a flat
  ~70 MiB.** That figure is unchanged by two browsers, two viewers or a streaming
  screencast, so HOB is not accumulating frames or connections: one frame is retained (to
  greet a reconnecting viewer), no queue.
- **The screencast is the only CPU-heavy path, and it is bounded.** A repainting page with
  nobody watching costs ~2 %; two viewers cost ~80 % of one core, i.e. Chromium rendering
  and JPEG-encoding at `maxFps = 10`. Two viewers cost no more than one (single cast, fanned
  out). The 10 fps cap is what keeps that from saturating a host, so it stays.
- **Idle shutdown and lazy start are justified, not just tidy:** a browser nobody watches
  still holds ~485 MiB. Returning to 0 processes and 0 % CPU on idle, and to the same
  numbers after a crash-and-restart (no accumulation), is the whole argument for the
  10-minute policy.
- **Nothing was optimised on a hunch.** Considered and rejected, with reasons, in the
  measurements document: lowering `maxFps` (the cost is already capped), sharing one
  Chromium between bots (destroys the isolation boundary), and keeping warm spare browsers
  (~0.5 GiB parked; a cold start is 1.5–3 s).

Not measured here: profile disk growth over time, and viewer/ticket load at the
`MAX_VIEWERS_PER_BOT = 8` bound. Both are listed as limitations in §8.

---

## 7. Tests and exact commands

Environment: Windows development host, Node v25.3.0, Google Chrome 155 at
`C:\Program Files\Google\Chrome\Application\chrome.exe`, no Docker daemon.

```powershell
# Unit + integration suite (real Chromium). Serialized files: see the note below.
cd server
$env:HOB_CHROMIUM_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'
node --test --test-reporter=spec --test-timeout=180000 --test-concurrency=1 test/browser-*.test.mjs

# Live end-to-end scenario, driven by the real Hermes tools
& "$env:TEMP\opencode\hob-e2e-venv\Scripts\python.exe" e2e/hermes-tools-e2e.py

# Frontend
cd ../web
npm run lint
npm run build
```

### 7.1 Server suite (real Chromium) — run here

One command, run to completion on its own:

```
node --test --test-reporter=spec --test-timeout=180000 --test-concurrency=1 test/browser-*.test.mjs
```

| File | Tests | Result |
| --- | --- | --- |
| `browser-gateway.test.mjs` | 7 | 7 pass |
| `browser-takeover-bypass.test.mjs` | 6 | 6 pass |
| `browser-policy.test.mjs` | 4 | 4 pass |
| `browser-routes.test.mjs` | 7 | 7 pass |
| `browser-manager.test.mjs` | 9 | 9 pass |
| `browser-lease.test.mjs` | 9 | 9 pass |
| `browser-registry.test.mjs` | 9 | 9 pass |
| **Total** | **51** | **51 pass, 0 fail, 0 skipped** |

`duration_ms` 60 905 on the first clean run and 65 272 on a confirming run of the exact
command above (about a minute), which includes launching real Chromium over and over and
running two browsers at once. Every file's process now exits on its own, so the runner
prints its summary instead of waiting forever — see §2.8 for the real reason it used not
to. Both runs finished with zero Chromium processes left over.

**One caveat about the environment, recorded because it distorted an earlier run:** this
development host was suspended mid-run at one point, and the wall-clock durations the
runner reported were nonsense as a result (one test "took" 96 minutes). Nothing hung and
nothing failed; the numbers were the machine's sleep, not the code's. All results above
were re-run on an awake host.

### 7.2 Live end-to-end scenario

```powershell
cd server
$env:HOB_CHROMIUM_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'
& "$env:TEMP\opencode\hob-e2e-venv\Scripts\python.exe" e2e/hermes-tools-e2e.py
```

Driven by the real Hermes browser tools (`browser_navigate`, `browser_snapshot`,
`browser_type`, `browser_click`, `browser_console`, `browser_cdp`) against the real
`agent-browser` CLI. **16 phases, 57 checks, 0 failures, exit code 0.** (Phase 1's baseline
was 27 checks; the 30 new ones are this phase's adversarial and reliability scenarios.)

| Phase | What it proves | Checks |
| --- | --- | --- |
| 1–1b | real browsing: navigate, snapshot, type into Wikipedia's search box, click, URL changes | 11 |
| 2 | the person takes control | 1 |
| 3 | the bot is refused while the person holds control — through `browser_navigate` **and** raw `browser_cdp` — the page does not move, and the refusal is a structured error, not a hang | 4 |
| 4 | the person drives the browser over the viewer socket | 3 |
| 5–6 | handback: the bot continues on **the same tab, on the page the person left it on**, then navigates again | 4 |
| 9 | unauthenticated dashboard request → 401; a bot that is not the viewer's → 404 | 2 |
| 10 | ticket security: forged refused, spent refused, no-credential refused, and a spent ticket **plus the person's own session cookie** reconnects | 6 |
| 11 | two viewers: both greeted, dashboard counts 2, both receive frames, closing both leaves the browser running, a reconnect comes back live | 8 |
| 12 | a second bot: different endpoint, its own browser and page, the first bot unaffected | 6 |
| 13 → 7 → 8 | the bot plants a **session** cookie (`document.cookie`, no expiry) and `localStorage`, the browser idles down, the bot uses it again on the same endpoint… | 5 |
| 15 | …and after the restart **both are still there** (`COOKIE=e2e_session=kept;STORE=kept`) | 2 |
| 16 | the browser is killed while a *person* holds control: the dashboard reports the crash, and the bot gets a working browser back on the same endpoint | 5 |

Three notes worth keeping:

- **`browser_cdp` cannot run `Runtime.evaluate`**, and that is correct: the tool speaks
  browser-level CDP, while `Runtime.evaluate` is a page-domain method that Chromium only
  accepts on an attached target session (`-32601 'Runtime.evaluate' wasn't found`). The
  session-state phase therefore uses `browser_console(expression=...)`, the bot's supported
  way to run JS in the page. The same distinction is why the gateway classifies methods by
  domain rather than by connection.
- The E2E tunes the manager's `agentWaitMs` (`HOB_E2E_AGENT_WAIT_MS`, 4 s) and idle window
  (`HOB_E2E_IDLE_MS`, 15 s) down, so the takeover refusal and the idle shutdown happen
  inside the run; the production defaults (20 s and 10 min) are what the unit tests
  configure explicitly.
- `websockets` prints a `DeprecationWarning` about `connect()` needing a context manager on
  one helper. It is the library's warning, the connection is used correctly, and it does
  not affect any result.

### 7.3 Frontend

```powershell
cd web
npm run lint     # eslint, exit 0, no findings
npm run build    # tsc -b && vite build, exit 0, built in 4.08 s
```

```
dist/index.html                   0.86 kB │ gzip:   0.49 kB
dist/assets/index-B887wqNf.css   53.49 kB │ gzip:  10.54 kB
dist/assets/index-CgXwTRT9.js   676.72 kB │ gzip: 190.64 kB
(!) Some chunks are larger than 500 kB after minification.
```

The chunk-size warning is pre-existing (Phase 1 recorded it): the viewer, the chat surface
and the dashboard share one bundle. It is a performance follow-up, not a correctness or
security finding, and it is unchanged by this phase.


---

## 8. Remaining limitations

1. **H1 — raw loopback DevTools port.** §2.1. **Fixed in Phase 3** by the pipe transport.
   The TCP fallback (`HOB_CDP_TRANSPORT=tcp`) restores the port by design and is for
   local development only.
2. **Session restore is profile-wide.** `--restore-last-session` restores cookie state for
   the whole profile, which is the unit of isolation anyway (one profile per bot). It does
   not restore tabs, by construction.
3. **A hard kill still loses recent state.** Cookies and storage are flushed
   asynchronously; the graceful-close path exists for that reason and is the only shutdown
   path an idle reap takes.
4. **No canvas cursor renderer in `@atriumjs/protocol`** (Phase 1 limitation, unchanged):
   the viewer shows frames, not the OS cursor.
5. **Docker/Linux**: the checks in §5.3 are outstanding. Everything in §5.2 is CI evidence,
   not something re-run here.
6. **One loopback gateway endpoint per bot.** Chromium itself no longer listens (§2.1), but
   the agent's CDP endpoint (the gateway, token-scoped, policy- and lease-checked) is still a
   loopback socket per bot, and its tokens are loopback-based hashes — fine for a single
   host, not a multi-host design.
7. **Viewer/ticket load is bounded but now exercised** (Phase 3): eight concurrent viewers
   are driven against one browser and a ninth is refused, twenty open/close cycles are run
   without leaking, and a stalled consumer is shown not to slow the others
   (`test/browser-load.test.mjs`). The bounds themselves are unchanged.
8. **Platform**: the live verification is Windows + Chrome 155. The container's Linux
   Chromium is expected to behave identically for `--restore-last-session` (it is not a
   Windows-specific switch) and for the pipe (an fd pair is an fd pair), but that is an
   expectation, not a measurement — see `phase3_pipe_validation.md` §6.
9. **Profile disk growth is measured over restarts, not over weeks.** Phase 3 recorded
   ~4.6 MB → ~7.4 MB across three launches of a freshly created profile (≈191 files), with
   the growth in a small number of IndexedDB/localStorage files and no unbounded log. There
   is still no retention or size cap on the profile, and no long-lived cache measurement.
10. **The SIGTERM shutdown path is unexecuted here** (Windows cannot deliver a signal to a
    handler — §5.1). The code awaits the graceful stop under a 25 s bound, and the manager
    tests cover the stop itself; the signal-to-exit path is a container check (§5.3, step 9).

---

## 9. Conditions to move from CONDITIONAL to READY

1. ~~Close H1 properly: a per-client CDP multiplexer over `--remote-debugging-pipe`.~~
   **Done in Phase 3** — the multiplexer is `server/browser-pipe.mjs`, the pipe is the
   default, and the H1 regression test now asserts that no DevTools port exists. Evidence:
   `phase3_pipe_validation.md` §4.
2. Run §5.3 in the image and record the results in this document (sandbox, the production
   launch path, restart-with-data, multi-bot, signal handling).
3. Re-run §7 on Linux so that the platform claim in §8.8 becomes a measurement.
