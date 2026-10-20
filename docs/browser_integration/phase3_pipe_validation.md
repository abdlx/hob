# Phase 3 — CDP pipe isolation and production validation

Companion to `production_hardening.md` (Phase 2). That document's finding **H1** — a raw
loopback DevTools port that anyone on the host could speak to without the gateway, the
lease or the policy — is closed by this phase, structurally.

**Verdict: CONDITIONAL.** The pipe transport is implemented, is the default, and H1 is
closed on every platform this host can execute. The Linux/container checklist in §6 was
**not executed** (no Docker daemon on the build host), so Linux production readiness is
reviewed and prepared but not measured. §0 states exactly which sentence is evidence and
which is inference.

> **Phase 4 update:** the §6 checklist has now been executed against the shipped image on a
> Linux Docker host. See [`phase4_deployment_validation.md`](./phase4_deployment_validation.md).
> All executable container checks pass; the one remaining gap is the production host's
> Ubuntu 24.04 AppArmor user-namespace policy.

Everything below was run on this machine unless a section says otherwise: Windows 11,
Node v25.3.0, Google Chrome 155 (`--headless=new`).

---

## 0. Verdict

**CONDITIONAL — ready to ship for Windows/host deployments and ready to *test* in the
container; not yet "READY" for Linux/Docker production until §6 is executed there.**

**Proven by execution (this host):**

| Claim | Evidence |
| --- | --- |
| Production mode has no DevTools TCP door | H1 test: `transport=pipe chromiumPort=null DevToolsActivePort=absent listeners=[]`; E2E phase 17 inspects the live process tree and finds no `/json/*` endpoint |
| The assertion is not vacuous | The same suite in the fallback prints `transport=tcp chromiumPort=63685 DevToolsActivePort=63685 listeners=[63685]` (an ephemeral port) and the TCP branch asserts loopback-only |
| A profile can be upgraded tcp → pipe without leaving a port behind | executed migration probe: tcp port `54656` + `DevToolsActivePort` + listener `[54656]` → pipe `chromiumPort=null`, file gone, listeners `[]`, same agent endpoint |
| Multi-client correctness over one pipe | 12 transport/multiplexer tests, plus the full 70-test browser suite in pipe mode |
| Real Hermes tools still work | 17-phase live E2E, 60/60 checks, 0 failures (`browser_navigate`, `browser_snapshot`, `browser_type`, `browser_click`, `browser_cdp`, tabs, reconnect, two bots) |
| Takeover exclusivity survives the transport change | the Phase 2 adversarial matrix re-run over the pipe (7 tests incl. H1/H2/H3/H4 and the HTTP tab endpoint) |
| 8 viewers, slow consumers, churn, crashes, idle cycles | 5 load/reliability tests (§5) |
| No orphan browser when HOB dies | probe: a node process that launches a pipe browser and calls `process.exit(9)` leaves **0** Chromium processes |
| Nothing else regressed | 205/205 non-browser server tests, frontend lint clean, production build succeeds |

**Not proven (therefore not claimed):**

- the container checks in §6 — no Docker daemon here;
- the `SIGTERM`-to-handler path, which Windows cannot deliver (container check);
- Linux resource numbers (the measurement script implements the Linux branch but has only
  been run on Windows);
- long-horizon profile growth (measured over restarts, not weeks).

**What would move this to READY:** execute §6 in the image and append the results, then
re-run the measurement script on Linux. Nothing in the design is expected to change; that
is a prediction, not evidence, and that is exactly why the verdict is CONDITIONAL.

---

## 1. What this phase had to deliver

| Requirement | How it is met | Where |
| --- | --- | --- |
| HOB owns Chromium and its private CDP channel | `--remote-debugging-pipe` on fds 3/4; no `--remote-debugging-port`; profile cleaned before every launch | §2 |
| No raw DevTools listener in production | pipe is the default; no listener, no `DevToolsActivePort`; asserted by test and E2E | §4.1 |
| Pipe transport robust to real framing | NUL-delimited JSON, coalesced/split reads, bounded frames, backpressure | §2, §3.7 |
| Multiplexer preserves ids, sessions, attachment, events, errors | per-client id spaces, identity or virtual session ids, ownership routing, typed failures | §3 |
| Concurrent agent + viewer sessions | 8 simultaneous viewers + agent on one browser; 9th refused | §5 |
| Lease enforced on every CDP path | the pipe is not a second door: all paths still enter the lease | §4.3 |
| Pipe closure, crash, reconnect, shutdown, backpressure | tests, E2E crash phase, orphan probe, graceful-close wait | §5, §2.4 |
| No cross-bot leakage | one pipe + one profile per bot; per-bot tokens and sessions | §4.4 |
| `browser.cdp_url` integration and Hermes source untouched | no Hermes file changed; the agent still receives an HTTP CDP URL served by HOB | §8.4 |
| TCP only as an explicit dev fallback | `HOB_CDP_TRANSPORT` unset/pipe by default; `tcp` opt-in; invalid values throw at boot; boot warning when tcp is on | §4.5 |
| Real Hermes tools, no mocks | live E2E against Hermes' own browser tools | §8.2 |
| Takeover exclusivity revalidated | Phase 2 matrix re-run in pipe mode | §4.3 |
| Linux/Docker readiness | static review + probe rewritten for the pipe; **execution outstanding** | §6 |
| Load/reliability coverage | 8 viewers, expiry, slow consumer, churn, disk growth, crashes, idle restarts | §5 |
| Existing suites, lint, build | 70 browser + 205 server tests, ESLint, Vite build | §8 |

---

## 2. The pipe transport: what Chromium actually does

The Phase 2 document declined the pipe because its semantics had not been established.
They were established empirically here, against the same Chromium the product ships with.
None of this is assumed from WebSocket or newline conventions:

| Fact | How it was established |
| --- | --- |
| A browser launched with `--remote-debugging-pipe` uses **fd 3 for commands** (HOB → Chromium) and **fd 4 for replies and events** (Chromium → HOB) | launched with `stdio: ['ignore','pipe','pipe','pipe','pipe']` and exchanged `Browser.getVersion` |
| Frames are **JSON objects separated by a single NUL byte (`0x00`)** — not newline, not length-prefixed, not WebSocket | sent two commands in one write and read both replies; sent one command across two writes; a NUL inside a JSON string only appears escaped (`\u0000`), so scanning for `0x00` is unambiguous |
| Several frames can arrive in one read; one frame can span reads | both cases are unit-tested (`pipe framing: NUL-delimited JSON, coalesced and split across chunks`) |
| A pipe-backed browser writes **no `DevToolsActivePort`** and opens **no TCP listener** | profile inspected after launch; process tree's listening sockets enumerated |
| One pipe is **one browser-level CDP session** | a second `Target.setAutoAttach({flatten:true})` with the same flags is a no-op; explicit `Target.attachToTarget` over the pipe returns a **distinct session id per call** |
| Readiness is observable without HTTP | `Browser.getVersion` over the pipe answers as soon as the browser is up; this is the launch probe (`waitForPipe`, 30 s budget, child-exit aware) |

### 2.1 Launch

`server/browser-launcher.mjs` builds one argument list for both transports and differs only
in the debugging switch:

```js
const debuggingArgs = mode === 'pipe'
  ? ['--remote-debugging-pipe']
  : ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'];
```

Everything else — profile, `--restore-last-session`, the hardening flags, `--headless=new` in
tests, `--no-sandbox` only when running as uid 0 — is shared, so pipe mode cannot silently
drift from the validated flag set. The pipe path spawns with five stdio entries and never
reads fd 3 back or writes fd 4.

### 2.2 Readiness and launch failure

`waitForPipe` posts `Browser.getVersion` and polls for the reply, failing fast if the child
exits (`exitCode`/`signalCode`) and retrying with backoff (3 attempts) because a profile
released by a just-stopped browser can still be locked for a moment. Chromium's **stderr is
kept in an 8 KiB tail** and quoted in the failure message, so a launch failure in production
says *why* (missing library, sandbox refusal, stale profile lock) instead of "timed out".

### 2.3 Framing and flow control

- Accumulate bytes from fd 4, split on `0x00`, parse each complete frame.
- A frame larger than **64 MiB** fails the transport rather than growing the buffer.
- Writes are queued in order; if fd 3 applies backpressure the queue drains on `'drain'`.
  More than **64 MiB** queued fails the transport rather than consuming memory.
- A malformed individual frame is dropped; it never desynchronises the stream.

The 64 MiB figure matches the WebSocket `maxPayload` on the client-facing side
(`MAX_CDP_FRAME`), so a message cannot be legal on one leg and illegal on the other.

### 2.4 Shutdown

`Browser.close` is sent over the pipe, then HOB **waits for the child process to exit**
(`closePipeGracefully(pipe, { child, timeoutMs: 5000 })` → `waitForExit`). This ordering is
not cosmetic: returning as soon as `Browser.close` was written loses the cookie flush and
was caught by the E2E cookie phase. If the child does not exit, `stopChromium` force-kills
the tree. A graceful stop of an idle browser measured **~142 ms** here; the E2E's final stop
leaves **zero** Chromium processes.

If HOB dies without any of that, the OS closes fd 3 and Chromium exits on its own. Verified:
a node process launched a pipe browser, printed its pid, and called `process.exit(9)`; the
browser's process tree was already **0** processes when sampled immediately afterwards and
stayed 0.

---

## 3. The multiplexer

### 3.1 Why a multiplexer, and not "just use the pipe"

Phase 2's trace of a real Hermes session showed clients depending on **per-connection
browser-level state**: `Target.setAutoAttach`, `Target.setDiscoverTargets`, `Fetch.enable`,
`Page.addScriptToEvaluateOnNewDocument`, `Runtime.runIfWaitingForDebugger`. A pipe is a
single browser-level session, so handing it to two clients would merge their id spaces,
their event streams and their enable-sets. `server/browser-pipe.mjs` therefore terminates
each client's session and re-implements those browser-level behaviours above the pipe.

### 3.2 Shape

| Class | Responsibility |
| --- | --- |
| `PipeTransport` | fd 3/4, framing, ordering, write queue, 64 MiB bounds, failure |
| `PipeChannel` | one client's view: `ws`-like `readyState`, `on/once`, `send(text, cb)`, `close`, `message` with a `Buffer` |
| `PipeChromium` | one pipe, many channels: client registry, id mapping, session ownership, auto-attach aggregation, target lifecycle fan-out |
| `PipeCdpConnection` | the gateway's *internal* CDP client (screencast, tab list) — a channel like any other |
| `attachPipeTransport` | wires a child's stdio to a transport |

`PipeChannel` deliberately mimics the subset of `ws` the existing `AgentProxy` uses, so the
agent-facing code path did not need a second implementation for the second transport.

### 3.3 Id spaces

Each channel has its own id counter. A client id is rewritten to a gateway-global id on the
way in and back on the way out, so two clients can both use id `1` concurrently. The
gateway's own internal commands use **negative ids**, which no client produces, so they can
never collide with a client's pending request. Replies are matched in the channel that owns
the rewritten id; a reply that matches nothing is dropped rather than broadcast.

### 3.4 Sessions and target attachment

- **Explicit attach.** `Target.attachToTarget` is forwarded to Chromium; the returned real
  session id is handed to the requesting client **unchanged**, and ownership of that session
  is recorded. Messages carrying that session id are routed only to that client.
- **Auto-attach.** The browser-level `Target.setAutoAttach` is global and is always sent as
  `flatten: true, waitForDebuggerOnStart: false`. Because a second caller changing it would
  change it for everyone, the multiplexer **aggregates** it: it is on while any client wants
  it, and each client's `TargetFilter[]` is applied at delivery time.
- **Virtual session ids.** When Chromium reports an auto-attached target, every
  auto-attach-enabled client receives a *private* `Target.attachedToTarget` whose session id
  is `${real}-hobN`. Inbound messages using the virtual id are rewritten to the real id and
  checked against the channel's ownership; outbound events are rewritten back. No client
  ever learns another client's real session id.
- **Late enablers.** `setAutoAttach` on a pipe is a no-op for a *second* caller, so a client
  that enables auto-attach after the browser already tied the targets would otherwise see
  nothing. `catchUpAutoAttach` enumerates current targets and issues private attaches,
  synthesising `Target.attachedToTarget` for that client only (`holdTarget` covers a target
  that appears between discovery and attach). This is what makes a second Hermes agent
  connection work at all.
- **Detach.** A client detaching a shared auto-attach session releases only its own virtual
  session (`releaseSession`); the real session stays while another channel owns it.
  `Target.setAutoAttach(false)` stops new adoptions for that client but does not silently
  release sessions it already holds — the client detaches explicitly. This is documented
  behaviour, not an accident (§9).

### 3.5 Event routing

| Event | Delivered to |
| --- | --- |
| Replies | the channel that issued the id |
| `Target.attachedToTarget` / `detachedFromTarget` | the explicit owner, or every auto-attach channel whose filter matches (private ids) |
| `Target.targetCreated` / `targetInfoChanged` / `targetDestroyed` | channels that enabled `Target.setDiscoverTargets` |
| Any other browser-level event | all channels |
| Any session event | the channel that owns that session |

The last two rules are the isolation boundary: a page event (a dialog, a frame navigation, a
network request) reaches exactly the client that attached that page.

### 3.6 A page-bound channel

The gateway's own screencast/tab client and the synthesised `/devtools/page/<id>` endpoint
attach to one page and never send a session id. `createChannel({ kind: 'page', targetId })`
performs the real attach internally and then **hides** the session id in both directions, so
a client written for a per-page WebSocket socket works unchanged. A test asserts that no
session id leaks out of such a channel.

### 3.7 Errors and failure

- A command without an `id` is refused at the transport (`-32600`), never forwarded — H2 is
  now enforced on the pipe leg as well as the WebSocket leg.
- When the pipe dies, every pending waiter is rejected with `PipeClosedError` and every
  channel emits `close` with a reason; nothing waits for a reply that cannot arrive.
- A consumer whose message handler throws cannot take the pipe down: the channel emits
  `error` only if a listener exists.
- The gateway treats an unresponsive browser as replaceable: two probes (1 s and 3 s), then
  it drops the pipe, kills the child, clears its references and relaunches — without leaving
  the profile lock behind.

---

## 4. Security re-validation

### 4.1 H1 is closed, and the test now says so

`test/browser-takeover-bypass.test.mjs` previously proved the port was *reachable on
loopback*. It now proves there is no port:

```text
ℹ transport=pipe chromiumPort=null DevToolsActivePort=absent listeners=[]
```

It asserts, against a running production-mode browser:

1. `session.status().chromiumPort === null`;
2. `<profile>/DevToolsActivePort` does not exist;
3. enumerating every TCP socket owned by the browser's process tree yields nothing
   (`Get-NetTCPConnection` on Windows, `ss -ltnp` + `pgrep` on Linux), and
4. no `/json/version` or `/json/list` answers in that tree.

Run in the fallback, the same suite prints

```text
ℹ transport=tcp chromiumPort=63685 DevToolsActivePort=63685 listeners=[63685]
```

and asserts loopback-only instead. Two modes, two honest answers: the test cannot pass by
being skipped.

The live E2E adds the same check at the level an operator would care about: phase 17 asks
the dashboard for its `transport` (must be `"pipe"`), looks for `DevToolsActivePort` in every
bot profile, and probes every listening socket in every running browser's tree for a
DevTools HTTP response. It inspected one running browser and found nothing.

### 4.2 Upgrading an existing profile

A deployment that has been running Phase 2 has profiles on disk that were created in TCP
mode. The upgrade was executed explicitly: start a browser in tcp mode on a fresh profile,
stop it, then start the *same profile* with the default transport.

```text
tcp mode:  {"transport":"tcp","chromiumPort":54656}
tcp DevToolsActivePort: {"port":54656,"wsPath":"/devtools/browser/c0c428b3-…"}
tcp listeners: [54656]
pipe mode: {"transport":"pipe","chromiumPort":null}
same endpoint: true
pipe DevToolsActivePort file present: false
pipe listeners: []
```

The mechanism is `clearStaleProfileState`, which runs before **every** launch in both modes
and removes `DevToolsActivePort` plus the singleton lock files (it also drops saved tab
state, which is why an idle restart does not reopen last session's tabs). So switching a
running system to pipe mode does not leave a stale port file behind, and the H1 assertion
holds on reused profiles, not just on fresh ones.

### 4.3 The lease is still the only way through

The pipe changes the transport, not the authority chain. Every path still converges on the
gateway's policy engine and control lease:

- agent CDP frames arrive over the agent's WebSocket, are classified by `browser-policy.mjs`,
  and are admitted through `ControlLease` before they are ever written to fd 3;
- viewer commands (`click`, `type`, `key`, navigation, resize, history) enter the lease as
  viewer mutations;
- the gateway's own commands over the pipe are reads (target list, screencast, layout
  metrics); where a viewer asks for a mutation, the gateway takes `enterViewerMutation()`
  first;
- `PUT /json/new` on the agent's HTTP surface is a mutation (`Target.createTarget`), so it is
  admitted through `enterAgentMutation()` exactly like the socket path — a tab cannot be
  opened while a person holds control, and the refusal is a `409` with the same denial text
  a CDP client would see.

That last bullet was a real gap found while writing this section: the synthesized pipe
endpoint created the target by calling the pipe directly, and the TCP proxy had always
forwarded `/json/new` without admission. Both are now gated by the same lease, and the
matrix below has a test for it.

The Phase 2 adversarial matrix was re-run unchanged, in pipe mode, and passes:

| Test | What it proves over the pipe |
| --- | --- |
| `policy: methods with side effects are never treated as observational` | classification did not weaken when the transport changed |
| `takeover: an id-less CDP command cannot mutate the page` | H2 enforced inside the mux, not only at the WebSocket |
| `takeover: a target session id cannot smuggle a mutation past the lease` | a session id that bypasses the browser-level check still cannot mutate while a human holds control |
| `takeover: capability injection requires the lease` | H3 unchanged |
| `takeover: in production the browser has no DevTools TCP door at all` | H1 closed |
| `takeover: the HTTP tab endpoint cannot open a page while the person is in control` | `/json/new` is a mutation and respects the same takeover |
| `takeover: an agent cannot freeze frames the person's page loads` | H4 is now structural: `waitForDebuggerOnStart` is always `false`, because one pipe has one global setting |

Nested sessions and concurrent operations are covered by the same suite (they were added in
Phase 2 and did not need transport-specific variants): the lease counts in-flight and
pending agent work, drains it on takeover, cancels by rejection rather than by silently
dropping replies, and resumes the agent on the same page state afterwards. The E2E exercises
the human half of that live: phases 2–5 take control, make the bot try to change the page
(refused), drive the browser as the person, and hand control back.

### 4.4 Cross-bot isolation

One bot is one Chromium, one profile, one pipe, one set of tokens. There is no shared
channel object between sessions, and the multiplexer's registry is per-browser, not global.
The E2E's phase 12 starts a second bot and asserts it has its own browser, its own tabs and
its own state; the registry tests assert path and credential separation; the load test's
eight viewers all attach to *one* bot's session and are counted there.

### 4.5 The fallback cannot be enabled by accident

`cdpTransportMode()` (`server/browser-launcher.mjs`):

- unset or empty → `pipe`;
- `pipe` → `pipe`;
- `tcp` → `tcp` (explicit opt-in, for development on a host where the pipe is being
  debugged);
- anything else → **throws**, at boot (`server/index.mjs` calls it before creating the
  manager) and again at each launch.

When tcp is deliberately selected, the server prints a startup warning naming the risk:

> `HOB_CDP_TRANSPORT=tcp: the managed browser exposes a raw loopback DevTools port that any
> local process can drive without the lease. This is a development fallback; leave the
> variable unset (pipe) in production.`

The gateway resolves the mode once into `#transportMode`, so `status().transport` reports
what is actually running even while stopped, and the dashboard shows it. `chromiumPort`
remains internal and is never serialised to a viewer.

### 4.6 The HTTP surface a CDP client sees

Hermes' browser tools use `browser.cdp_url`, which is HOB's own authenticated endpoint, not
Chromium's. That contract is unchanged in pipe mode; the gateway synthesises what a CDP
client expects:

| Endpoint | Pipe mode |
| --- | --- |
| `GET /json/version` | synthesized from `Browser.getVersion` (browser WebSocket URL points at the gateway) |
| `GET /json/list` | synthesized from `Target.getTargets` |
| `PUT /json/new?...` | creates a target through the lease-admitted path |
| `GET /json/protocol` | `404` — there is no local protocol document to serve, and serving one would add nothing |

---

## 5. Reliability and load

New suite: `server/test/browser-load.test.mjs` (5 tests, ≈19 s end to end). It drives the HTTP
surface with real tickets and real sockets, the same way the dashboard does.

| Scenario | What was driven | Result |
| --- | --- | --- |
| Eight simultaneous viewers | 8 tickets, 8 sockets, one animating page | all 8 received `hello` and frames; `status().viewers === 8`; a **9th is refused** before attachment and the eight keep their sessions |
| Slow consumer | one viewer stops reading (socket paused) while two keep reading | the other two keep receiving frames; the agent still evaluates in the page; the stalled viewer catches up and continues after resume |
| Viewer churn | 20 sequential open/close cycles | server-side count returns to 0 after each departure; a fresh viewer still streams; the browser is still `running` |
| Repeated idle shutdowns | 3 × (navigate → write `localStorage` → idle stop → `ensure`) | the **same `cdpUrl`** returns every time; the stored value survives each shutdown (`1`, `2`, `3`); measured profile growth **4.66 MB → 7.41 MB**, 191 files, largest `data_1=1584K`, `index=1538K`, `data_2=1072K` |
| Crash while watched | kill the browser's process tree by profile | the viewer is **not** dropped: it receives `{t:'error', code:'browser_crashed'}`, the browser restarts while watched, state returns to `running` on the same endpoint, and the same viewer receives frames again once a page is navigated |
| Orphan check | parent process exits abruptly with a live pipe browser | 0 Chromium processes immediately after, and after 2 s |

Ticket expiry got explicit coverage in `browser-routes.test.mjs`: a ticket minted with a
250 ms lifetime and **never used** is refused after 400 ms. (It is presented without the
session cookie, because a same-origin cookie is deliberately allowed to reconnect a
long-lived dashboard tab — that is the documented fallback, not a ticket bypass.)

Why the 8-viewer cap matters here: the screencast is one CDP stream fanned out, and the
gateway drops frames for a viewer whose socket buffer exceeds 8 MiB rather than queueing
them (`MAX_VIEWER_BUFFER`). The stalled-consumer test is what proves that policy is
effective instead of aspirational.

---

## 6. Linux and Docker

### 6.1 Docker is not available on this host

```text
> docker version
docker : The term 'docker' is not recognized …
> docker compose version
docker : The term 'docker' is not recognized …
```

**No container was built, started, stopped or measured in this phase.** Nothing in this
document claims otherwise. What follows is what *was* executed, and the exact commands that
remain.

### 6.2 Executed here — static and local

1. **Dockerfile review.** Both trees are copied into `/app` (`server/`, `deploy/`), so the
   probe's `import { PipeChromium } from '../server/browser-pipe.mjs'` resolves in the image.
   `browser-pipe.mjs` imports only `node:events`, so the probe adds no dependency.
2. **Compose review.** `stop_grace_period: 40s` is comfortably above the server's 25 s
   graceful-stop bound (`server/index.mjs` races `browser.shutdown()` against 25 s and then
   exits). `security_opt` points at `deploy/chromium-seccomp.json`, which exists and is valid
   JSON: `defaultAction=SCMP_ACT_ERRNO`, 8 architecture entries, 32 syscall groups, including
   `clone`, `clone3`, `pipe2` and `unshare` (the calls Chromium's zygote and the pipe path
   need). No service publishes the browser.
3. **The probe was rewritten and its mechanics were executed.** `deploy/probe-browser.mjs`
   used `/json/*` and a raw DevTools port; it now launches the image's Chromium with
   `--remote-debugging-pipe`, talks CDP through the real transport module, asserts namespace
   + seccomp-BPF sandbox layers from `chrome://sandbox`, asserts no `DevToolsActivePort`, and
   asserts the process tree listens on no TCP port (`pgrep` + `ss`, with an explicit
   `PROBE_NOTE` when those tools are absent). Its pipe/target/evaluate mechanics were run
   here against Windows Chrome: it created `chrome://sandbox` over the pipe, attached a
   page-bound channel and read the sandbox table. The Linux-only assertions then *failed* on
   the Windows table (`Process / Type / Name / Sandbox / …`), which is the expected result
   and demonstrates the check is not vacuous.
4. **`node --check`** passes for the probe and for every changed server file.
5. **The Linux code paths were reviewed**, not run: `ss`/`pgrep` process discovery, `ps`
   sampling in `measure-browser.mjs`, and `process.kill(-pid)` process-group shutdown in the
   probe (the Windows dry run cannot reach it).

### 6.3 Not executed — the exact remaining checklist

Run in the repository root on a host with Docker. Steps 2 and 9 are the two that this phase
added or changed.

```bash
# 1. Build and start. The browser transport needs no configuration: pipe is the default.
docker compose -f compose.yaml -f compose.standalone.yaml up -d --build

# 2. SANDBOX + PIPE + NO TCP DOOR (rewritten probe; this is the new gate).
#    Expect: SANDBOX_OK (<product>; zero TCP listeners) and exit 0.
docker compose exec muse node /app/deploy/probe-browser.mjs

# 3. The production launch path through HOB itself, inside the container.
docker compose exec muse node --test --test-timeout=120000 /app/server/test/browser-manager.test.mjs

# 4. No DevTools port anywhere after HOB has launched a browser.
#    (Run step 5 first, or open a bot in the dashboard, so there is a browser to inspect.)
docker compose exec muse sh -lc 'find /data -name DevToolsActivePort -print; echo ---; pgrep -af "chrome|chromium" | grep -v grep || echo NO_BROWSER'
docker compose exec muse sh -lc 'for p in $(pgrep -f chrome || true); do ss -ltnp 2>/dev/null | grep "pid=$p," ; done; echo LISTENERS_DONE'

# 5. The full pipe-mode suite in the container (70 tests; needs the browser).
docker compose exec muse node --test --test-reporter=spec --test-timeout=180000 --test-concurrency=1 /app/server/test/browser-pipe.test.mjs /app/server/test/browser-load.test.mjs

# 6. The live scenario (Hermes tools, takeover, restart, isolation, phase 17).
docker compose exec muse /opt/hermes/bin/python /app/server/e2e/hermes-tools-e2e.py

# 7. Linux resource numbers (same scenarios as §7).
docker compose exec muse node /app/server/measure-browser.mjs /tmp/hob-measure-linux.md
docker compose exec muse cat /tmp/hob-measure-linux.md

# 8. Namespace sandbox is available to the runtime user.
docker compose exec muse sh -lc 'unshare --user --map-root-user true && echo USERNS_OK'

# 9. SIGTERM with a browser running: exit code 0 (not 137), and no Chromium survives.
docker compose exec muse sh -lc 'pgrep -c chrome || true'      # a browser must exist first
docker compose stop muse
docker inspect -f '{{.State.ExitCode}}' "$(docker compose ps -aq muse)"   # expect 0
docker compose start muse
docker compose exec muse sh -lc 'pgrep -af "chrome|chromium" | grep -v grep || echo NO_CHROME'
```

What each unexecuted step would settle:

| Step | Question it answers | Why it matters |
| --- | --- | --- |
| 2 | Do the namespace and seccomp sandbox layers survive this image, and is the pipe the only channel? | a missing layer is a silent downgrade; the new listener assertion is the container proof of H1 |
| 3 | Does the real launch path (with `--restore-last-session`) start and stop in the image? | the probe hand-writes flags; this uses the product's own launcher |
| 4 | Is there no port after a *real* HOB launch, on Linux? | Windows assertion ported to the deployed platform |
| 5 | Do the 12 mux tests and 5 load tests pass on Linux? | fd behaviour and timing differ by kernel |
| 6 | Do Hermes' own tools work against the pipe in the container? | the entire point of the compatibility work |
| 7 | What does a browser cost on Linux? | sizing; §7 numbers are Windows |
| 8 | Is user-namespace creation allowed? | without it, the namespace sandbox layer is absent |
| 9 | Does SIGTERM produce a clean exit and no orphan? | `stop_grace_period` and the cookie flush depend on it |

### 6.4 Risk assessment for the unexecuted parts

- **Pipe fds on Linux.** Node's extra stdio fds are `pipe2`-created on POSIX and inherited by
  the child; the same five-entry `stdio` array is used on both platforms. This is ordinary
  Node behaviour, not a Windows-specific path. Confidence: high, unmeasured.
- **Sandbox.** The one real difference is that Windows checks a different sandbox table, so
  the probe's Linux assertions were only exercised negatively here. This is why step 2 is the
  first item on the checklist.
- **SIGTERM.** Windows cannot deliver a signal to a handler, so the path is unexecuted by
  construction. The code is bounded (25 s) and the graceful close itself is covered by tests;
  what is unproven is signal → handler → exit code.
- **Process-group kill.** The probe uses `process.kill(-pid)`, which requires the child to be
  its own process group leader (`detached: true`, set). This is the standard POSIX pattern
  but it has not run here.

---

## 7. Resource measurements

`server/measure-browser.mjs` now prints the configured transport and describes two browsers
as "separate pipes, tokens and profiles" when it is pipe mode. Full run, pipe mode, same
scenarios as Phase 2, 6 s sample windows, `maxFps=10`:

| Scenario | Browsers | Chromium processes | Chromium RSS (MiB) | Chromium CPU (%) | HOB server RSS (MiB) | HOB server CPU (%) |
| --- | --- | --- | --- | --- | --- | --- |
| idle host, no browser | 0 | 0 | 0 | 0 | 67 | 0 |
| 1 browser, 1 agent, no viewer, static | 1 | 10 | 493 | 12.8 | 68 | 2.1 |
| 1 browser, agent + 1 viewer, static | 1 | 9 | 477 | 23.7 | 68 | 0 |
| 1 browser, agent + 2 viewers, static | 1 | 10 | 542 | 20.6 | 69 | 0 |
| 1 browser, agent + 2 viewers, **animating** | 1 | 9 | 501 | **106.8** | 73 | 5.5 |
| 1 browser, agent only, animating (no screencast) | 1 | 9 | 484 | 6.0 | 72 | 0.3 |
| 2 browsers, one agent each, static | 2 | 19 | 975 | 19.5 | 72 | 0 |
| both browsers stopped by the idle policy | 0 | 0 | 0 | 0 | 72 | 0 |
| 1 browser after a fresh start | 1 | 10 | 490 | 30.2 | 73 | 1.6 |
| 1 browser after a crash and restart | 1 | 10 | 488 | 16.7 | 73 | 0 |

Against Phase 2 (TCP, run B from `production_hardening_measurements.md`):

| Scenario | TCP: procs / RSS / CPU / HOB RSS | Pipe: procs / RSS / CPU / HOB RSS |
| --- | --- | --- |
| 1 browser + agent, static | 10 / 487 / 10.2 / 68 | 10 / 493 / 12.8 / 68 |
| + 1 viewer, static | 9 / 472 / 12.5 / 70 | 9 / 477 / 23.7 / 68 |
| + 2 viewers, static | 9 / 477 / 21.9 / 70 | 10 / 542 / 20.6 / 69 |
| + 2 viewers, animating | 9 / 502 / 78.1 / 71 | 9 / 501 / 106.8 / 73 |
| 2 browsers | 19 / 971 / 14.3 / 71 | 19 / 975 / 19.5 / 72 |
| both stopped | 0 / 0 / 0 / 72 | 0 / 0 / 0 / 72 |
| fresh start | 10 / 487 / 16.7 / 72 | 10 / 490 / 30.2 / 73 |
| crash + restart | 10 / 484 / 20.8 / 72 | 10 / 488 / 16.7 / 73 |

What the comparison supports:

1. **Memory is unchanged.** Chromium RSS is within 1–3 % of the TCP numbers and HOB's own
   process stays flat at 67–73 MiB. The pipe does not add a queue, a thread or a buffer that
   shows up in the working set.
2. **The cost is still one Chromium per running bot** (~0.5 GiB, 9–10 processes), and a
   second bot is roughly double (19 processes, ~975 MiB). Sizing guidance is unchanged:
   ~0.5 GiB per concurrently running bot + ~75 MiB for HOB.
3. **The screencast, not the transport, is the CPU cost.** No viewer on an animating page:
   6 %. Two viewers: ~100 % of one core. This is Chromium's JPEG encoding at the 10 fps cap.
4. **The one number outside the earlier spread is the animating worst case** (106.8 % vs
   78.1–85.4 %). It is a single 6 s sample of a CPU-bound scenario on a host that was also
   running an editor and a browser, and the pipe does add a per-frame JSON parse and copy on
   HOB's event loop. It does not change the sizing conclusion, but it is not evidence of zero
   overhead, and the honest reading is "same envelope, possibly a few percent more CPU on a
   repainting page".
5. **Restarts and stops return to zero.** The stopped row is 0 processes / 0 % in both
   transports, and the crash/restart row accumulates nothing.

---

## 8. Tests and exact commands

### 8.1 Browser suite, both transports

```powershell
cd server
$env:HOB_CHROMIUM_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'
node --test --test-reporter=spec --test-timeout=180000 --test-concurrency=1 test/browser-*.test.mjs
# 70/70 pass, exit 0, 85.0 s   (pipe — the default)

$env:HOB_CDP_TRANSPORT='tcp'
node --test --test-reporter=spec --test-timeout=180000 --test-concurrency=1 test/browser-*.test.mjs
# 70/70 pass, exit 0, 93.7 s   (fallback)
Remove-Item Env:\HOB_CDP_TRANSPORT
```

| File | Tests | Adds in this phase |
| --- | --- | --- |
| `browser-pipe.test.mjs` | 12 | framing, backpressure, id isolation, private attach, auto-attach sharing + catch-up, event routing, page-channel hiding, id-less refusal, pipe loss |
| `browser-load.test.mjs` | 5 | 8 viewers, slow consumer, churn, 3 idle restarts, crash under a viewer |
| `browser-takeover-bypass.test.mjs` | 7 | H1 rewritten as "no DevTools TCP door"; `PUT /json/new` admitted like any mutation |
| `browser-routes.test.mjs` | 8 | unused-but-expired ticket refused |
| gateway / manager / lease / policy / registry | 38 | unchanged, re-run in both transports |

The 12 pipe tests, by name, are the contract of §2–§3:

```text
pipe framing: NUL-delimited JSON, coalesced and split across chunks
pipe framing: writes are framed in order, and a broken frame is not fatal
pipe framing: backpressure pauses writes and a drain resumes them in order
pipe framing: a frame past the limit fails the connection instead of growing
mux: two clients share one pipe without sharing an id space
mux: an explicit attach is private to the client that asked for it
mux: browser-level auto-attach is shared, but each client gets its own session
mux: target lifecycle events go only to clients that asked to discover
mux: session events reach the owning client only
mux: a page-bound channel hides the session id it rides on
mux: a command without an id is refused at the transport
mux: losing the pipe fails every waiter and closes every client
```

### 8.2 Live end-to-end (real Hermes tools, no mocks)

```powershell
cd server
$env:HOB_CHROMIUM_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'
& "$env:TEMP\opencode\hob-e2e-venv\Scripts\python.exe" e2e/hermes-tools-e2e.py
```

Result: **17 phases, 60 checks, 0 failures**, exit 0. The phases that matter most to this
document:

- 1 / 1b — `browser_navigate`, `browser_snapshot`, `browser_type`, `browser_click` against
  real pages (example.com, Wikipedia), with the click actually navigating;
- 2–6 — human takeover: the bot's mutation is refused, the person drives, control returns,
  the bot continues on the same page;
- 7–8 — idle shutdown and re-creation on demand;
- 11 — two viewers on one bot;
- 12 — a second bot with its own browser;
- 13 / 15 — a session cookie and `localStorage` written before the idle stop are still there
  after it (this is what forces the graceful-close ordering in §2.4);
- 16 — the browser is killed while the person holds control, and the system recovers;
- 17 — **no raw DevTools port** (dashboard `transport === "pipe"`, no `DevToolsActivePort`, no
  DevTools HTTP endpoint in any browser tree).

One flake was found and fixed while re-running this scenario. The post-handback check
asserted on the bot's *first* snapshot after control returned; Chromium can still be building
the accessibility tree for the document the person had just opened, and that snapshot is
legitimately empty (`frame_tree` correct, `element_count: 0`). The check now polls for up to
15 s, which is what the bot's own retry would do. The navigation immediately after it had
already succeeded, and the earlier run passed the same check — which is exactly what a race
looks like.

### 8.3 Server tests (non-browser) and frontend

```powershell
cd server
$files = Get-ChildItem test/*.test.mjs | Where-Object { $_.Name -notlike 'browser-*' } | ForEach-Object { $_.FullName }
node --test --test-reporter=spec $files        # 205/205, exit 0

cd ../web
npm run lint                                    # exit 0
npm run build                                   # exit 0 (tsc -b + vite build; known chunk-size warning)
```

One unrelated defect surfaced while running the wider suite and was fixed: `HermesBots.finishSetup`
did not await the registry write that marks a bot `active`, so it could answer "active" before
the state was durable and leave an unhandled rejection behind (`server/hermes-bots.mjs`). It is
awaited now; `hermes-bots.test.mjs` passes 10/10.

### 8.4 Nothing in Hermes changed

`git status` shows changes in `server/`, `web/`, `deploy/`, `Dockerfile` and `docs/` only —
no Hermes runtime, gateway or tool source. Hermes keeps calling `browser.cdp_url`; what sits
behind that URL changed, and the URL itself did not.

---

## 9. Remaining limitations

1. **Linux/container execution is outstanding** (§6). This is the only reason the verdict is
   CONDITIONAL.
2. **The TCP fallback restores H1 by design.** It is opt-in, validated, and warns at boot,
   but an operator who sets `HOB_CDP_TRANSPORT=tcp` in production has the Phase 2 exposure
   back. Nothing prevents that beyond the warning and the documentation.
3. **Auto-attach semantics are the multiplexer's, not Chromium's.** A client that enables
   auto-attach late receives private catch-up attaches (rather than the original session ids),
   and `setAutoAttach(false)` stops new adoptions without releasing sessions already handed
   out. Clients that expect the browser's exact ids must be adapted; Hermes' agent client is
   not affected because it adopts targets explicitly.
4. **`waitForDebuggerOnStart` is always false.** One pipe has one global value, and a pause
   would freeze the person's page (H4). A future client that genuinely needs debugger-on-start
   pausing cannot have it over the shared pipe.
5. **`Target.setDiscoverTargets` is aggregated.** One client disabling it does not stop
   discovery for another; disable is per-client in effect.
6. **No browser adoption in pipe mode.** There is no port to adopt, so a browser left behind by
   a dead gateway cannot be reused: it exits on pipe EOF (verified) and the next `ensure`
   launches a new one. A stale profile lock therefore surfaces as a launch failure quoting
   Chromium's stderr, not as a hang.
7. **The `SIGTERM` path is unexecuted on Windows** (§6.3, step 9).
8. **Long-horizon profile growth is unmeasured.** Three restarts grew a fresh profile from
   4.66 MB to 7.41 MB; there is still no retention or size cap on a bot's profile directory.
9. **`/json/protocol` is not served in pipe mode.** Tooling that fetches the protocol document
   from the agent's CDP URL gets 404; nothing in Hermes' browser tools needs it.
10. **No canvas cursor renderer in `@atriumjs/protocol`** (Phase 1 limitation): viewers see
    frames, not the OS cursor.

---

## 10. Conditions to move from CONDITIONAL to READY

1. Execute §6.3 in the image, and record the outputs (probe `SANDBOX_OK`, the empty
   `DevToolsActivePort`/listener scans, 70/70 browser tests, 60/60 E2E checks, exit code 0 on
   `docker compose stop`, `NO_CHROME` afterwards).
2. Run `server/measure-browser.mjs` on Linux and replace or annotate §7's Windows numbers.
3. Re-run the live E2E on Linux, so "pipe on Linux" is a measurement rather than an inference
   from "an fd pair is an fd pair".

Nothing in items 1–3 requires a design change. If one of them fails, the failure will be in
the environment (sandbox layers, seccomp profile, namespace policy), which is precisely what
the checklist isolates.

---

## Appendix — files and knobs

| Path | Role |
| --- | --- |
| `server/browser-pipe.mjs` | pipe transport + per-client multiplexer (new in this phase) |
| `server/browser-launcher.mjs` | transport selection, launch, pipe readiness, graceful close, stale-profile cleanup |
| `server/browser-gateway.mjs` | lease/policy/screencast; transport-agnostic; synthesised `/json/*`; reports `transport` |
| `server/browser-routes.mjs` | viewer tickets (15 min TTL, single use, 8 per bot), 8-viewer cap, status (no credentials, no port) |
| `server/browser-manager.mjs` | one session per bot, idle sweep (30 s; configurable in tests), crash restart |
| `server/test/browser-pipe.test.mjs` | transport/multiplexer contract (12) |
| `server/test/browser-load.test.mjs` | load and reliability (5) |
| `server/test/browser-takeover-bypass.test.mjs` | H1/H2/H3/H4 over the pipe, plus the HTTP tab endpoint |
| `server/e2e/hermes-tools-e2e.py` | 17 phases / 60 checks against real Hermes tools |
| `server/measure-browser.mjs` | 10-scenario resource probe (prints the transport) |
| `deploy/probe-browser.mjs` | container probe: sandbox + pipe + no TCP door |
| `deploy/chromium-seccomp.json` | 32 syscall groups, `SCMP_ACT_ERRNO` default |

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `HOB_CDP_TRANSPORT` | `pipe` | `pipe` (production) or `tcp` (development fallback; warns at boot; anything else throws) |
| `HOB_CHROMIUM_PATH` | auto-detect | Chromium executable |
| `HOB_BROWSER_IDLE_MS` | 10 min | idle window before a browser is stopped |
| `HOB_BROWSER_TRACE` | unset | path to record every CDP command that crosses a gateway (opt-in wire trace) |
| `HOB_STATE_DIR` | required | holds `browsers/<bot>/chromium` profiles |
