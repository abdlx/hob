# OpenMuse frontend

React, TypeScript, Vite, Tailwind, and Lucide. The original black chat layout and
bronze message bubbles are preserved. Inter is served locally with its OFL license.

Run `npm ci`, then `npm run dev`. Vite proxies `/api` to the adapter at
`http://127.0.0.1:3000`; there is no mock mode. Start the adapter and modified
OpenClaw using the [workspace setup guide](../README.md).

Routes: `/chat`, `/library`, `/goals`, `/ideas`, `/feed`, and `/settings`. Ideas
and Feed intentionally have no content. Search opens the conversation drawer.
The five agent panels are Activity, Approvals, Browser, Daily goals, and Identity.

Run `npm run build` and `npm run lint`. From the workspace root, run
`node --test web/tests/stream.test.mjs` to verify streamed responses.

Production serves `dist` from the authenticated same-origin adapter. Gateway
tokens and provider credentials stay on the server.
See [API_INTEGRATION.md](API_INTEGRATION.md) for API contracts.
