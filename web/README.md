# hob frontend

React, TypeScript, Vite, Tailwind, and Lucide. Semantic light/dark tokens power the workspace; Inter is served locally with its OFL license.

Run `npm ci`, then `npm run dev`. Vite proxies `/api` to the adapter at
`http://127.0.0.1:3000`. Start the Hermes adapter using the [workspace setup guide](../README.md).

Routes include `/chat`, `/library`, `/goals`, `/ideas`, `/activity`, `/groups`, and `/settings`. Search opens the conversation drawer.
The five agent panels are Activity, Approvals, Browser, Daily goals, and Identity.

Run `npm test`, `npm run lint`, and `npm run build`. After building, run `npm run test:e2e` for Chromium checks of the production bundle. On Linux, first install the test browser using `npx playwright install --with-deps chromium`. On Windows, tests use installed Chrome when available; `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can select another executable.

Browser UI tests use explicit Hermes API fixtures and verify save failures, draft retention, theme/navigation persistence, mobile layout, plugin install contracts, and Main-only installation boundaries. They do not establish a live Hermes installation or a credentialed model run. Server tests separately exercise real Chromium challenge handling and real VNC WebSocket forwarding/authentication.

Hermes settings progressively mount supported categories and retain visited forms while switching categories. Runtime configuration persists through Hermes; theme and settings navigation are saved in browser storage. Plugin installation uses the native reviewed catalog for Main and leaves new packages disabled until the operator enables them.

Production serves `dist` from the authenticated same-origin adapter. Model credentials remain server-side. An explicitly configured external computer connection can provide its VNC token to the authenticated viewer for a direct stream; the same-origin proxy requires dashboard authentication and origin checks.
See [API_INTEGRATION.md](API_INTEGRATION.md) for API contracts.
