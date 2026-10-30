# Hob Employee Team — Implementation Spec: Memory, Library, and Context Across Chats

Status: SPEC, not yet implemented. Written 30 Oct 2026 from the code in
`~/workspace/hob/server/` (bot registry, relay, roster sync, workspace
routes, memory setup, learning setup). Anything marked NEW does not exist
yet. Anything unmarked already exists and is being constrained, not invented.

## 0. The one-sentence design

One front door (Main), one shared brain for durable facts (team core),
one shared shelf for deliverables (shared docs), and strictly private
working memory and live conversations per bot. Collaboration happens
through Main's delegation and summaries, never by letting bots read each
other's heads.

## 1. Principles (non-negotiable)

1. **Main is the only coordinator.** Only Main fans work out to workers.
   Workers message Main only. This is already enforced by the relay
   (worker-to-worker sends return 403). The spec keeps it.
2. **A bot's reply is its own work, never Main's.** Main never reports a
   worker's task as done without that worker's reply, and never reports a
   result it has not verified (file exists, content matches the claim).
   This rule is already in the roster block; the spec makes it a
   system-wide verification rule (Section 6).
3. **No silent cross-contamination.** No bot ever sees another bot's
   episodic memory, session transcript, or unfinished work except as a
   summary Main deliberately passes on, on a need-to-know basis.
4. **Single source of truth, copies clearly marked.** Shared docs have
   one source. Everything else is a copy that sync overwrites. Nobody
   edits a copy and expects it to stick.
5. **User-stated facts always win.** On any conflict, the user's own
   words beat any bot's memory, any summary, and any older fact.
   Conflicts are surfaced to the user, never auto-resolved by deletion.
6. **Secrets never travel.** No credentials, tokens, keys, or passwords
   in memory, in library files, in relay messages, or in group chats.
   The existing sensitive-path and secret-redaction guards stay on.
7. **External facts carry source + time.** Any weather, price, news, or
   fetched fact must cite its source and its observation/fetch time,
   and stale data must be labeled stale. (Lesson of the 30 Oct weather
   answer: sourced but 6 hours old, presented as current.)

## 2. Entities and where they live

All paths are under the server's workspace root (the same root the
dashboard file routes already jail bots to).

| Entity | Location | Owner | Who reads it |
| --- | --- | --- | --- |
| Bot registry | `stateDir/bots.json` | Server | Server only |
| Main workspace | `workspaces/main/` | Main | Main |
| Worker workspace | `workspaces/bots/<bot-id>/` | That worker | That worker only |
| Shared docs source | `workspaces/main/shared/` (NEW convention, no code) | Main | Main directly; workers via copies |
| Shared docs copies | `workspaces/bots/<bot-id>/shared/` (NEW, via sync) | Sync | That worker (read in practice; sync overwrites edits) |
| Shared media | `workspaces/main/shared-media/` (Phase 2) | Main | All bots via read exception (NEW, Section 4.4) |
| Team core source | `workspaces/main/TEAM_CORE.md` (NEW file) | Main | Main directly; all bots via synced block |
| Team core block | Managed block in every bot's `AGENTS.md` (NEW) | Sync | Every bot (Hermes loads AGENTS.md) |
| Per-bot memory | Native Hermes per-profile MEMORY.md / USER.md | That bot | That bot only |
| Task board | `workspaces/main/shared/TASKS.md` | Main | All bots via sync-copy |
| Relay conversations | Dedicated "HOB Bot Relay" session per receiver (exists) | Receiver | Sender + receiver only, via reply |
| Group chats | `hob_group_*` rooms (exist) | Room members | Members only |

Bot internal ids are immutable; display names are labels only. Main's
internal id is `default`, display name `Main`, and it keeps that name
because every bot routes through it (existing rename rule).

## 3. Memory — three layers, no more

### 3.1 Layer 1: Team core (shared, durable, small)

- **Source file:** `workspaces/main/TEAM_CORE.md`, edited by Main only.
- **Distribution:** NEW managed block in every bot's `AGENTS.md`,
  delimited `<!-- HOB:TEAM-CORE:START -->` /
  `<!-- HOB:TEAM-CORE:END -->`, written by the existing sync machinery
  (`HermesBotNetwork.sync()`), reusing its atomic-write and
  operator-notes-preservation behavior. Sync runs on every roster change
  AND on every core edit (NEW trigger).
- **Budget:** at most 4,000 characters injected per bot. If the core
  grows past that, Main splits it: the injected block holds the
  essentials, the full file stays in shared docs for retrieval.
- **Contents, and only these:** who the user is, contact and delivery
  details, standing preferences, standing rules (including escalation
  rules), durable project facts, and named decisions with dates.
  No task status, no chat transcripts, no speculation, no secrets.
- **Write rule:** workers NEVER write the core directly. A bot-local
  edit to the core block is overwritten on the next sync, exactly like
  the roster block today.
- **Versioning:** every core edit keeps the previous version as
  `workspaces/main/TEAM_CORE.<date>.md` (NEW, Main's job, cheap,
  no code). A bad promotion is reversible by restoring a version.

### 3.2 Layer 2: Per-bot memory (private, episodic)

- **Storage:** the existing native Hermes per-profile memory:
  MEMORY.md / USER.md per bot, plus the native learning graph
  (`memory:memory` / `memory:profile` nodes).
- **Budgets (existing Hermes direction, keep):** USER.md roughly
  1,000–2,000 characters, MEMORY.md roughly 2,000–4,000 characters,
  always injected for that bot only.
- **Contents:** what this bot did, what it learned on its tasks, its
  working style, its open items, its session summaries.
- **USER.md rule (NEW, prevents divergence):** Main's USER.md is
  canonical about the user. A worker's USER.md holds only
  bot-specific interaction notes (for example, "user prefers short
  replies from me"). It must never contain a conflicting user fact.
  On conflict, core wins and the worker note is corrected by Main.
- **Write rule:** a bot writes freely to its own memory. Writes are
  logged and reviewed weekly by Main (Section 7). Skill writes keep
  the existing staged approval (generated → pending → diff →
  approve/reject). Memory writes do NOT require per-write user
  approval (that would bottleneck the team); the gate that matters
  is the promotion gate below, because only promoted facts reach
  other bots.

### 3.3 Layer 3: Session (transient, never auto-promoted)

- **Rule:** anything learned in a chat stays in that chat's session
  unless it goes through promotion (Section 3.4). A test fact, a
  one-off preference, a joke name — session-only by default.
  This is the MANGO-7 rule, named after the incident: a fact that was
  explicitly session-only must not reappear later as if it were memory.
- **Session summaries:** when a session passes its budget (default:
  20 turns or the model's context pressure, whichever comes first),
  the bot writes a summary to its OWN episodic memory: facts learned,
  decisions made, open items, file paths touched. The summary is
  per-bot. It is never copied to core or to another bot except through
  promotion.

### 3.4 Promotion flow (the only bridge from private to shared)

1. Worker finishes work and, in its relay reply to Main, adds a
   `PROMOTE:` section: one line per fact, each with its evidence
   (file path, message, or observation).
2. Main checks each fact: is it durable (still true next week)? Is it
   verified (not just claimed)? Does it conflict with core?
3. Tier 1 (ordinary facts: project status, contact details, tool
   notes): Main may promote alone, edits `TEAM_CORE.md`, sync pushes
   it to all bots.
4. Tier 2 (standing rules, preferences, anything touching money,
   outsiders, or credentials policy): Main must get the user's
   explicit approval first. No exceptions.
5. On conflict with existing core: Main does NOT overwrite silently.
   It reports both versions to the user and waits. User-stated facts
   always win (Principle 5).
6. Rejected promotions stay in the worker's episodic memory only,
   marked rejected, and are not re-proposed without new evidence.

### 3.5 Memory lifecycle and hygiene

- **Weekly review (Main's job, cron or manual):** prune stale facts,
  merge duplicates, drop superseded entries. User approves deletions
  from core; per-bot pruning is Main's discretion.
- **Deletion:** deleting a core fact removes it from the source and
  the next sync removes it from every bot's block. Deleting a bot
  revokes its registry record (existing tombstone rule: internal ids
  are never reused) and its workspace is retained, not wiped, until
  the user says otherwise.
- **Staleness:** any memory entry older than 90 days without
  reinforcement is flagged in weekly review, not auto-deleted.

## 4. Library — one shelf, clear rules

### 4.1 What lives where

- **Shared docs (source `workspaces/main/shared/`):** deliverables,
  plans, the task board (`TASKS.md`), the team core source file,
  brand and reference docs, canonical data. This is the only place a
  "final" version lives.
- **Shared docs copies (`workspaces/bots/<bot-id>/shared/`):**
  sync-written copies of the source. Workers read these. A worker
  editing a copy is wasting effort: the next sync overwrites it.
  The copy header must say so (NEW, one line at sync time:
  `> Synced copy of the shared docs. Edit the source via Main.`).
- **Per-bot workspace:** scratch, drafts, tool outputs, intermediate
  files, bot-specific notes. A worker's draft becomes shared only when
  Main moves or copies it into `main/shared/` and sync runs.
- **Never in any library:** credentials, tokens, keys, private keys,
  password material, or any path the existing sensitive-path rule
  already blocks (dot-directories, `node_modules`, `credentials`,
  `secrets`, token/key patterns). The dashboard file routes already
  enforce this per bot; the sync copier must enforce it for shared
  docs too (NEW check in sync: skip any source file matching the
  sensitive pattern, and log the skip).

### 4.2 Naming and size rules

- File names: lowercase kebab-case, no spaces, dated versions as
  `name-YYYY-MM-DD.md`, never `name-final-v2-REAL.md`.
- One file, one purpose. A plan and its output are separate files.
- Dashboard preview caps at 2 MB per file (existing). Shared docs
  over that size do not belong in the library; they belong in
  shared media or outside hob with a pointer file instead.
- Deletion: only Main deletes shared files. A worker deletes only
  its own workspace files, and deletions of anything another bot
  produced must go through Main.

### 4.3 Sync semantics (shared docs)

- Trigger: roster change (existing) + shared-source change (NEW) +
  manual re-sync from the dashboard (NEW button or command, reusing
  `syncNetwork()`).
- Behavior: per bot, per file: copy if missing or changed, overwrite
  if the copy was edited locally, delete the copy if the source file
  was deleted. Report `{ updated, failed }` per bot (existing shape).
  A failed bot does not block the others, but a failed sync must
  surface to Main (existing per-bot failure list) and Main must retry
  and, if it persists, tell the user the core may be stale for that bot.
- Large files: sync-copy is for docs. Anything over 2 MB is excluded
  from sync-copy and handled by shared media (Section 4.4).

### 4.4 Shared media (Phase 2, needs a code change)

Docs sync-copy does not scale to images, video, or audio: copying
multiplies disk per bot. For media, add a narrow read exception
(NEW, in `hermes-workspace.mjs` file routes and in the media resolver):
a `workspaces/main/shared-media/` root readable by every active bot,
writes restricted to Main. The existing media guard (Main's home must
not leak other profiles' files) stays: the exception covers ONLY the
shared-media directory, never profile directories. Before relying on
it, verify the agents' own native file tools honor the same boundary
as the dashboard routes — that verification is a listed acceptance
test (Section 9, A8), not an assumption. Until it passes, Main acts
as librarian: a worker asks Main for a media file, Main copies it
into that worker's workspace.

## 5. Context — what each bot sees in each chat

### 5.1 Injection order (every turn, in this order)

1. Roster block (who the bots are, Main as coordinator).
2. Team core block (shared durable facts, max ~4,000 chars).
3. Bot role card (that bot's own AGENTS.md operator notes).
4. That bot's own USER.md + MEMORY.md budgets.
5. Current session history, bounded (default: last 20 turns),
   plus the rolling session summary if one exists.
6. For worker turns: the relay task assignment (header + body).
7. Retrieved files: only files this turn actually opens, cited by
   path. Never preload another bot's workspace or memory.

What is NEVER injected: another bot's episodic memory, another bot's
session transcript, relay transcripts (only the reply's result),
deleted or revoked bot state, or any secret.

### 5.2 Chat types and their context rules

- **User ↔ Main (the front door).** Full context: core, Main's
  memory, full session history (bounded), task board state. Main
  answers for the team and attributes worker results by bot name
  ("Sherlock found X"), never as its own work.
- **User ↔ worker (direct).** The worker sees core, its own memory,
  and that session only. It must not claim Main's knowledge or
  another bot's results. Any request needing another bot goes
  worker → Main → worker, never directly, even if the user asks
  the worker to "just ask" someone else — the worker asks Main.
- **Relay chats (bot ↔ bot).** Dedicated "HOB Bot Relay" session per
  receiver (existing). Content is the task assignment and the reply
  only. The relay transcript is never injected into any user chat;
  only the verified result crosses over, via Main.
- **Group chats (`hob_group_*`).** Every member sees the same
  messages, so group context is core + public task info only.
  Never paste another bot's episodic memory, private user facts
  beyond core, secrets, or one bot's unfinished work presented as
  decided. Disbanded groups are read-only (existing rule).
- **Handoffs (user switches bots mid-task).** Main owns the handoff:
  it writes a handoff summary to shared docs (task state, files,
  open questions, decisions so far) and the receiving bot reads
  that file. Bots never read each other's chats to catch up.

### 5.3 Delegation format (exact fields, no free-form delegation)

Main → worker relay message:

```
TASK <id> — <short title>
OUTCOME: <what done looks like, verifiable>
CONSTRAINTS: <must not do / must respect>
OUTPUT: <path in shared docs, or per-bot path if scratch>
DEADLINE: <date/time, or "none">
CORE REFS: <relevant core lines or "none">
```

Worker → Main relay reply:

```
TASK <id> — <DONE | BLOCKED | PARTIAL>
RESULT: <what was done, in plain words>
FILES: <paths created or changed, or "none">
VERIFICATION: <how it checked its own result>
BLOCKERS: <what stopped it, or "none">
PROMOTE: <facts proposed for core, one per line with evidence, or "none">
```

Main verifies RESULT against FILES before reporting to the user.
A reply without VERIFICATION is treated as unproven, not done.

### 5.4 Attribution and honesty rules for Main

- Attribute every worker result by bot name.
- Never say "we" for something one bot did, and never say "I" for
  something a worker did.
- If a worker is BLOCKED or PARTIAL, say so to the user with the
  blocker, not a smoothed-over success.
- If Main has not received a worker's reply, the task is "waiting
  on <bot>", never "done".
- Time and external facts follow Principle 7: source + timestamp,
  stale labeled stale.

## 6. Permissions and approvals

### 6.1 Matrix (enforcement in parentheses)

| Action | Main | Worker | User (dashboard) |
| --- | --- | --- | --- |
| Read own workspace | Yes (file jail) | Yes (file jail) | Yes |
| Read shared docs copies | Yes (source) | Yes (copies) | Yes |
| Read shared media | Yes | Yes, Phase 2 exception | Yes |
| Read another bot's workspace | No (jail + media guard) | No (jail + media guard) | Yes (dashboard, per-bot view) |
| Write own workspace | Yes | Yes | Yes |
| Write shared docs source | Yes | No (copies overwritten) | Yes |
| Edit team core source | Yes, Tier 2 needs user | No | Yes |
| Message Main | — | Yes (relay) | — |
| Message a worker | Yes (relay, Main-only fan-out) | No (relay returns 403) | — |
| Message outsiders / publish | Only with user approval | Never directly | Yes |
| Spend money / paid lane | Only with user-set cap | No | Yes (sets cap) |
| Delete shared files | Yes | No | Yes |
| Delete own files | Yes | Yes, own only | Yes |
| Connect accounts / channels | Proposes, user connects | No | Yes |
| Create / delete bots | Proposes | No | Yes (dashboard) |
| Change models / providers | Proposes | No | Yes |

Enforcement points, in order: dashboard file-route jail, relay
authorization (registry credential → identity, active bots only),
managed-block overwrite on sync, per-bot learning toggles
(`memoryApproval`, `skillApproval`, `backgroundReview` in the
learning setup), and Main's own escalation rule for everything the
code cannot decide.

### 6.2 Approval tiers

- **Tier 0, always allowed:** reads of own workspace, shared copies,
  core; relay messages to Main (workers) or to any worker (Main).
- **Tier 1, allowed and logged:** writes to own workspace, own
  episodic memory, own cron jobs, promotion proposals.
- **Tier 2, Main-only or user-approved:** shared-doc writes, core
  edits, spending, contacting outsiders, publishing, deletions of
  shared files, account connections. Tier 2 core edits that change
  standing rules or money policy additionally need the user.
- **Tier 3, user only via dashboard:** credentials, model/provider
  changes, bot create/delete, registry edits, server settings.

## 7. Failure and edge cases (specified, not improvised later)

1. **Relay timeout.** The relay waits up to 10 minutes (existing
   max). On timeout, the sender gets an admission id and the reply
   lands in the receiver's relay conversation. Main must read that
   reply before reporting the task. A timed-out task is "waiting",
   never "failed" and never "done".
2. **Bot unavailable.** If a bot's native profile is missing or its
   state is not active, Main reassigns to another bot or tells the
   user. It never silently substitutes a different bot's work for
   the requested bot's work, and never invents the missing bot's
   reply.
3. **Sync failure.** A bot in the sync `failed` list keeps its old
   core and old shared copies. Main retries, and if the failure
   persists, tells the user that bot's shared knowledge may be stale.
4. **Orphan audit entries (known bug, 30 Oct).** Activity shows
   Failed entries for a job that no longer exists in jobs.json,
   while the bot claims "no failures". Fix: Activity must annotate
   entries whose job id has no matching job ("job deleted") instead
   of presenting them as current failures. Until fixed, the standing
   rule is: check jobs.json AND Activity before reporting on jobs.
5. **Conflicting memories.** Newest verified fact wins, except
   user-stated facts, which always win. The loser is kept as a
   superseded note, not silently deleted, until weekly review.
6. **Core over budget.** If `TEAM_CORE.md` passes ~4,000 characters,
   Main splits it: essentials stay injected, the rest moves to
   shared docs and is retrieved on demand. Never silently truncate.
7. **Revoked bot.** Its registry record becomes a tombstone (existing
   rule: internal ids never reused). Its workspace is retained until
   the user orders deletion. Its memory is not merged into any other
   bot.
8. **Group member unavailable or revoked.** Group changes stop
   (existing rule). Main tells the user; it does not quietly drop
   the member and continue.

## 8. Implementation checklist (in order)

### Phase 0 — no code (dashboard + files)

- [ ] Write role descriptions for all 8 bots (roster sync propagates
      them) + role cards in each bot's AGENTS.md operator notes.
- [ ] Write `TEAM_CORE.md` v1 in Main's workspace from Main's current
      MEMORY.md / USER.md, deduplicated, secrets removed.
- [ ] Create `main/shared/` with `TASKS.md` (empty board with columns:
      ID, owner, outcome, deadline, output path, status).
- [ ] Resolve the 2 Failed daily-video-reminder Activity entries
      (acknowledge/resolve in UI; if unresolvable, note them as
      orphaned in the core until the Section 7.4 fix lands).
- [ ] Set spend policy: workers on the free lane; user sets a paid
      cap before any paid-lane use.
- [ ] Decide the messaging channel (recommended: Telegram) and
      connect it; Alfred owns reminders after that.

### Phase 1 — code (local repo → tests → deploy)

- [ ] `server/hermes-bot-network.mjs`: add the team-core managed
      block (source `main/TEAM_CORE.md`, delimiters above) and the
      shared-docs sync-copy (`main/shared/` → `bots/<id>/shared/`,
      header line on copies, sensitive-pattern skip with logged
      skips, sync on shared-source change + manual re-sync).
- [ ] `server/hermes-bot-network.test.mjs`: add tests — core block
      propagates to all bots, operator notes survive, bot-local
      core edits overwritten, shared copy overwritten when source
      changes, source deletion deletes copies, sensitive files
      skipped, one bot's sync failure does not block others.
- [ ] `server/hermes-workspace.test.mjs` / relay tests: add jail
      tests — worker cannot read another workspace, cannot write
      shared source, worker-to-worker relay still 403.
- [ ] Run the full server test suite. Deploy only on green, via
      Coolify from GitHub main, with a second explicit user approval
      after the test report.
- [ ] Pre-check before any of this: confirm the deployed app matches
      the local repo (local HEAD was f0bab39, last sync record
      912a9e1, deployed 26 Oct). Patching a different version than
      the live one is a defect, not a shortcut.

### Phase 2 — code + wiring

- [ ] `server/hermes-workspace.mjs` + media resolver: shared-media
      read exception (all active bots read, Main-only writes,
      profile directories still excluded).
- [ ] Reminder end-to-end test: Alfred cron → Telegram delivery,
      plus the in-chat fallback.
- [ ] Calendar: connect Google Calendar, or ship the shared
      calendar file in `main/shared/` as v1 if OAuth is declined.
- [ ] Dashboard additions (optional, not blocking): core version +
      last sync status per bot, task board view from `TASKS.md`.

## 9. Acceptance tests (all must pass before the team is "live")

- A1. Main delegates to a worker; the worker replies; Main reports
  the result attributed by bot name, with the file verified to exist.
- A2. A worker proposes a Tier 1 fact; after Main's promotion and a
  sync, every bot's AGENTS.md contains the new core line.
- A3. A worker proposes a Tier 2 rule; it does NOT reach core
  without the user's approval.
- A4. A worker edits its shared-docs copy; the next sync restores
  the source version.
- A5. A worker tries to read another bot's workspace via the
  dashboard; it is refused.
- A6. A worker tries to message another worker directly; the relay
  returns 403.
- A7. A worker's session fact, never promoted, does not appear in
  any other bot's context or memory in a later session.
- A8. A worker reads a shared-media file (Phase 2) and cannot write
  to shared media, cannot read another bot's media.
- A9. A relay task times out; Main reports "waiting on <bot>",
  then reports the real reply once it lands, never a placeholder.
- A10. Alfred's reminder fires and arrives on the user's phone
  (Telegram) at the set time; the in-chat fallback is demonstrated
  separately.
- A11. The 2 orphan Failed entries are annotated as "job deleted"
  or resolved, and no bot reports "no failures" while Activity
  still flags current ones.
- A12. A bot asked for an external fact cites source + observation
  time and labels stale data stale.

## 10. Open decisions (yours, everything else above is decided)

1. Role mapping for the 8 bots (draft was given with the plan;
   confirm or swap).
2. Messaging channel: Telegram recommended, or another.
3. Paid-lane spend cap number (or "no paid lane at all").
4. Session history window: default 20 turns (change if you want
   longer/shorter).
5. Core budget: default ~4,000 injected characters.
6. Whether Main may promote Tier 1 facts alone (recommended: yes),
   or every promotion needs you (slower, safer).

## 11. What this spec deliberately does NOT do

- No bot reads another bot's memory or chat directly, ever. There
  is no "shared context pool" to add later without breaking
  Principles 3 and 4.
- No auto-promotion, no auto-deletion of core, no auto-spending.
- No credentials in any new store. The registry, stateDir secrets,
  and Secure Vault remain the only credential homes.
- No change to the relay's Main-only fan-out, the file-route jail,
  or the registry tombstone rule. Those are load-bearing walls.
