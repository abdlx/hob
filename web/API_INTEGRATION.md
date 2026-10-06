# OpenMuse API

`server/app.mjs` serves the frontend and translates REST/SSE into the modified
OpenClaw Gateway's version 4 RPC protocol. OpenClaw owns configuration, sessions,
files, approvals, schedules, credentials, and browser state. There is no parallel
mock or application database. Deployment uses one origin; Vite proxies `/api`
during development. The Gateway port and token stay on the server.

The app authenticates with `MUSE_PASSWORD` (or `MUSE_ACCESS_TOKEN`), issuing an
HttpOnly, SameSite Strict cookie. Configure the exact `MUSE_PUBLIC_URL` and
`MUSE_SECURE_COOKIES=true` for public HTTPS access. API mutations enforce origin.

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
