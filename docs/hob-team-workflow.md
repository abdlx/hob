# HOB team workflow

This workflow lives in HOB's server, dashboard, and managed workspace instructions. It does not change Hermes source, native database schemas, runtime images, compatibility patches, inference ownership, tools, approvals, or scheduler behavior.

## Ownership and storage

| Layer | Authority | Writes |
| --- | --- | --- |
| Approved shared core | HOB `employee-team.sqlite` | Exact-revision operator decisions; immutable versions |
| Plans, steps, commitments, private episodes, candidates, inbox, audit | HOB `team-memory.sqlite` | Role-scoped API with request identities and revision checks |
| Full conversations and execution | Existing native Hermes interfaces | Hermes alone |
| Private `MEMORY.md` / `USER.md`, skills, native scheduled jobs | Hermes | Existing native controls and approvals |

Both HOB databases reside in the existing HOB state volume. Back up the entire state directory while HOB is stopped, or use a SQLite-aware backup that includes committed WAL state. Retaining only workspace Markdown is insufficient. No new credentials are needed: `.hob/work.mjs` uses the bot's existing relay-scoped credential, which cannot authenticate to dashboard operator routes.

Production startup enables the architecture and coordinator-only routing once for pre-feature settings. Existing core, proposals, native memories and document-sharing choices are preserved. An explicit later opt-out remains disabled across restarts. The operator can change this under Settings → Memory & history → Team controls. Enabling the architecture always keeps coordinator-only routing enabled. Shared document copying remains a separate opt-in.

## Work lifecycle

1. Main uses `.hob/work.mjs plan` to persist the task ID, active worker, title, verifiable outcome, nominated relative output, timezone-qualified deadline (or `none`), and 1–30 steps.
2. Main sends the existing structured TASK with `.hob/talk.mjs send ... --no-wait`. HOB checks its owner/outcome/output/deadline against the registered plan before any native admission. A tracked task can acquire only one exchange. Request replays reuse that exchange. Restart reconciliation repairs a crash between exchange creation and registry linkage without starting another run.
3. Hermes creates the worker conversation and owns inference. Workers update only their own task steps with exact revisions. Progress cannot certify completion. Progress records also become private work-log entries. A native unknown outcome stays waiting; it is never automatically resent. Failed/cancelled execution remains distinct from pending output review.
4. A completed worker reply remains self-reported. Main receives the originally nominated output through the existing pinned artifact handoff, reads its actual contents using its own tools, and records actual checks against the received SHA-256. File existence, copying, or the word DONE does not pass the gate. HOB rechecks the received snapshot and assignment/reply binding before delivering a completion. A changed snapshot or revoked worker blocks delivery. Main's verdict is a coordinator review, not independent human certification.
5. A task with `OUTPUT: none` remains review pending until the operator reads the worker result and explicitly attests its outcome in the task board. Partial/blocked replies cannot pass this attestation.
6. HOB atomically inserts a local inbox notice and settles its delivery marker. Browser closure and server restart do not duplicate the notice. Marking it read is durable. File-result notices link to the reviewed snapshot; the protected download rechecks its hash, current verdict, and active bot scope. Inbox delivery is local to HOB; email, WhatsApp and push channels are not implied.

Existing native Bot Chat wakeups trigger private coordinator review. HOB adds no second inference executor or review model. These existing native wakeups can use the configured model; “no background model calls” describes HOB's bookkeeping and daily consolidation, not free Main/worker execution. Bound private review sessions are omitted from normal conversation lists. The task board exposes their existing native controls for permissions, clarification and recovery without adding a chat composer to bot-to-bot history.

Main returns after native admission instead of waiting for worker inference, allowing its foreground response to finish. Hermes's native foreground FIFO and permissions still apply. This is asynchronous delegation, not arbitrary interruption of an already executing foreground model turn.

## Memory and commitments

Bots can read only their own episodic work log with `.hob/work.mjs episodes`, and explicitly retain eligible lessons with `remember`. Main's relay credential cannot read a worker's private episodes. The authenticated human operator may inspect the selected bot's log in Memory settings. Automatic completion logs retain metadata, not raw session transcripts. Private notes must exclude session-only facts and credentials; full native transcript content is not imported into the HOB log. This is an application API boundary, not a new claim of native process/filesystem isolation.

The heuristic open-thread detector drafts promises from observed completed foreground turns. It skips explicitly session-only turns and sensitive output. Drafts do not deliver until the operator approves them with evidence. Relative dates in natural-language promises remain in the draft text for review; HOB does not silently assign them an assumed timezone or deadline.

Main/workers can also create commitment drafts with `followup`. The active sweep uses persisted native task outcomes for task-linked commitments. Finished/cancelled tasks close outstanding reminders. An external or conversation-only commitment needs a recent operator check (15 minutes); a model's assertion alone cannot certify unknown external state. Quiet hours and daily caps defer delivery, and declined IDs/titles prevent automatic re-offering. All limits and timestamps survive restart. The default timezone is UTC, quiet hours are 22:00–08:00, and the daily cap is three; set the cap to zero to pause delivery.

Explicit `propose` calls and PROMOTE fields from currently reviewed task results create deduplicated candidates. Possible core overlaps are shown for operator judgment. A fact sourced from a task is revalidated before staging. Staging creates an existing revision-bound core proposal; it does not publish. All tiers require a separate exact-content operator approval in Team controls. Bots cannot submit approval flags or impersonate the operator through a profile named `user`.

On the first sweep of each local calendar day (including after downtime), deterministic consolidation records candidate counts and flags pending candidates older than 90 days. It does not summarize private transcripts with a model, promote facts, delete history, or schedule paid recurring jobs. Semantic model-assisted nightly consolidation remains an explicitly configured future capability, not a hidden default.

## API and helper

The dashboard uses `/api/hermes/team/work` after normal session/origin checks. Bot helpers use `/api/hermes/bot-relay/work` after relay authentication. Actor identity is determined by the authenticated surface, never by request JSON or a `profile` query parameter.

Read endpoints: root status; `/tasks`, `/followups`, `/candidates`; `/episodes`; `/inbox`; operator-only `/audit`. Collection requests accept bounded `limit` and an exclusive numeric `before` cursor. The UI shows the most recent 100 collection items; older records remain in the database and can be retrieved through the paginated API.

Mutations use POST with a stable `requestId`: `/plan`, `/progress`, `/followups`, `/followups/decide`, `/remember`, `/candidates`, `/candidates/decide`, `/text-review`, `/preferences`, `/inbox/read`. Updates require the exact current revision. Operator-only `/sweep` takes `{ "confirm": true }`. Unsupported fields, credentials, absolute/private output paths and cross-worker actions are rejected. A lost acknowledgement must reuse the same request ID and payload; a different payload with the same ID is rejected. No mutating request or uncertain native admission is automatically replayed with a new identity.

Examples, run in the bot's managed workspace:

```sh
node .hob/work.mjs status
node .hob/work.mjs plan '{"requestId":"plan-001","id":"task-001","owner":"writer","title":"Build report","outcome":"A checked report","output":"artifacts/report.md","deadline":"none","steps":["Research","Write","Verify"]}'
node .hob/work.mjs progress '{"requestId":"step-001","id":"task-001","revision":2,"step":0,"status":"done","note":"Sources checked; writing next"}'
node .hob/work.mjs remember '{"requestId":"lesson-001","summary":"Reusable lesson from my own task","evidence":"Task and observation time"}'
node .hob/work.mjs propose '{"requestId":"fact-001","fact":"Observed project fact","evidence":"Source and observation time"}'
```

The generated helper reports its stable request identity on mutation failure. It does not accept operator approval commands, open databases, or call native inference endpoints. The legacy `team-memory-cli.mjs` remains an offline Markdown utility; it does not operate this live registry. Do not run its old sweep as a second delivery scheduler.

## Verification boundaries

Automated fixtures exercise native adapter contracts, plan-before-admission, asynchronous handoffs, role scopes (including a `user`-named bot), exact revisions/idempotency, restart linkage recovery, real artifact snapshots and mutation, approval separation, quiet hours, caps, stale checks, durable delivery/read state, and browser task-board/inbox flows. They do not substitute for a live configured-model run or qualify the stricter native privacy/billing mode. No paid model evaluation is performed by this feature's test suite.
