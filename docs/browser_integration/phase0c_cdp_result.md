# Phase 0C — HOB → Hermes native browser tools → CDP: proof of concept

**Scope:** investigation and live proof only. No part of the HOB browser subsystem was implemented,
and **no Hermes source was modified** (upstream tree untouched; all wiring was `config.yaml` +
externally launched browsers + throwaway harness scripts under `.tmp-runtime/`).

**Result: PASS**, with four concrete findings HOB must design around (F1–F4 below), one of which
(`browser_cdp` bypasses the human-takeover lease) changes the takeover design.

Runtime under test: the locally pinned Hermes checkout (`hermes-agent/`), byte-identical to the
commit HOB pins in `Heres-runtime-image.yml` (`HERMES_COMMIT=7e9eb8d9a30f4a9bb9f8ecaf816b4b0ffdf47357`).
External browser: **Chrome 155.0.8059.82**. Host: Windows, no network.

---

## 1. What was actually run

Harness (throwaway, under `.tmp-runtime/p0c-cdp/`, nothing in HOB `src/`):

| Piece | Purpose |
|---|---|
| `stub_llm.py` | A real OpenAI-compatible **provider** stub (not a Hermes mock). It scripts a sequence of native `browser_cdp` tool calls and records every request body, so the JSONL contains Hermes's *actual* tool results. |
| `poc.mjs` | Drives HOB's real `createSessionBootstrap` + `HermesSessionBridge` (`server/hermes-session.mjs`): `session.create` + `prompt.submit` over the real ticketed `/api/ws`. |
| `frames.py` | A second, independent CDP client — stands in for Atrium's React viewer (`Page.startScreencast`). |
| `manual_cdp.py`, `probe_*.py` | Isolation probes. |

Everything below is real: real gateway, real canonical session, real tool registry, real
`browser_cdp` handler, real `websockets` CDP client, real externally launched Chromium.

Reproduce (per phase) exactly as run:

```powershell
# external Chromium, dedicated persistent profile, private (loopback) CDP endpoint
chrome.exe --headless=new --remote-debugging-port=9222 `
  --user-data-dir=<state>\chromium-a --no-first-run --no-default-browser-check `
  "data:text/html,<title>BEFORE</title><h1 id=x>before</h1>"

# Hermes profile config (config.yaml only — no source change)
#   browser: { backend: off, allow_private_urls: true, cdp_url: http://127.0.0.1:9222 }
$env:HERMES_HOME=<...>\p0c-cdp\home; $env:HERMES_RUNTIME_DIR=<...>\state
hermes.exe gateway run --no-supervise -v

# HOB's own transport client
$env:HERMES_DIR=<...>\hermes-agent; $env:HERMES_HOME=<...>\home; $env:HERMES_PYTHON=<venv>\python.exe
node poc.mjs          # session.create -> prompt.submit -> real browser_cdp turns
```

### The headline proof (run 1)

Canonical session `local-4b57148e4f2782bc56fa4bd8c0bec52347d0a2e187de17cd2abb81d819006ba2`,
`prompt.submit` → the model (stub) emitted `browser_cdp`, and Hermes executed it for real:

```
tool.start    browser_cdp {"method":"Target.getTargets","params":{}}
tool.complete browser_cdp is_error=False 0.028s ->
              {"success": true, "method": "Target.getTargets", "result": {"targetInfos":[
                 {"targetId":"34642FE7…","type":"page","title":"BEFORE",
                  "url":"data:text/html,<title>BEFORE</title><h1 id=x>before</h1>", …}, …]}}

tool.start    browser_cdp {"method":"Runtime.evaluate","target_id":"34642FE7…",
              "params":{"expression":"document.title='HERMES-CDP-POC-OK';…","returnByValue":true}}
tool.complete browser_cdp is_error=False 0.016s ->
              {"success": true, "method":"Runtime.evaluate",
               "result":{"result":{"type":"string","value":"ok"}},"target_id":"34642FE7…"}

message.complete "POC-COMPLETE"
```

Independent observation, taken through **Chrome's own HTTP endpoint** (nothing to do with Hermes):

```
$ curl http://127.0.0.1:9222/json/list
title : HERMES-CDP-POC-OK          <-- was "BEFORE"
url   : data:text/html,<title>BEFORE</title><h1 id=x>before</h1>
```

No second browser was launched: the only process with a debug port is the one launched *before*
Hermes ran, on the `chromium-a` profile (all other `chrome.exe` processes are the user's normal
profile with no debug port).

---

## 2. Point 1 — is `browser.cdp_url` supported, and does it affect canonical sessions?

**Yes.** The override is read in the **agent process**, so it is transport-agnostic — it applies to
canonical `prompt.submit` turns exactly as it does to interactive CLI sessions.

Source chain:

- `tools/browser_tool_cdp.py::_get_cdp_override_raw()` — `BROWSER_CDP_URL` env, else the config key
  `browser.cdp_url` via `read_raw_config()` (profile-scoped).
- `tools/browser_tool_cdp.py::_resolve_cdp_override()` — an `http://…:9222` value is upgraded by
  fetching `/json/version` and taking `webSocketDebuggerUrl`.
- `tools/browser_tool.py::_browser_cfg(key, …)` — reads `browser.<key>` from the active profile's raw config.
- `tools/browser_tool_install.py::check_browser_requirements()` — returns `True` immediately when a
  CDP override is set (no local browser stack needed).

Live confirmation (probe under `HERMES_HOME=<…>\home`):

```
read_raw_config browser section: {'backend': False, 'cdp_url': 'http://127.0.0.1:9222', …}
_get_cdp_override_raw(): 'http://127.0.0.1:9222'
check_browser_requirements(): True
_browser_cdp_check: True
```

### F1 — `browser.cdp_url` alone is **not** sufficient (finding)

On this runtime the browser backend defaults to the **Browser Use CLI**, because `browser-harness`
is a core dependency. In that mode `browser_exec` *replaces* the built-in `browser_*` tools and
`_browser_cdp_check()` is `False` even with `browser.cdp_url` set. Observed at boot:

```
check_fn _browser_cdp_check returned False; dependent tools will be unavailable this turn
check_fn check_browser_navigate_requirements returned False; …
```

`tools/browser_use_cli.py::get_browser_backend()` / `is_browser_use_cli_mode()`: unset → Browser Use
when the CLI is available; `backend: off` → `BACKEND_DISABLED` → built-in tools. After adding
`browser.backend: off`:

```
is_browser_use_cli_mode: False
_browser_cdp_check: True
```

**Consequence for HOB:** wiring a bot to a CDP endpoint needs `browser.backend: off` (plus
`cdp_url`). Setting only `cdp_url` silently yields the Browser Use CLI toolset instead. (YAML note:
unquoted `off` parses as boolean `False`, which `get_browser_backend()` maps to `BACKEND_DISABLED`
on purpose — so both `off` and `"off"` work.)

---

## 3. Point 2 — external Chromium, dedicated profile, private endpoint, no source change

**Yes.** Chrome was launched externally with a dedicated persistent `--user-data-dir` and
`--remote-debugging-port=9222`. The DevTools server binds loopback by default (`--remote-debugging-address`
was not set), and `/json/version` confirms `ws://127.0.0.1:9222/devtools/browser/…`. Hermes was
pointed at it purely through `browser.cdp_url` — no source edit, no patch.

This mirrors Hermes's own Bot-Desktop model (`tools/bot_desktop/browser.py:1-9`): one executable, one
persistent `--user-data-dir`, the human's dock instance and the agent share it, and the agent
**attaches** (`running_instance_cdp_port`) rather than launching. That is the shape HOB should copy.

---

## 4. Point 3 — a real native browser tool op through a canonical session

**Yes — proven end-to-end** (see §1). Hermes's own tool result shows the **external** browser's
targets, and the page mutation is confirmed by Chrome's HTTP endpoint. `browser_cdp` is a genuine
native Hermes browser tool (`tools/browser_cdp_tool.py`, toolset `browser`, gated by
`_browser_cdp_check`).

### F2 — the CDP override is deliberately treated as *non-local*, so the SSRF guard engages (finding)

`tools/browser_tool_cloud.py:166-176`:

```python
def _is_local_backend() -> bool:
    if _cdp._get_cdp_override_raw():
        return False        # "A CDP override is never trusted as local"
```

With a CDP override, `_eval_ssrf_guard_active()` is therefore `True`
(`tools/browser_tool_eval_policy.py:15-23`), which turns on two guards in `browser_cdp`:

1. `_METHOD_PARAM_GUARDS` (`browser_cdp_tool.py:132-137`) — `Page.navigate` and `Runtime.evaluate`
   are blocked when the target is judged private/internal. `data:` URLs are rejected
   (`tools/url_safety.py` → *unsupported URL scheme*).
2. For any method **outside** `_CDP_PRIVATE_PAGE_ALLOWED_METHODS`
   (`Browser.getVersion, Target.getTargets, Target.attachToTarget, Target.detachFromTarget,
   Page.navigate, Page.reload, Page.stopLoading`, lines 25-28), Hermes probes the current page URL via
   `policy._current_page_private_url()` → `_session._run_browser_command(...)`, i.e. it shells out to
   the **`agent-browser` CLI**.

Observed live: `Runtime.evaluate` → `Preparing the isolated Hermes runtime…` → PM lazy-install →
offline stall, then `Blocked: page URL targets a private or internal address (data:…)`; and
`Page.navigate` → `Blocked: CDP Page.navigate target is a private or internal address (data:…)`.

Turning it off with the documented knob `browser.allow_private_urls: true` made
`_eval_ssrf_guard_active() == False`; both guards are then skipped and `Runtime.evaluate` succeeded
(the run-1 proof above). **HOB must decide this explicitly**: for a loopback, HOB-owned Chromium that
must reach the bot's internal web UI, `allow_private_urls: true` is the correct setting — and it is
the only way to use non-allow-listed CDP methods without `agent-browser` present.

---

## 5. Point 4 — per-bot `browser.cdp_url`, no cross-bot leakage

**Yes.** Two independent profiles, two independent gateways, two Chromiums, two model endpoints:

| | profile `home` | profile `home-b` |
|---|---|---|
| `browser.cdp_url` | `http://127.0.0.1:9222` | `http://127.0.0.1:9223` |
| model `base_url` | `http://127.0.0.1:8799/v1` | `http://127.0.0.1:8800/v1` |
| CDP endpoint Hermes resolved (from each gateway log) | `… -> ws://…:9222/…` | `… -> ws://…:9223/…` |
| page after the bot's turn | **HERMES-BOT-A** | **HERMES-BOT-B** |

Each bot's turn mutated only its own browser. `cdp_url` is read from the profile's raw config
(`_browser_cfg` → `read_raw_config()`), so isolation is profile isolation — nothing global. Note that
`BROWSER_CDP_URL` **env** is process-global; HOB must use the **config key**, not the env var, to keep
bots isolated.

---

## 6. Point 5 — CDP connection init/caching, on-demand launch, idle shutdown

`browser_cdp` is **stateless per call**: with no `frame_id`, `tools/browser_cdp_tool.py:304` does
`_run_async(_cdp_call(endpoint, …))` — a fresh `websockets.connect` per tool call, against an endpoint
that `_resolve_cdp_endpoint()` re-resolves (HTTP `/json/version`) on **every** call
(`tools/browser_tool_cdp.py`). The supervisor path (`_browser_cdp_via_supervisor`) is only used when
`frame_id` is supplied (OOPIF routing).

Live resilience test — kill the browser, then a tool call, then relaunch:

```
STEP 1  shut the external browser down (simulating HOB's idle reap)  -> 9222 is gone
STEP 2  tool call while down: is_error=True
        {"error":"CDP endpoint is not a WebSocket URL: 'http://127.0.0.1:9222'. … Check that a
          Chromium-family browser is actually listening on the debug port."}
        final: POC-FAILED…            <-- clean failure, turn still completed, gateway healthy
STEP 3  relaunch on the SAME port/profile  ->  Chrome/155.0.8059.82
STEP 4  next turn: is_error=False, is_error=False; final: POC-COMPLETE
        page title now: HERMES-BOT-A
```

**Answer: yes.** HOB can launch browsers on demand and reap them after genuine inactivity; the very
next tool call recovers with no cached/broken state, because nothing persists across calls.

For the *managed* path (the high-level `browser_navigate`/`click`/`snapshot` tools, which go through
`agent-browser`), lifecycle is different and already exists: a Python janitor with
`browser.inactivity_timeout` (default 120 s, 30 s floor; `tools/browser_tool.py`) plus daemon-side
`AGENT_BROWSER_IDLE_TIMEOUT_MS` self-termination, and `SUPERVISOR_REGISTRY.get_or_start(task_id,
cdp_url)` caching one supervisor per `(task_id, cdp_url)`. In run logs Hermes also emitted
`Started inactivity cleanup thread (timeout: 60s)` and `Created CDP browser session cdp_… → ws://…`.

Caveat: the "browser down" error message is misleading (it reports *"not a WebSocket URL"* rather than
*"browser unreachable"*) because the `/json/version` discovery fails and the raw `http://` value is
returned. HOB should not surface it to users verbatim.

---

## 7. Point 6 — exclusive human takeover

**Hermes's browser backend does not pause, intercept or serialize CDP commands.** There is no CDP
proxy/queue anywhere in the tool path. Exclusivity is a **cooperative, tool-level lease**, and it has
two gaps that matter to HOB.

The mechanism (source-verified):

- `tools/bot_desktop/lease.py` — authority lives **on disk** at
  `<HERMES_HOME>/bot-desktop/lease.json`, guarded by an `fcntl` lock (`_locked`, lines 124-142);
  `human_holds()` (line 229), `acquire()`, `release()`, `HumanHasControl`.
- `tools/browser_tool_session.py:211` `human_holds_shared_browser(session_info)`; the fence wrapper
  `run_fenced(...)` returns `{"success": False, "code": "human_has_control"}` (lines ~815-818).
- Applied in `tools/browser_tool.py:1115-1119` — *"the Bot Desktop lease fence has to bracket it here
  too … Same fence, same session identity."*

### F3 — `browser_cdp` is **not** fenced (finding)

Grep for `fence|human_has_control|bot_desktop|lease` in `tools/browser_cdp_tool.py` returns nothing.
The raw-CDP escape hatch therefore **bypasses the human-takeover lease**; a bot whose model reaches for
`browser_cdp` acts on the page while a human holds control. HOB cannot rely on the lease alone.

### F4 — the lease's cross-process lock is a **no-op on Windows** (finding)

`tools/bot_desktop/lease.py:34-36`: `import fcntl` is wrapped in `try/except ImportError`, and on
Windows `fcntl = None` — the module's own comment calls the cross-process lock a *degraded no-op*
there. So on Windows hosts the on-disk lease is advisory at best, and two processes can race it.

Independently, CDP itself is not exclusive: a **second client attached to the same page target at the
same time as Hermes** (proven in §8 — Hermes's own `Target.getTargets` reported that page
`"attached": true`). Any CDP client can drive any target; a CDP *connection* confers no ownership.

**Conclusion:** HOB must own exclusivity **outside** Hermes — a HOB-side arbiter that (a) serializes
all CDP traffic through a single owner, and (b) gates the bot's browser tools on that owner, rather
than trusting Hermes's lease. See §9.

---

## 8. Point 7 — observing agent cursor/element actions

Native tool events **do** carry the tool call and its result — this is exactly what HOB's canonical
transport already surfaces (`tool.start` / `tool.complete`, with `payload.args`, `payload.tool_name`,
`payload.result`, `payload.is_error`, `payload.duration_s`). Live example from run 1:

```
tool.start    browser_cdp {"method":"Runtime.evaluate","target_id":"34642FE7…",
                           "params":{"expression":"document.title='HERMES-CDP-POC-OK';…"}}
tool.complete … "result":{"result":{"type":"string","value":"ok"}},"target_id":"34642FE7…"
```

But the native high-level tools are **ref-based, not coordinate-based**:

```
browser_click.description: "Click on an element identified by its ref ID from the snapshot
                            (e.g., '@e5') … Requires browser_navigate and browser_snapshot first."
browser_click.parameters:  ref (required)   [no x/y]
browser_type.parameters:   ref (required), text (required)
```

**Answer:** for `browser_click`/`browser_type`, HOB observes an intent (`ref` + which tool) — **not**
pixel coordinates, and not hover/move gestures at all. To draw an agent cursor HOB must resolve
geometry itself over CDP (`DOM.getBoxModel` / `Page.getLayoutMetrics` / `DOM.getDocument`) using the
same connection, keyed to the event's timestamp. If the bot used `browser_cdp` directly, HOB may see
`Input.dispatchMouseEvent` params verbatim — but that is model-dependent, not guaranteed.

---

## 9. Point 8 — Atrium's viewer consuming frames from the same Chromium

**Yes — proven.** While Hermes controlled the page, a **second, independent CDP client** attached to
the same page target and consumed `Page.startScreencast` frames:

```json
{ "browser": "Chrome/155.0.8059.82",
  "page_url": "data:text/html,<title>BEFORE</title><h1 id=x>before</h1>",
  "frames_consumed": 4, "first_frame_bytes": 12628, "last_frame_bytes": 15880,
  "distinct_frame_hashes": 2 }
```

frames written: `frame-first.png` (9470 B), `frame-last.png` (11909 B) — and Hermes's own
`Target.getTargets` for that same turn reported the page `"attached": true` (my viewer's attachment).
Hermes neither noticed nor needed to: the viewer is an orthogonal consumer. This is precisely the
Atrium topology — a HOB-owned CDP reader alongside the agent on one Chromium.

---

## 10. Comparison — direct Hermes→Chromium CDP vs Hermes→HOB-controlled CDP proxy

How HOB would deliver a proxy today, without touching Hermes: point `browser.cdp_url` at a
HOB-owned **CDP multiplexer** on loopback, which owns the real browser's WebSocket and forwards
frames/commands, and which can also feed Atrium.

| Dimension | Direct Hermes → Chromium (`cdp_url` = browser) | Hermes → HOB CDP proxy (`cdp_url` = proxy) |
|---|---|---|
| **Latency** | Lowest. One loopback hop; per-call connect + `/json/version` discovery (~0.02–0.04 s observed per tool call). | Adds one hop + a demux/re-serialize per command. On loopback, sub-millisecond to low-millisecond — negligible against tool-call and model latency (the run's tool calls were 16–28 ms end-to-end). |
| **Throughput/streaming** | Screencast frames must be pulled by a second client (§9 works). | Proxy can fan out one screencast to many viewers (Atrium + recorder + audit) without extra browser sessions — better for multi-viewer. |
| **Security** | DevTools HTTP/WS is loopback-only and **unauthenticated**. Any local process can attach and drive the browser. With `allow_private_urls: true`, the bot can reach loopback/internal hosts. | Proxy can bind to a per-bot socket, authenticate (token/mTLS), and allow-list methods/hosts. HOB becomes the single SSRF/authorization choke point instead of relying on Hermes's guard (which F2 shows misfires on a loopback override). |
| **Resource usage** | Cheapest — no extra process. Each client holds its own WS. | One extra process + one extra socket per bot; trivial next to a Chromium. Enables *one* browser for both the agent and the human/Atrium instead of duplicating sessions. |
| **Takeover enforceability** | **Weak.** Hermes's lease does not cover `browser_cdp` (F3) and its lock is a no-op on Windows (F4); CDP is not exclusive. Two writers can interleave. | **Strong.** Because *all* CDP traffic (agent + Atrium + human) traverses one HOB-owned point, HOB can serialize: queue/token-gate commands, drop the bot's commands while a human holds the token, and only then hand over. This is the only place exclusivity can actually be enforced. |
| **Observability** | Tool events only (method/args/result; no coordinates — §8). | Full protocol visibility: every CDP method, timing, and frame — enough to derive coordinates and audit. |
| **Compatibility risk** | Zero moving parts. | Must faithfully speak CDP (sessions, `Target.attachToTarget` flatten, `Page.screencastFrameAck`) or tools break in confusing ways. |

**Recommendation:** ship **both**, staged.

1. **Phase 1 — direct CDP** (`browser.backend: off`, `browser.cdp_url` → HOB-launched Chromium,
   `browser.allow_private_urls: true` for loopback bots). Fastest to a working bot, and it is what
   this PoC proves. Atrium reads frames as a second client (§9). Accept that takeover is advisory.
2. **Phase 2 — HOB CDP proxy** as `cdp_url`. This is the design that makes exclusive human takeover
   real (F3/F4) and gives HOB authorization, auditing and a single screencast fan-out. Keep the same
   config surface, so switching is a one-line change.

Do **not** rely on Hermes's `bot-desktop` lease for takeover on Windows (F4), and do **not** rely on
the intended lease coverage of browser tools while `browser_cdp` is reachable (F3).

---

## 11. Blockers and caveats (explicit)

1. **`agent-browser` is not installed and cannot be installed here (no network).** The high-level
   tools (`browser_navigate`/`browser_click`/`browser_snapshot`) therefore **could not be exercised
   live**; `hermes pm install agent-browser` fails offline. The PoC used `browser_cdp` — a real native
   Hermes browser tool that exercises the same `_get_cdp_override` resolution and a real CDP
   round-trip — which is why points 1/3/4/5/8 are nonetheless genuinely proven. The `agent-browser`
   path is source-verified (`tools/browser_tool_session.py`, `--cdp` attach), not live-verified.
2. **Offline PM lazy-install stall.** The private-page probe (§4) shells out to `agent-browser`; with
   no network, PM attempted an isolated-runtime install and stalled ~124 s before failing. Live impact:
   any non-allow-listed `browser_cdp` method without `allow_private_urls: true` can hang for minutes.
3. **`browser.allow_private_urls: true` is required** for `Runtime.evaluate`/`Page.navigate` against
   `data:`/loopback targets — a real security tradeoff HOB must own deliberately, not incidentally.
4. **`browser.backend: off` is required** (F1) or the built-in browser tools are replaced by the
   Browser Use CLI.
5. **Takeover gaps F3/F4** — see §7.
6. **Environment artifact (not a Hermes bug):** the scratch venv's `openai` package broke with
   `ModuleNotFoundError` because a deep path exceeded Windows `MAX_PATH` (264 chars). Worked around
   with a `subst H:` mapping for the harness only. Recorded because it cost real time and will recur
   for anyone testing from a long repo path.
7. Prior Phase 0 blocker unchanged: `browser.controller.register` over `/api/ws` fails
   (`session is not owned by this transport`) because canonical sessions are not stamped with
   browser-control identity — so HOB's *extension* broker path remains separate from this tool path.

---

## 12. Verdict

The architecture question is answered **yes**:

- `browser.cdp_url` is honored in the agent process and applies to canonical `prompt.submit` turns.
- Hermes can be pointed at an **externally launched, HOB-owned** Chromium with **zero source changes**,
  and a real native browser tool drives it.
- Configuration is **per-profile**, so per-bot browsers are isolated with no cross-bot leakage.
- CDP is **stateless per call** for `browser_cdp`, so HOB may launch on demand and reap on idle
  without breaking later tool calls.
- Atrium can consume frames from the same Chromium concurrently.

The two things that must not be assumed: `browser.cdp_url` alone does not enable the built-in tools
(F1), and a CDP connection does not give exclusive human takeover (F3/F4) — which is the concrete
argument for the **HOB-side CDP proxy** in Phase 2.

Evidence: `.tmp-runtime/p0c-cdp/evidence/` (`run1-*` canonical proof + gateway log,
`run2-atrium-viewer-summary.json`, `run3-bot{A,B}.*` isolation, `events-down.json` +
`events-recovered.json` lifecycle). Harness: `.tmp-runtime/p0c-cdp/{stub_llm.py,poc.mjs,frames.py,
manual_cdp.py,probe_*.py}`.
