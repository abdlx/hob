# Phase 0 — real integration test result: **FAILED**

Tested against the **pinned runtime**, not mocks: the local editable Hermes install whose
`gateway/browser_control_broker.py`, `tui_gateway/methods_browser_control.py`,
`tui_gateway/ws.py`, `tui_gateway/ws_legacy_fallback.py`, `gateway/session_controls.py`,
`gateway/run_api.py` and `tools/browser_extension_router.py` are byte-identical (SHA-256) to the
`hermes-agent/` reference tree for the commit HOB pins
(`Heres-runtime-image.yml: HERMES_COMMIT=7e9eb8d9a30f4a9bb9f8ecaf816b4b0ffdf47357`).

## What was run

1. Boot a real gateway with an isolated home:

   ```powershell
   $env:HERMES_HOME  = "<repo>\.tmp-runtime\p0-browser\home"
   $env:HERMES_RUNTIME_DIR = "<repo>\.tmp-runtime\p0-browser\state"
   hermes.exe gateway run --no-supervise -v
   ```

   `config.yaml`:
   ```yaml
   gateway: { multiplex_profiles: false }
   terminal: { cwd: .../workspaces/main }
   model: { provider: auto, default: nous/hermes-4-405b }   # required, see finding C
   browser: { extension_control: { enabled: true } }
   ```

2. Mint a real session ticket with HOB's own bootstrap (`deploy/hermes-session-bootstrap.py`):
   ```json
   {"url":"ws://127.0.0.1:52771/api/ws",
    "protocols":["hermes-gateway-v1","hermes-gateway-ticket.S5VgM7mQ_..."],
    "profile_id":"...\\p0-browser\\home","instance_id":"8fec59f2ce09487c831c360fab3eadb6"}
   ```

3. Drive the connection with HOB's real client code (`server/hermes-session.mjs`:
   `createSessionBootstrap` + `HermesSessionBridge`) — no mock WebSocket.
   Probe: `.tmp-runtime/p0-browser/phase0.mjs`.

## Observed results (verbatim)

```
[session.create] { "session_id": "local-44c584cabf90857bac735eb4ee940c2bec5f65d078530854a6c2dbb1fc0a3896",
                   "authority_epoch": 1, "subscription_id": "ca74de8ba7a5471cb5400c51084cfc75", ... }

[browser.controller.register FAILED]  raw frame error:
   {"code":4403,"message":"session is not owned by this transport"}

[prompt.submit] { "admission_id": "eed00e8e57674adf98a4cd6983e99242", "status": "queued", ... }

[controller command received] null
[event types observed] ["sessions.changed","platforms.changed", ...]   # no browser.controller.command
```

The ticket, identity and authority all work: `session.create` succeeds, `prompt.submit` is admitted
and a real turn executes (it failed only because the test home has no provider credentials).
**Controller registration is refused.** Therefore no `browser.controller.command` is ever emitted and
no `browser.controller.result` round-trip is possible. Phase 0 cannot pass as specified.

## Blocker A (fatal, observed) — register is gated on the *legacy* session map

`browser.controller.register` is **not** in `CANONICAL_METHODS`, so `_dispatch_request`
(`tui_gateway/ws.py:342-354`) falls through to the legacy handler — which is allowed for an
interactive actor. The legacy handler then fails its session gate:

- `tui_gateway/methods_browser_control.py:106-114`
  ```python
  session_id = str(params.get("session_id") or "")
  with _sessions_lock:
      session = _sessions.get(session_id)              # legacy tui_gateway.server._sessions
      if not _session_transport_contains(session, transport):
          return _err(rid, _ERR_FORBIDDEN, "session is not owned by this transport")   # <- 4403
  ```
- `tui_gateway.server._sessions` is populated **only** by the legacy create path
  (`tui_gateway/methods_session.py:415  _sessions[sid] = {`).
- HOB creates sessions with the **canonical** `session.create`
  (`server/hermes-canonical-chat.mjs:141`), which the authority handles
  (`gateway/session_controls.py:create/_create`). Canonical sessions live in `authority.sessions`
  and the `SessionDB`; **nothing mirrors them into `tui_gateway.server._sessions`.**

Identity is *not* the problem: the gate at `:104` (`_is_authenticated_identity`) passed, i.e. HOB's
ticket-minted `auth_identity` is accepted. The failure is purely the legacy session-map lookup.

## Blocker B (independent, would be fatal even if A passed) — the canonical turn never stamps the controller identity

The agent-side router only routes to a controller when the turn's session context carries a bound
identity:

- `tools/browser_extension_router.py:29-37`
  ```python
  def _bound_identity():
      from gateway.session_context import get_session_env
      return tuple(get_session_env(key, "") or None for key in (
          "HERMES_SESSION_ID", "HERMES_BROWSER_CONTROL_PRINCIPAL",
          "HERMES_BROWSER_CONTROL_TRANSPORT_FAMILY"))
  ```
- `:78-79` — no bound principal/family ⇒ `fallback()` (the legacy local browser), never the broker.

Those two env keys are set from exactly two places:

1. `tui_gateway/server.py::_set_session_context` (`:1046-1071`) — the **dashboard / tui_gateway** turn
   path.
2. `gateway/platforms/api_server*.py` (`:48-51` ContextVars, stamped `:1632-1640`) — the **api_server**
   turn path, surfaced to the runner by `gateway/session_api_turn.py::api_session_vars` (`:108-118`)
   and bound in `gateway/run.py::_set_session_env` (`:4009-4012, 4030`).

The canonical `prompt.submit` path runs the turn through the gateway runner
(`gateway/run_turn_runner.py`, `platform=local` — seen in the live log) and calls
`set_session_vars(...)` **without** any browser-control fields; `session_controls.py` /`session_authority.py`
never stamp them, and the canonical `prompt.submit` param allowlist has no `browser_control` key
(`session_api_turn._valid_browser_control` accepts only `local-api`/`remote-api`, which only the
api_server middleware produces). So a controller registered over `/api/ws` could never receive a
command from a canonical turn.

**Conclusion:** the plan's Part 1 premise — "HOB already uses the dashboard transport, so identity
matches" — conflates `tui_gateway` (dashboard/legacy) with the canonical native session authority
HOB actually dials. It is false.

## Finding C (environment, not architectural) — `session.create` needs a configured model

With no model configured, canonical `session.create` fails `4001 storage_unavailable`:
`gateway/session_local.py::stage_local_session` falls back to
`_resolve_gateway_model(config)`, and `gateway/session_policy.py::restore_policy` (`:695-704`) rejects
a policy whose `model` is empty. HOB's `deploy/seed-hermes-config.mjs` seeds no model, so the UI must
pick one before sessions work; the local test home needed
`model: {provider: auto, default: nous/hermes-4-405b}`.

## The supported seam (source-verified) and its prerequisites

The **only** transport in this runtime that both (a) accepts a controller and (b) stamps the turn
identity is the **api_server**, not the dashboard `/api/ws`:

- `POST /v1/browser-control/register` + `GET /v1/browser-control/ws`
  (`gateway/platforms/api_server.py:100-101, _handle_browser_control_register:2501, _handle_browser_control_ws:2580`),
  protocol `hermes-browser-control-v1`, gated on `browser.extension_control.enabled` **and** an API
  key; the session must exist in the profile's `SessionDB` (canonical session ids qualify).
- Turns admitted through the api_server bind `HERMES_BROWSER_CONTROL_PRINCIPAL` (family
  `local-api`/`remote-api`), which the router honours.

Gaps HOB must close for that seam to work:
- `browser.extension_control.enabled` is **not** set anywhere in HOB (`seed-hermes-config.mjs`,
  Dockerfile ENV) — the lane is off.
- HOB already sets `API_SERVER_KEY` / `HERMES_API_URL=http://127.0.0.1:8642`
  (`deploy/bootstrap-hermes.mjs:52,73`), so the api_server is HOB's listener; but HOB submits turns via
  canonical `prompt.submit`, and browser-capable turns would have to go through the api_server
  (`X-Hermes-Session-Key` + `api_turn_v1`) for the identity to be stamped.
- The api_server adapter needs `aiohttp` in the runtime image (absent from the local scratch venv:
  live log `API Server: aiohttp not installed` → `No adapter available for api_server`).

## Not done (correctly gated behind Phase 0)

Per instruction, nothing was built on top of a failed premise: no `@atriumjs/*` export verification
and none of corrections 2–8 (accessibility refs, human-takeover lease, sandboxing, 10-min idle
shutdown, per-route ownership validation, profiles) were implemented. They all presuppose a working
controller transport, which does not exist on the assumed path.

## Evidence artefacts

- Probe: `.tmp-runtime/p0-browser/phase0.mjs`; raw output `.tmp-runtime/p0-browser/phase0.out`
  (`[RAW_FRAME_ERROR] {"code":4403,"message":"session is not owned by this transport"}`).
- Gateway logs: `.tmp-runtime/p0-browser/gw.log`, `gw-api.log` (turn ran as `platform=local` via
  `run_turn_runner.py`; `browser.controller.*` check_fns all `False`).
