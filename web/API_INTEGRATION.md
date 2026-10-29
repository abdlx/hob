# hob API

## Current Hermes deployment

The shipped deployment uses Hermes. Hermes owns sessions, execution, scheduling,
memory and skills; HOB owns authentication, routing, the managed browser broker,
and file-delivery metadata. `/api/runtime` identifies the selected runtime.

Authentication uses `HOB_PASSWORD` (or `HOB_ACCESS_TOKEN`) and the HttpOnly,
SameSite Strict `hob_session` cookie. Set the exact `HOB_PUBLIC_URL` and secure
cookies behind HTTPS. Mutations enforce origin. Private runtime keys remain on
the server. Captured clients bind `X-Hob-Profile` and workspace/setup `?profile=`
to one enrolled bot; changing the UI selector cannot redirect an in-flight write.

| Hermes endpoint | Contract |
| --- | --- |
| `GET /api/readiness` | Required native session authority and runtime readiness |
| `GET/POST /api/sessions`, `GET /api/sessions/:id/messages` | Distinct canonical conversations; history stays with its original transport |
| `POST /api/sessions/:id/turns` | `{content, idempotencyKey, attachments?}`; SSE admission, deltas and native terminal state |
| Session `run`, `abort`, `recover`, `resolve-unknown`, `clarify` routes | Displayed native admission/revision/prompt controls; no blind replay |
| `GET/POST /api/sessions/:id/title` | Inspect title/revision; rename with `{title, revision, requestId}` |
| `POST /api/sessions/:id/attachments` | Validated bytes and session-bound attachment tickets |
| `GET/POST /api/hermes/profiles` | Enrolled bot lifecycle and explicit setup role/identity |
| `GET/POST /api/hermes/saved-providers` | Private connection metadata and explicit connect/verify actions |
| `GET /api/hermes/setup/models`, `POST /api/hermes/model` | Model catalog/selection with native cost-warning confirmation |
| `GET/PUT /api/hermes/setup/preferences` | Scoped language, timezone and native turn/time limits; explicit confirmation |
| `POST /api/hermes/setup/audio/transcribe` | `{dataUrl, confirm:true}`, supported audio up to 1 MB; transcript-only response |
| `GET/PUT /api/hermes/setup/learning` | Independent effective policy values and their sources |
| `/api/hermes/workspace/jobs` and job lifecycle routes | Native bot-owned schedules; create/edit requires authoritative validation |
| `POST /api/hermes/workspace/schedule-preview` | Native parser, next run and effective timezone without creating a job |
| `GET /api/hermes/workspace/reviews/:subsystem`, `GET .../:id` | Memory/skill proposal page, complete bounded diff/payload and revision |
| `POST /api/hermes/workspace/reviews/:subsystem` | `{id, revision, action, requestId, confirm:true}` for one inspected approve/reject decision |
| `GET /api/hermes/workspace/review-history` | Selected profile's decision metadata |
| `GET /api/hermes/workspace/files?path=...` | Assigned workspace listing and delivery receipts/failures |
| Workspace `file` and `download` routes | Scoped previews up to 2 MB; binary attachments up to 25 MB |
| `/api/hermes/browser/...` | Per-bot viewer, tab actions and human takeover; agent CDP mutations obey the same lease |
| `GET /api/hermes/diagnostics/performance?profile=...` | Authenticated, enrolled-bot timing samples and p50/p95/max; bounded metadata, with no prompts or provider billing claims |

Proposal reviews and schedule previews require the complete rebuilt image.
`deploy/apply-hermes-compat.py` mounts native JSON controls only when pinned
upstream source hashes match. Hermes's own appliers and scheduler remain owners.
The old `workspace/skill-review` mutation path refuses approve/reject because a
chat-truncated diff cannot authorize the displayed revision.

Interrupted review claims require operator reconciliation, not automatic replay.
File-delivery recovery observes retained native receipts without resubmitting a
model turn. History is not automatic rollback. Turn/time preferences apply to new
conversations and do not provide an aggregate currency cap. Older API-era history
remains read-only and is never reinterpreted as another native conversation.

## Historical OpenClaw adapter

The contracts below apply only when OpenClaw is explicitly selected. Stale
OpenClaw settings/RPC actions are refused on a Hermes server.

`server/app.mjs` serves the frontend and translates REST/SSE into the modified
OpenClaw Gateway's version 4 RPC protocol. OpenClaw owns configuration, sessions,
files, approvals, schedules, credentials, and browser state. There is no parallel
mock or application database. Deployment uses one origin; Vite proxies `/api`
during development. The Gateway port and token stay on the server.

The app authenticates with `HOB_PASSWORD` (or `HOB_ACCESS_TOKEN`), issuing an
HttpOnly, SameSite Strict cookie. Configure the exact `HOB_PUBLIC_URL` and
`HOB_SECURE_COOKIES=true` for public HTTPS access. API mutations enforce origin.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/auth/status`, `POST /api/auth/login`, `POST /api/auth/logout` | Login/session lifecycle |
| `GET /api/readiness` | Gateway startup/preparation state before admitting conversations |
| `GET /api/sessions`, `POST /api/sessions` | Canonical conversations |
| `GET /api/sessions/:id/messages` | Transcript history |
| `POST /api/sessions/:id/turns` | Agent turn with SSE streaming |
| `POST /api/sessions/:id/abort` | Abort a running turn |
| `GET /api/events` | Live Gateway and connection events |
| `GET /api/agent`, `PATCH /api/agent` | Default agent profile/model |
| `GET /api/agents`, `POST /api/agents` | Agent catalog/creation |
| `GET/PUT /api/agent/files/:name?agentId=...` | Agent Markdown, optimistic hash guard |
| `GET /api/tasks`, `GET /api/stats` | Activity and diagnostics |
| `GET /api/security/approvals`, `POST /api/security/approvals/:id` | Approval replay/decisions |
| `GET/POST /api/goals`, `PATCH/DELETE /api/goals/:id`, `POST /api/goals/:id/run` | Cron tasks |
| `GET /api/library?kind=artifacts` or `kind=media` | Files across authorized workspaces |
| `GET /api/library/file?sessionId=...&path=...` | Preview; `raw=1` or `download=1` for bytes |
| `GET /api/browser/tabs`, `POST /api/browser/actions` | Managed OpenClaw browser |
| `GET/PATCH /api/settings`, `GET /api/settings/schema` | Redacted config and complete schema |
| `GET/POST /api/credentials`, `DELETE /api/credentials/:name` | Secret-store metadata/write/delete |
| `POST /api/rpc` | Allowlisted model auth, plugins, channels, setup wizard, and diagnostics |
| `GET /healthz` | Gateway connection plus canonical startup completion |

Turns accept `{content}`. SSE emits `accepted`, `delta` (`text`, `replace`),
`done` (`message`), or `error` (`message`). The client parses full frames across
network reads, respects replacement deltas, and reports unfinished connections.
Live streams emit named `gateway` (`event`, `payload`) and `connection`
(`connected`) events. Accepted writes are never automatically retried.

Config saves send `{patch,baseHash}` to the canonical config owner. Unchanged
redacted sentinels remain intact; revision conflicts require reloading the config.
Markdown saves require `expectedHash` or `expectedMissing`. Scheduled goal updates
may send `expectedConfigRevision`.

Text previews are bounded to 256 KiB and media assets to 1 MiB by OpenClaw.
Workspace discovery is bounded; Library displays truncation and size errors.
Larger unrestricted binary downloads need a future Gateway transport.
HTML/SVG downloads are sandboxed attachments, never executable app pages.

Settings include API-key/model selection, provider sign-in through the Gateway
wizard, connector installation/enabling, channel QR setup, canonical secret
storage, and full schema editing. Contrast and notification preferences
stay in the browser. Notifications apply while the app is open in a background
tab; this does not provide push delivery after the browser closes.
