# Briefing — design and build contract

A master Claude session reads Slack every six hours and puts everything that
needs Jaswanth on the ks-flow board with a due time. Each item escalates
(calm → warm → hot → overdue) as its time runs out, and **only the person
archives** — nothing closes or archives on its own. Goals: accountability
(nothing owed is lost, "I'll do it" is tracked as a promise) and efficiency
(one ordered list, no repeats, quick asks batched).

The design started as two claude.ai artifacts (a plan and a canvas of
screens: Briefing page, item dialogs, log-off review), since deleted; the user
keeps exported copies. This file is the source of truth for the build; where it
and those designs differ, this file wins.

## Parts and who owns which files

| Part | Owns | Depends on |
|---|---|---|
| A · store + CLI | `pocketbase/pb_migrations/1700000005_briefing.js`, `src/lib/db/types.ts` (briefing types + store interface), every provider in `src/lib/db/providers/`, `src/lib/briefing/*` (escalation, grouping, CLI), `src/briefing-cli.ts`, the `briefing` verb in `bin/ks-flow`, the `briefing` block in `src/lib/boardsettings.ts`, `web/lib/briefing-escalation.ts` (verbatim copy) | this contract |
| B · daemon | `src/daemon.ts` (new jobs only), `src/lib/briefing/notices.ts`, `src/lib/master.ts` | A |
| C · board | everything under `web/` except `web/lib/briefing-escalation.ts` | this contract (A's module by its API below) |
| D · master | `plugins/ks-master/**`, `plugins/ks/scripts/claude-ks-master`, the `--master` mode of `plugins/ks/scripts/claude-ks-rc-restart`, the `ks-master` entry in `.claude-plugin/marketplace.json` | this contract |

## Data

Store convention (as `reminders`, `backup_runs`): each record has `uid`,
`projectKey`, the full doc in `data` (json), and a few fields mirrored out so
reads filter server-side. Rules public (`""`) — PocketBase binds 127.0.0.1.

| Collection | uid | Mirrored fields | Indexes |
|---|---|---|---|
| `briefing_items` | `itemUid(key)` (below) | `key`, `groupKey`, `status`, `dueAt`, `archivedAt` (`''` while open) | unique (projectKey, uid); (projectKey, status); (projectKey, groupKey); (projectKey, archivedAt) |
| `briefing_runs` | uuid | `startedAt` | unique (uid); (projectKey, startedAt) |
| `daily_logs` | `YYYY-MM-DD` (local date) | `date` | unique (projectKey, uid) |
| `master_events` | uuid | `at` | unique (uid); (projectKey, at) |

Firestore: `projects/<id>/briefingItems`, `briefingRuns`, `dailyLogs`, `masterEvents`.

```ts
export type BriefingKind = 'ask' | 'promise' | 'fyi';
export type BriefingStage = 'calm' | 'warm' | 'hot' | 'overdue';
export type DueRule = 'message' | 'promise' | 'dm' | 'mention' | 'fyi' | 'manual';
export type Resolution = 'done' | 'not-mine' | 'wont-do';

/** Where the item came from in Slack. Both links are always stored so items
 * can be grouped and found by either. */
export interface SlackRef {
  channel: string;            // C…/D…/G… id
  channelName: string | null; // "#ai", "DM", "group DM"
  ts: string;                 // this message's ts
  threadTs: string | null;    // the thread root's ts when this message is a reply; null for a root message
  messageUrl: string;         // permalink to THIS exact message
  threadUrl: string | null;   // permalink to the thread's ROOT message; null when this message is the root
  from: { id: string; name: string };
  text: string;               // the exact message text
  sentAt: string;             // ISO
}

export interface DueChange {
  at: string;                 // ISO, when the change was made
  from: string | null;        // previous dueAt (null on first set)
  to: string;
  by: 'master' | 'you';
  reason?: string;
}

export interface BriefingItemDoc {
  uid: string;
  key: string;                // `slack:<channel>:<ts>` — one item per Slack message
  groupKey: string;           // `slack:<channel>:<threadTs ?? ts>` — every item in one thread shares it → one card
  kind: BriefingKind;
  title: string;              // one line, what is asked or promised
  why: string;                // one line: why it is on the list / why this due time
  source: SlackRef;
  receivedAt: string;         // ISO (= source.sentAt)
  clockStart: string;         // ISO: receivedAt, or the next Monday 09:00 when received on a weekend
  dueAt: string;              // ISO
  dueRule: DueRule;
  dueSetByYou: boolean;       // true once the person sets a due time; the master never changes it after
  dueHistory: DueChange[];
  pushedCount: number;        // times the person moved dueAt later
  fyiCap: boolean;            // true for kind 'fyi': the stage never passes 'warm'
  quick: boolean;             // a small ask (≈ under 5 min): eligible for the Quick replies batch
  unit: string | null;        // KAR-… when linked to a ticket
  links: { label: string; url: string }[];  // PR, ticket, doc …
  evidence: { at: string; text: string; url?: string }[];  // "looks done" hints; never closes anything
  linkedTo: string | null;    // uid of an archived item this one follows up
  status: 'open' | 'archived';
  archivedAt: string | null;
  resolution: Resolution | null;
  archiveNote: string | null;
  // (no `notified`: the daemon keeps the notices it sent in <dataDir>/master/notices.json)
  createdBy: 'master' | 'you';
  runId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BriefingRunDoc {
  uid: string;
  trigger: 'schedule' | 'button' | 'log-in' | 'log-off' | 'manual';
  slot: string | null;        // '06:00' for a scheduled run
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'ok' | 'failed';
  slackCursor: string | null; // ISO: Slack read up to here; the next run starts from it
  added: number;
  updated: number;
  summary: string | null;
  error: string | null;
}

export interface DailyLogDoc {
  uid: string;                // 'YYYY-MM-DD'
  date: string;
  logInAt: string | null;
  logOffAt: string | null;
  logIn: Record<string, unknown> | null;   // what /ks-master:log-in reported (plan, counts, sessions)
  logOff: Record<string, unknown> | null;  // what /ks-master:log-off reported (archived, slipped, sessions, time)
  sessions: { unit: string; sessionId: string | null; phase: string | null; state: string; lastDid: string; suggestion?: string }[];
  updatedAt: string;
}

/** Something done to or for the master in the background — the Activity Log's
 * Master rows. request files and daemon-state.json keep only what is pending
 * and the last action; this is the history. */
export interface MasterEventDoc {
  uid: string;                // uuid
  at: string;                 // ISO
  kind: 'start' | 'restart' | 'request';
  trigger?: 'schedule' | 'button' | 'restart';  // a request's
  slot?: string | null;       // a schedule request's slot
  reason: string;             // the supervisor's why, or what asked ('06:00 slot', 'Brief me now (board)')
  by: 'daemon' | 'board';
  result?: 'ok' | 'failed' | 'dropped';  // absent while a start/restart command still runs
  detail?: string;            // request id / file, the command's exit, an error
}
```

Writers of `master_events` (best-effort: a failed write is logged and never
stops the action):

- **daemon** (`src/lib/master-events.ts`): each start / hard restart the
  supervisor runs (`reason` = its why), written as the command launches with no
  `result`, then updated when it exits (`ok` on exit 0, else `failed` with how it
  ended; `failed` at once when it could not be launched). Each schedule request:
  `ok` with the request id, or `dropped` when one was already pending.
- **board** (`POST /api/briefing/request`): each Brief me now / Restart master
  press — `ok` (the file name), `dropped`, or `failed` (the write error).

`itemUid(key)`: `key` with every character outside `[A-Za-z0-9_-]` replaced by
`_` (`slack:C123:1730392.45` → `slack_C123_1730392_45`).

### Grouping (one card per thread)

- Items with the same `groupKey` render as **one card** on the board: the card
  lists each item (its own kind, text, due chip, Archive). The card takes the
  **worst** stage of its open items and sorts by its earliest open `dueAt`.
- Archiving stays per item. The card also has "Archive all…" (one dialog,
  one resolution and note applied to each open item).
- Before adding, the master looks up existing items by `groupKey`, `messageUrl`
  and `threadUrl` (`ks-flow briefing find`). A new message in a thread that
  already has an open item is added as a new item in the same group, never
  merged into the old one. A message on a thread whose items are all archived
  gets `linkedTo` = the newest archived item's uid.

## Escalation (pure module — `src/lib/briefing/escalation.ts`)

No imports. The board keeps a verbatim copy at `web/lib/briefing-escalation.ts`
(a test asserts the two files are identical below the first comment line).

```ts
export const STAGE_AT = { warm: 0.5, hot: 0.8 } as const;
export function stageOf(item: Pick<BriefingItemDoc,'clockStart'|'dueAt'|'fyiCap'>, now: Date): BriefingStage;
  // elapsed = (now - clockStart) / (dueAt - clockStart); ≥1 → overdue, ≥0.8 hot, ≥0.5 warm, else calm.
  // fyiCap: never above 'warm'. dueAt ≤ clockStart: overdue once now ≥ dueAt, else hot.
export function clockStartFor(receivedAt: Date): Date;  // Sat/Sun (local) → next Monday 09:00 local; else receivedAt
export function shiftOffWeekend(d: Date): Date;          // Sat/Sun → Monday, same local time; else d
export function dueFor(input: {
  rule: DueRule; receivedAt: Date;
  messageDeadline?: Date;     // rule 'message': used as is, never shifted
  promise?: 'eod' | 'tomorrow' | 'none' | Date; // rule 'promise'
  halfTime?: boolean;         // sender on the half-time list: window halved
}): { clockStart: Date; dueAt: Date };
  // dm +4h, mention +24h, fyi +24h, promise: eod = 19:00 that working day,
  // tomorrow = next working day 12:00, none = +24h, a Date as said;
  // all from clockStart, then shiftOffWeekend (except 'message' and an explicit promise Date).
export type BoardSection = 'overdue' | 'hot' | 'quick' | 'today' | 'later' | 'fyi';
export function sectionOf(stage: BriefingStage, item: Pick<BriefingItemDoc,'kind'|'quick'|'dueAt'>, now: Date): BoardSection;
  // fyi kind → 'fyi'; overdue → 'overdue'; hot → 'hot'; quick → 'quick';
  // dueAt before local midnight → 'today'; else 'later'.
export const SECTION_ORDER: BoardSection[] = ['overdue','hot','quick','today','later','fyi'];
export function groupItems<T extends { groupKey: string; dueAt: string; status: string }>(items: T[]): { groupKey: string; items: T[] }[];
  // open items only, grouped by groupKey, items by dueAt asc, groups by earliest dueAt.
export function groupStage(stages: BriefingStage[]): BriefingStage; // worst
```

Local time = the machine's timezone. Holidays: later, via Google Calendar.

## CLI — `ks-flow briefing …` (the master's only write path)

Node entry `src/briefing-cli.ts` → `dist/briefing-cli.js`; `bin/ks-flow briefing "$@"`.
All output JSON with `--json` (default for `context` and `find`). Writes go
through the daemon-side store (`src/lib/db`) for the configured project.
**There is no archive, delete or un-archive command** — the board alone does that.

| Command | Does |
|---|---|
| `context [--json]` | `{ now, cursor, lastRun, settings: {names, halfTime, schedule}, open: BriefingItemDoc[], knownKeys: string[] (every item's key, archived too), archivedRecent: BriefingItemDoc[] (last 14 days), board: { units: [{identifier, title, phase, linearStatus, waiting, inbox, pr, worktreeDir, liveSessions}], inboxOpen } }` |
| `find --group <groupKey> \| --thread <threadUrl\|messageUrl\|ts> \| --key <key>` | matching items, open and archived |
| `add <file.json \| ->` | upsert one item or an array. Input omits `uid`, `groupKey`, `dueHistory`, `pushedCount`, `notified` (refused; not part of an item), `status`, timestamps — the CLI derives them (`groupKey` from `source`, `clockStart`/`dueAt` from `dueFor` when `dueAt` is absent). On an existing key: updates `title`, `why`, `links`, `evidence`, `quick`, `unit`; changes `dueAt` only when `dueSetByYou` is false (recorded in `dueHistory`, `by: 'master'`); never touches an archived item (prints `{skipped: 'archived'}`). |
| `evidence <uid> --text <t> [--url <u>]` | append one evidence line |
| `run start --trigger <t> [--slot 06:00]` | creates a running `BriefingRunDoc`, prints it (uid, previous cursor) |
| `run finish <runUid> --cursor <iso> --added <n> --updated <n> [--summary <s>] [--failed <error>]` | completes the run, moves the cursor |
| `daily set <YYYY-MM-DD> --part log-in\|log-off <file.json>` | writes that part of the daily log (+ `sessions`, `logInAt`/`logOffAt`) |
| `daily get [<YYYY-MM-DD>]` | one daily log |

Board settings (`board-settings.json`, block `briefing`): `{ enabled: boolean,
schedule: ['00:00','06:00','12:00','18:00'], names: ['Jaswanth'], halfTime:
string[] /* Slack user ids, empty for now */, slackUserId: string | null }`.

## The master

- **Plugin `plugins/ks-master/`**, loaded only by `claude-ks-master`
  (`claude-ks --local-plugin ks-master …`): skills `briefing`, `log-in`,
  `log-off`, `restart` (`/ks-master:…`), the wake-up mod `hooks/register.ts`,
  the master instructions it sends as hidden `prompt.submit` context.
- **Runs in** the karmasuite main checkout (`KS_PROJECT_ROOT_PATH` from
  `plugins/ks/.config`), always in its own tmux session `ks-master`, Remote Control on.
- **Identity**: `<dataDir>/master/session.json` — `{ v: 1, sessionId, pid,
  tmuxPane, cwd, startedAt, handoff: string | null }`. `claude-ks-master` writes
  it at launch (it picks the session id and passes `--session-id`); the mod
  fills `pid` once loaded. The daemon and board find the master only through
  this file. `<dataDir>` = the ks-flow data dir (`src/lib/datadir.mjs`).
- **Heartbeat**: the mod writes `<dataDir>/master/heartbeat.json` `{ sessionId,
  at, busy }` every 30 s.
- **Requests**: `<dataDir>/master/requests/<iso>-<trigger>.json` `{ v: 1, id,
  trigger: 'schedule' | 'button' | 'restart', slot: string | null, createdAt,
  prompt }`. The mod checks every 15 s; when the session is idle it moves the
  file to `master/done/` and calls `$.prompt.submit({ text: prompt })`; while a
  turn runs it waits. Writers: daemon (schedule), board API (button, restart).
  One pending request per trigger (a second one is dropped).
- **Restart**:
  - Graceful (`trigger: 'restart'`, or the master deciding to — context over
    ~70%, or after log-off): the master writes a handoff with
    `/ks:create_handoff` into `workflow/<user>/ks-master/handoffs/`, records it in
    `session.json.handoff`, then runs `claude-ks-rc-restart --master`.
  - Hard (daemon: a request pending > 15 min and heartbeat older than 5 min):
    `claude-ks-rc-restart --master --force` — no handoff; the new session
    resumes from the latest one there is.
  - Start (no live master process): the daemon runs `claude-ks-master --detached`
    (a new window in the tmux session `ks-master`, or that session created).
  - Every new master's first message: `/ks-master:start` (its own skill — "Let's resume working on this project" made a master in the karmasuite checkout resume a ticket workflow instead);
    it reads the newest file in the master handoffs folder first.
- **Slack scope**: DMs (incl. group DMs), @mentions anywhere, "Jaswanth"
  written anywhere, and the person's own messages (to spot promises and
  replies; never shown as items). No channel is read in full.
- **Sandbox**: in the master's project `ks-flow` must be a sandbox-excluded
  first-word command (like `slack`), and PocketBase on 127.0.0.1 reachable.

## Daemon

- **Stages and notices**: every 60 s recompute each open item's stage; send one
  macOS notice when an item first turns hot, one when it turns overdue, and a
  re-nag for every still-overdue item at each scheduled slot. On startup:
  recompute, and if any items crossed into hot/overdue while the daemon was
  down, send **one** summary notice (not one per item). The pause and
  reminders switches apply. `<dataDir>/master/notices.json` `{ v: 1, items:
  { <uid>: { hot?, overdue?, lastNag? } } }` records what was sent — the
  daemon's own file; **the daemon never writes a briefing item**.
- **Schedule**: at each `briefing.schedule` slot (local), write a `schedule`
  request (skipped when `briefing.enabled` is false). A slot missed while the
  daemon was down is written once at startup if within the last 6 h.
- **Supervision** (every 60 s): no live process for `session.json` → start the
  master; request stuck (above) → hard restart. At most one start/restart per
  10 min.

## Board

Pages share one header: ks-flow + project, tabs **Board · Briefing · Daily log ·
Notes · Activity Log** (Notes only when enabled), then on the right the 🔔 count
(hot + overdue; an inline bell SVG, red when > 0), an **Inbox** button opening
the Plannotator Inbox (badge = open questions + unseen messages across cards),
and a **master** chip (live/busy/stale/starting/down, from heartbeat + session.json).

- **Briefing** (`/briefing`): screens' "Briefing page". Next-up card (first
  card of the first non-empty section), sections in `SECTION_ORDER`, cards
  grouped by `groupKey`, FYI folded, "Show N archived today". Sidebar: master
  card (Brief me now → `button` request, Restart master → `restart` request,
  Open in Claude → `https://claude.ai/code/<bridgeSessionId>` when known),
  sessions roll call (work units with live sessions / waiting / inbox, and Done
  units whose worktree is still on disk), today's counts. Stages update live
  (`useNow`).
- **Change due** dialog: +1h, +4h, tomorrow 12:00, next Monday 09:00, date +
  time, optional reason; warns when moving later; writes `dueAt`,
  `dueSetByYou: true`, a `dueHistory` entry `by: 'you'`, `pushedCount + 1`
  when later. Shows the item's due history.
- **Archive** dialog: the item, its evidence (marked "a hint only"), links, a
  note, resolution Done / Not mine / Won't do, red **Archive** button.
- **Daily log** (`/daily`, `?date=YYYY-MM-DD` opens a day): screens' "Log-off
  review" from `daily_logs` plus items archived / created / gone overdue /
  pushed that day.
- **Activity Log** (`/activity`, replaces the Backups page; `/backups`
  redirects to `/activity?type=backup`): every background run, newest first,
  with a type chip and filter chips — Backup (`backup_runs`), Briefing
  (`briefing_runs` schedule / button / manual), Log-in / Log-off
  (`briefing_runs` with those triggers, linked to that day's `/daily`), Master
  (`master_events`).
- API routes (server-side writes, like `app/api/reminders`):
  `POST /api/briefing/due`, `POST /api/briefing/archive` (one or many uids),
  `POST /api/briefing/request` (`button` | `restart`, writes the request file
  and a `master_events` record),
  `GET /api/briefing/master` (session.json + heartbeat + live check).

## Decisions made while building

- `briefing.enabled` defaults to **false**: no master is scheduled or started until it is turned on in Settings.
- The launcher loads the plugin with `claude-ks --local-plugin ks-master` (the repo folder, no install). The master instructions ride as hidden `prompt.submit` context on the conversation's first prompt and on every wake-up. They were a `prompt.compose` section at first, but Claude Code's built-in guard `cc-plugin-sec-default` (Team/Enterprise accounts) skips that event for user-tier plugins, so they never arrived. The mod logs every wake-up it submits to `master/mod.log` with whether it entered or was dropped (and why).
- A fourth skill, `/ks-master:restart <reason>`, holds the graceful restart (handoff into `$KS_MASTER_HANDOFFS`, then `claude-ks-rc-restart --master --handoff <file>`). Log-off, the board's restart request and the mod's context check (past 70%, once, when idle) all use it.
- The launcher exports `KS_MASTER_DIR=<dataDir>/master` and `KS_MASTER_HANDOFFS`; without `KS_MASTER_DIR` the mod does nothing. Only the master `session.json` names may write `session.json` and the heartbeat.
- Request file names are `<new Date().toISOString()>-<trigger>.json`, written as a dot-file and renamed; a request is dropped when one with the same trigger is pending.
- `<dataDir>/master/daemon-state.json` `{v, slotAt, lastActionAt, lastAction}` is the daemon's own (slots handled, the 10-minute action gap). Others may read it, never write it.
- A `session.json` with `pid: null` under 3 minutes old counts as starting, so the daemon never launches a second master while one boots.
- Several notices owed in one tick (startup catch-up, a pass that adds late items, slot re-nags) become one summary notice.
- `add` merges `links` and `evidence` instead of replacing them.
- **`notices.json` replaces `item.notified`.** The daemon used to record each notice on the item (re-read, then upsert the whole doc), which raced the board: an archive or due change landing in between was reverted. Now it keeps `<dataDir>/master/notices.json` `{v: 1, items: {<uid>: {hot?, overdue?, lastNag?}}}` (atomic write before the notice is sent; uids no longer open are pruned) and never writes an item. A due change needs no clearing: the daemon counts a notice only if sent after the latest `dueHistory` entry, so moving a due time (CLI or board) re-arms every notice. The CLI still refuses a `notified` field in its input.
- **Writers re-read before writing.** The CLI's `add` (update) and `evidence`, and the board's archive, re-read the item right before the write and skip one archived meanwhile (`{skipped: 'archived'}`); the due route reads right before its write. A write landing in the milliseconds between that read and the write can still be lost: PocketBase REST has no transaction.
- **`archivedAt` is mirrored** on `briefing_items` (`''` while open; index (projectKey, archivedAt)). The board loads `status = 'open' || archivedAt >= now − 60 days` (Firestore: two queries), so an item archived today that fell due long ago still shows, and the Daily log reaches back 60 days.
- **Finding the master's process.** `session.json` has `pid: null` until the mod fills it, so `claude-ks-master`, `claude-ks-rc-restart --master` and the board look the process up by session id in `~/.claude/sessions/*.json` (`kind: interactive`, a live pid running `claude`), as the daemon does through its live sessions. With no process found and `session.json` under 3 minutes old the master is **starting**: `claude-ks-master` refuses to start another, `claude-ks-rc-restart --master` exits 1 (with `--force` too: it restarts only a process it found), and the board shows `starting`. The restart's own relaunch passes `KS_MASTER_REPLACING=<old session id>` so `claude-ks-master` may replace the session it just stopped. The board counts the heartbeat only when its `sessionId` is session.json's.
- The daemon also counts a master with `pid: null` as starting (not down) while `heartbeat.json` is under 2 minutes old and its `sessionId` matches session.json's, past the 3-minute `startedAt` grace too.
- The daemon runs `claude-ks-master` / `claude-ks-rc-restart` detached with their output appended to `<dataDir>/master/launch.log` (no pipes back to the daemon, so a daemon exit can't SIGPIPE them), through `zsh -c` with the login profile (tmux and claude on PATH under launchd) and the script + args as argv. Only those two get `KS_MASTER_DIR=<dataDir>/master` in their env; `claude-ks-master` uses it when set (else resolves the data dir), and `claude-ks-rc-restart --master` passes its own on to the relaunch.
- **`master_events` is history, not state.** The daemon decides from its files (session.json, heartbeat, requests/, daemon-state.json), never from `master_events`; the Activity Log only reads it. A start/restart event is written as the command launches and completed (`result`) after that first write settled, so the update finds the record instead of creating a second one. A daemon that restarts before the command exits leaves it without a result (the board shows *No result* after 15 min). The daemon records a schedule request only when it writes or drops one, not a failed file write (that tick retries every minute).
- **The Activity Log's backup rows still come from `/api/backup-runs`** (the CLI judges running vs interrupted by the run's pid); the shared provider subscribes to `backup_runs` only as a change signal for that re-read. `useBriefing` keeps the newest 100 briefing runs (was 30) so the log reaches back further.

- **Start master** (board, shown while no master runs, in place of Restart): the board writes `<dataDir>/master/start-request.json` `{v:1, at, by}`; the daemon watches the folder and takes it within a second (its 60 s tick catches one it missed), briefing on or off, and runs `claude-ks-master --detached` unless a master runs or is starting (no 10-minute gap: a person asked). Recorded in `master_events` (`kind: 'start'`, `by: 'board'`). Restart with no running master is refused (409), and a master drops any `restart` request made before its `startedAt`, so a fresh master never restarts itself on an old click.

## Build notes (all parts)

- Bash cannot write under `plugins/ks` or `plugins/ks-flow` (sandbox). Create
  and change files there with the Edit/Write tools. Typecheck without writing:
  `npx tsc --noEmit --incremental false -p <dir>`. `npm test` in `src/` runs the
  node:test suite. `next build` and `ks-flow start/stop` cannot run from the
  sandbox; the person runs them.
- Do not commit. Do not touch files another part owns; if you need a change
  there, say so in your report.
