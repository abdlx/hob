# Hermes integration checkpoint

This records an incomplete migration, not a deployment-ready release.

## Goal

Use upstream Hermes unchanged behind the custom hob UI. Provide one Main bot by
default, operator-controlled additional bots, separate persistent state and work,
explicit group collaboration, learning over time, and setup through the UI.

## Source state

The workspace Git repository still owns the application. The previous sources
have been moved to `stale-harnesses/`; these moves/deletions and the existing
`.gitignore` changes predate this implementation step and were preserved.
The new `hermes-agent/` has no independent `.git` directory and is currently
ignored by the parent repository. Its exact upstream revision is not proven.
No Hermes or archived OpenClaw source files were edited in this step. No package
dependencies, lockfiles, private environment files, commits or deployments were
changed by this step.

## Implemented

- `server/hermes-client.mjs`: native HTTP runtime/dashboard transports, separate
  private credentials, loopback listeners, explicit profile routing, bounded JSON
  and SSE responses, redirect refusal, no write retries, profile-bound session IDs.
- `server/hermes-routes.mjs`: authenticated application endpoints for profile
  creation, configuration/schema, credentials, model selection, sessions, runs,
  native approvals, steering and cancellation. These are an explicit operation
  allowlist, not an arbitrary URL proxy. Body/query profile conflicts are refused.
- `server/hermes-chat.mjs`: translation for the existing chat UI using upstream
  session envelopes and `event`-named run frames, without OpenClaw RPCs. Run EOF
  never becomes successful completion. Lost streams retain duplicate protection
  and cancellation until native run status settles. Approval decisions bind the
  exact native request ID and allow once or deny only.
- `server/hermes-settings.mjs`: recursive masking of known inline credential
  fields; masked placeholders cannot be saved as actual values.
- `server/index.mjs`: Hermes is now the selected server runtime. It requires
  server-provisioned `API_SERVER_KEY` and `HERMES_DASHBOARD_SESSION_TOKEN` plus
  local runtime/dashboard listeners. The legacy Docker supervisor does not yet
  provision these, so the existing Compose deployment is not ready to start it.
- UI: runtime-specific Hermes Settings, fresh bot creation without cloning state,
  credential entry, provider/model selection, native config editing that submits
  only changes, bot selection in the chat header, and profile-scoped requests.

The current approval/run maps are presentation/recovery caches in the adapter,
not durable application state or approval authority. Hermes remains the approval
owner. Adapter restart recovery is not implemented yet.

## Source contracts checked

`hermes-agent/gateway/platforms/api_server.py` owns the runtime routes and returns
new sessions as `{object: "hermes.session", session: ...}`. Session lists and
messages use `{object: "list", data: ...}`.

`gateway/platforms/api_server_runs.py::_run_event()` uses an `event` field, not a
`type` field. Terminal completion carries `output`; run status and approval
resolution are native endpoints. Profile listeners use `/p/<profile>/...`.

`hermes_cli/web_routers/config_env.py` owns config/env writes; it deep-merges config
under its own lock. This adapter does not claim config compare-and-swap against
other dashboard clients. `web_models.py::ConfigUpdate` and `EnvVarUpdate` accept
a body profile, so the adapter binds it to its query selector.

`hermes_cli/web_server.py` accepts `X-Hermes-Session-Token` supplied through
`HERMES_DASHBOARD_SESSION_TOKEN`. `web_routers/profiles.py` owns profile creation;
cloning is not implicitly enabled by the custom UI.

The imported runtime specifies Python 3.14. The discovered system Python is 3.12;
a supported Hermes-managed runtime has not yet been provisioned or exercised.

## Verification

| Command | Baseline | Current result |
| --- | --- | --- |
| `node --test server/test/*.test.mjs` | 23 passed, 2 failed | 54 passed, same 2 failed |
| `node --test server/test/hermes-*.test.mjs` | Not present | 31 passed |
| `node --test web/tests/*.test.mjs` | 8 passed | 12 passed |
| `npm run build` in `web` | Earlier checkpoint passed | Passed TypeScript and Vite build |
| `npm run lint` in `web` | Earlier checkpoint passed | Passed |
| `git diff --check -- server web` | No new whitespace errors | Passed; existing CRLF notices retained |

The two full-server failures are existing source-reading tests in
`server/test/app.test.mjs` referencing the moved `openclaw/` schema/catalog paths.
They are not hidden or disabled. Replace obsolete integration contracts as the
remaining legacy application surface is migrated.

New tests use real local HTTP listeners with upstream-shaped fixtures. They prove
adapter behavior, not execution of Hermes, a model, a container or a cloud service.
No live runtime, model, Docker or browser visual end-to-end proof exists yet.

## Required continuation

1. Replace `deploy/start.mjs`, Dockerfile and Compose bootstrap with an unchanged,
   reproducibly identified Hermes runtime. Use Hermes PM for Python environments
   and extras; do not raw-install dependencies into its environment. Provision
   local listener credentials automatically without putting them in browser code
   or exposing dashboard admin credentials to agent execution environments.
2. Prove UI-first setup works before provider credentials exist, including real
   model selection and a successful native agent/tool turn.
3. Add a durable application bot roster and per-bot workspace provisioning. Only
   operator-created roster entries should appear as bots; discovering a directory
   written by an agent is not consent to create a new bot. Verify memory,
   credentials, work directories and execution access remain correctly scoped.
4. Finish run recovery across adapter/runtime restarts, uncertain admission
   reconciliation, pagination, partial output, attachments, questions and control
   presentation. Preserve the native run/request authority; never fabricate success.
5. Implement explicit group membership, separate room conversations, bounded
   collaboration and revocation without merging private histories or memory stores.
6. Migrate the remaining library, memory/learning, skills, schedules, channel,
   connector, browser and identity UI surfaces. Existing unsupported OpenClaw RPC
   paths currently return a visible 501, not a fake Hermes equivalent.
7. Add guided/native schema forms beyond the current config editor, verify
   provider/tool/channel setup, and show learning history and user controls.
8. Run real Hermes integration tests in isolated homes using its sanctioned test
   wrapper, browser UI checks, Linux container boot/restart/backup/upgrade tests,
   and a live provider task. Then review the complete migration diff and release.

Keep the full goal active. Do not mark complete from these adapter tests/builds.
