# The CAPTCHA system

HOB's browser treats a CAPTCHA as a **session state**, not an error. When a
challenge is confirmed in front of a bot's page, agent mutations park behind
it, a solver ladder tries to clear it, and the parked work resumes in order
when the challenge resolves. Detection lives in `server/browser-challenge.mjs`,
the gate in `server/browser-gateway.mjs` (`admitAgentMutation` — the single
admission point every agent mutation already passed through), the ladder in
`server/browser-solvers.mjs`.

## Modes

| `HOB_CAPTCHA` | Behavior |
|---|---|
| `detect` (default) | Challenges are detected, classified and counted. Nothing is parked, nothing is solved. Run here first: a false positive in `detect` costs a log line; in `solve` it costs a parked agent. |
| `solve` | The gate parks, the ladder climbs. |
| `off` | No detection, no probes, pre-system behavior. |

Per-session overrides exist as gateway options (`captchaMode`,
`challengeParkMs`, `challengeCooldownMs`, `challengeServiceDailyCap`,
`onChallengeEscalated`) for hosts that embed the gateway their own way.

## What gets detected

- **Frame/URL signatures** — reCAPTCHA v2 (anchor = checkbox, bframe = image
  grid), hCaptcha, Turnstile, Arkose, GeeTest, fed from frame navigations on
  both the viewer (cast) connection and every agent connection.
- **DOM probes** — a read-only evaluation on the gateway's own connections:
  widget elements, sitekeys, and the token fields whose population is the
  strongest resolution signal there is.
- **Whole-page interstitials** — Cloudflare/DataDome/PerimeterX/Akamai block
  pages, by URL and title. These never park: there is nothing to solve, so
  mutations are refused immediately (`challenge_blocked`) and the host is
  recorded in `challengeCooldowns` for `challengeCooldownMs` (default 10 min).

A challenge must be *confirmed* before it can park anything: one strong
signal (an image-challenge frame), or the same candidate seen twice, spaced
in time. reCAPTCHA v3 is recorded as score-only bookkeeping — it can never
become an active, parking challenge, because there is nothing to interact
with.

## The ladder

1. **Passive** — Turnstile and well-reputed sessions often clear themselves;
   the tracker sees the token and the gate opens. Most of the credit in
   `challengeStats.passive` is this, plus the profile/trajectory hygiene
   below.
2. **Checkbox** — a hit-tested precision click on the widget with
   `motion: 'human'` (curved path, dwell, realistic press), then a wait for
   the token.
3. **Image grid** — only when a vision solver is configured
   (`HOB_CAPTCHA_VISION_URL` / `HOB_CAPTCHA_VISION_MODEL` /
   `HOB_CAPTCHA_VISION_KEY`, any OpenAI-compatible chat endpoint). The grid
   geometry is read from the DOM, never guessed; the vision model picks
   tiles; up to 3 rounds against refreshed grids. Without a vision solver
   this rung reports not-applicable — it never guesses.
4. **Solver service** — only when `HOB_CAPTCHA_KEY_CAPSOLVER` is set. A
   CapSolver-protocol service mints a token, the gateway injects it into the
   page's response field, and the **tracker** decides whether it worked.
   Guardrails: `HOB_CAPTCHA_SERVICE_DAILY_CAP` attempts/day (default 50)
   and a circuit breaker — 3 consecutive failures disable the service for
   the session.
5. **Human** — viewers receive a `{ t: 'challenge', state: 'active', ... }`
   broadcast the moment a challenge confirms (and `resolved` when it
   clears), and `options.onChallengeEscalated` fires when the ladder gives
   up or a parked command times out, so the host can ping the owner. The
   human solves in the live viewer through the ordinary control lease; the
   gate sees the token and the parked commands resume.

While parked, a mutation waits up to `challengeParkMs` (default 120 s) and
is then refused with `challenge_timeout` — a structured CDP error that
names the problem, never a silent hang. An active challenge also counts as
work, so the idle sweep never reaps a browser mid-challenge.

## Reading the numbers

`status()` (and the dashboard's public view, which omits sitekeys/tokens on
purpose) exposes:

- `challenge` — the active challenge `{ provider, kind, sitekey, ... }`
  (public view: provider/kind/since only).
- `challengeStats` — `{ seen, agent, human, service, passive, failed }`:
  who actually clears challenges on this bot. If `failed` climbs while
  `seen` does, the ladder is losing to something — check the trace.
- `challengeCooldowns` — hosts currently burnt by a block page.

Set `HOB_BROWSER_TRACE=/path/file` to get the challenge lifecycle
(`challenge active/resolved`, per-rung solver outcomes) alongside the
existing wire trace. The trace records names and outcomes, never parameters,
so no sitekey or token can land in it.

## Trajectory hygiene

`Hob.input.*` accepts `motion: 'human'` on click, type and scroll
(`server/browser-trajectory.mjs`): Bézier pointer paths with overshoot and
dwell, per-character typing cadence, eased scroll bursts. The solvers use it
by default. Behavioural scoring is half of every modern challenge system —
the other half is the session's reputation, which is why profiles are
persistent per bot and why rotating identities mid-session is an
anti-pattern this codebase will not help with.

## Honest limits

- Score-based systems (reCAPTCHA v3, Turnstile managed) have no puzzle to
  solve. The system's answer is hygiene, patience, and fast failure on hard
  blocks — not a workaround war.
- Solver services mint tokens; they do not mint reputation. On a scored
  session a service token may still not clear the challenge, and the tracker
  will say so.
- Challenge DOM and URLs drift as providers change their markup. The
  classifier's fixtures (`server/test/browser-challenge*.test.mjs`) are the
  refresh point — when a provider changes shape, the signatures and the
  fixtures change together.
