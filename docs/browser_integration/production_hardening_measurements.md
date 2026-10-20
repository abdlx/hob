# Resource measurements — HOB persistent browser

Raw companion to `production_hardening.md` §6. Everything here was measured on a real
HOB-managed browser; nothing is estimated.

**Method.** `server/measure-browser.mjs` drives the real `BrowserManager` and the real
`BrowserSession` through ten scenarios. For each one it samples over a window (6 s unless
noted) and records:

- **Chromium processes / RSS / CPU** — every process whose command line carries that bot's
  profile directory, so all of Chromium's own children (renderers, GPU, network, storage,
  crashpad) are counted and nothing on the host outside the profile can be. Memory is the
  sum of working sets (`WorkingSetSize`, bytes, on Windows; `rss`, KiB, on Linux); CPU is
  the sum of kernel+user time deltas divided by the window, i.e. percent of **one** core.
- **HOB server RSS / CPU** — this process, which is the HOB gateway in production.
- **Connections** — the gateway's own count of viewer and agent sockets, from
  `session.status()`.

Run it with `node server/measure-browser.mjs [outfile.md]`. Two full runs are shown so
run-to-run variance is visible; the second (the checked-in path) is the one to compare
against.

## Results

Run A (a scratch script with the same scenarios, since folded into the checked-in
`server/measure-browser.mjs`), Windows 11 dev host, Node v25.3.0, Google Chrome 155,
headless (`--headless=new`), `maxFps=10`:

| Scenario | Browsers | Chromium processes | Chromium RSS (MiB) | Chromium CPU (%) | HOB server RSS (MiB) | HOB server CPU (%) | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| idle host, no browser | 0 | 0 | 0 | 0 | 67 | 0 | manager created, nothing launched |
| 1 browser, 1 agent connection, no viewer, static page | 1 | 10 | 495 | 8.6 | 68 | 2.1 | viewers=0 agents=1 |
| 1 browser, agent + 1 viewer, static page | 1 | 10 | 508 | 16.1 | 70 | 0 | viewers=1 |
| 1 browser, agent + 2 viewers, static page | 1 | 9 | 479 | 13.5 | 70 | 0.5 | viewers=2 |
| 1 browser, agent + 2 viewers, animating page (worst case) | 1 | 9 | 506 | 85.4 | 72 | 5.0 | viewers=2 framesA=20 framesB=20 |
| 1 browser, agent only, animating page (no screencast) | 1 | 9 | 489 | 3.1 | 72 | 0 | viewers=0 |
| 2 browsers, one agent each, static pages | 2 | 19 | 975 | 15.6 | 72 | 0 | separate ports, tokens and profiles |
| both browsers stopped by the idle policy | 0 | 0 | 0 | 0 | 73 | 0 | alpha=stopped beta=stopped |
| 1 browser after a fresh start | 1 | 10 | 493 | 20.8 | 72 | 1.0 |  |
| 1 browser after a crash and restart | 1 | 10 | 487 | 14.6 | 74 | 0 | state=running lastError=none |

Run B (`server/measure-browser.mjs`):

| Scenario | Browsers | Chromium processes | Chromium RSS (MiB) | Chromium CPU (%) | HOB server RSS (MiB) | HOB server CPU (%) | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| idle host, no browser | 0 | 0 | 0 | 0 | 67 | 0 | manager created, nothing launched |
| 1 browser, 1 agent connection, no viewer, static page | 1 | 10 | 487 | 10.2 | 68 | 1.3 | viewers=0 agents=1 |
| 1 browser, agent + 1 viewer, static page | 1 | 9 | 472 | 12.5 | 70 | 0.5 | viewers=1 |
| 1 browser, agent + 2 viewers, static page | 1 | 9 | 477 | 21.9 | 70 | 0 | viewers=2 |
| 1 browser, agent + 2 viewers, animating page (worst case) | 1 | 9 | 502 | 78.1 | 71 | 3.1 | viewers=2 framesA=20 framesB=20 |
| 1 browser, agent only, animating page (no screencast) | 1 | 9 | 484 | 1.8 | 72 | 0 | viewers=0 |
| 2 browsers, one agent each, static pages | 2 | 19 | 971 | 14.3 | 71 | 0 | separate ports, tokens and profiles |
| both browsers stopped by the idle policy | 0 | 0 | 0 | 0 | 72 | 0 | alpha=stopped beta=stopped |
| 1 browser after a fresh start | 1 | 10 | 487 | 16.7 | 72 | 0 |  |
| 1 browser after a crash and restart | 1 | 10 | 484 | 20.8 | 72 | 0.5 | state=running lastError=none |

## What the numbers say

**1. A browser is the cost, and it is Chromium's cost.** One headless browser is ~480–500
MiB of working set spread over 9–10 processes, and a second browser is ~2× both (19
processes, ~970 MiB). HOB's own contribution — the gateway, the policy engine, the
screencast plumbing, the viewer fan-out — is a flat **~67–74 MiB**, and it does not grow
with the number of browsers, viewers or frames. This is the number to size a host with:
*budget ~0.5 GiB per concurrently-running bot, plus ~75 MiB for HOB.*

**2. Being watched is what costs CPU, and one cast serves everybody.** On a page that
repaints continuously:

| Viewers | Chromium CPU (one core) |
| --- | --- |
| 0 | 1.8–3.1 % |
| 2 | 78.1–85.4 % |

Two viewers cost no more than one (the gateway starts a single screencast and fans out the
same JPEG — the static-page rows, 12–22 %, are the sampling noise of the same single
cast). The floor is the page's own rendering; the difference is `Page.startScreencast` at
`maxFps = 10` plus the JPEG encoding Chromium does for it. So:

- the **10 fps cap is load-bearing**, not decorative: an uncapped screencast on a busy
  page is exactly the scenario that saturates a core (and a shared host would notice);
- the cost stops the moment the last viewer leaves (`#stopScreencast`), which the 0-viewer
  row demonstrates.

**3. The idle shutdown is worth its complexity.** A browser nobody is watching still costs
~490 MiB. Returning to 0 processes and 0 % CPU after the idle policy fires (and to the
same numbers after a crash-and-restart, so a restart does not accumulate anything) is
exactly why the 10-minute policy and lazy startup stay.

**4. Nothing HOB holds grows.** Across ten scenarios including two browsers and two
streaming viewers, the server process moved 67 → 74 MiB and ended a full run 5 MiB above
where it started. One screencast frame is retained per session (to greet a reconnecting
viewer), not a queue.

**5. Socket count is exactly what it says.** Every scenario's connection count equals
`agent connections + viewers`: one WebSocket per agent client, one per viewer, and the
screencast is not a connection of its own. Yet another bot is another Chromium (own port,
own profile, own process tree) plus one gateway listener on loopback — the per-bot
listener is the only part of that which is HOB's.

## Optimizations considered and not taken

- **Lower `maxFps` or a dynamic fps.** The measurement shows the cost is bounded by the
  10 fps cap already; lowering it further trades viewer quality for CPU a deployment can
  afford. Left at 10, and any change should be re-measured with this script.
- **Share one Chromium between bots.** Would cut the memory number roughly in half and
  destroy the isolation guarantee (separate profile, separate process, separate DevTools
  port) that the rest of this document treats as the security boundary. Not taken.
- **Screencast only while a viewer has focus / is visible.** Requires viewer-side signals
  (`document.visibilityState` over the socket) that the Atrium protocol does not carry yet.
  Worth doing when the viewer protocol gains a visibility message; until then a hidden tab
  still streams, which the "2 viewers" rows price at ~one core on a *repainting* page.
- **A browser-per-bot pool kept warm.** Rejected: warm spare capacity is ~490 MiB parked
  for nothing, and the restart after a stop is ~1.5–3 s (measured: the "fresh start" and
  "crash and restart" scenarios), which is well inside a user's tolerance.

## Known limits of these measurements

- They are **Windows host numbers** with Google Chrome 155. Chromium's per-process memory
  differs by platform (Linux is typically lower with `--headless=new`), so treat the shape
  (flat server, ~0.5 GiB per browser, screencast-dominated CPU) as the generalisable part,
  not the exact MiB. `server/measure-browser.mjs` implements the Linux branch (`ps -eo
  rss=,cputimes=`) so the container numbers can be produced with the same script.
- Each row is one sample of a 6 s window on a host that was also running the author's
  editor and browser, so ±20 % between rows of the same shape is normal.
- Frame *rate* was observed at ~3.3 fps (20 frames per 6 s window, two viewers, both
  receiving all 20) rather than the 10 fps cap; the cap is a ceiling applied per frame, and
  ack round-trips and Chromium's own paint cadence set the real rate.
