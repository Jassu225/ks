# ks-flow

A per-project Kanban board over your Claude Code sessions, plus macOS notifications the moment a session blocks waiting for you.

`ks-flow` watches the append-only JSONL transcripts Claude Code writes for every session, joins them to the ks workflow `state.yaml` files, and renders a live board. **Columns are the workflow phases defined per project** (from `state.yaml`), not hard-coded statuses. Cards are work-units (tickets/projects); each sits in the column of its current phase, and the Claude sessions working it contribute live activity + a "waiting on you" badge.

It is **read-only** with respect to Claude Code: it observes and notifies, never launches or resumes a session.

## Scope: one project, not the whole machine

At enable time the plugin asks for a **project path** (the main worktree / repo root). It tracks **only** sessions whose working directory belongs to that project or any of its git worktrees — keyed off the project's shared git-common-dir. Every other session on the machine is ignored. The plugin installs at **user scope** so its hooks fire in any session, but both the daemon and the hook scripts apply a runtime project filter.

## Architecture

```
project_path ─► PROJECT_COMMON_DIR (git rev-parse --git-common-dir)
                │
~/.claude/projects/<in-project dirs>/<sessionId>.jsonl ──► ingester daemon (launchd, always-on)
                                                            │ filter by common-dir, derive, batch upsert
                                                            ▼
plugin hooks (user scope)                              DB provider (PocketBase default / Firestore)
  PreToolUse[AskUserQuestion|ExitPlanMode]                 {workUnits,sessions,…} (flat)  
  PermissionRequest, Elicitation                           │ real-time (SSE / onSnapshot)
  │ filter on .cwd → terminal-notifier + events.jsonl      ▼
  ▼                                                  Next.js board (ks-flow open)
(notification, daemon-independent)                   COLUMNS = phase model the board derives from every card

<main_worktree>/workflow/<user>/**/state.yaml ─► daemon ─► WorkUnitDoc (deviceId = this device)
```

- **Writer** = the ingester daemon (the only writer of cards and sessions; with [several devices](#several-devices), each daemon writes only its own).
- **Hook scripts** = notify + append local events (never touch the DB).
- **Reader** = the Next.js board (subscribes in real time, never writes).

Ingestion bookkeeping (byte offsets, inode) stays in a local `checkpoints.json` in `${CLAUDE_PLUGIN_DATA}` — per-line churn that must not incur cloud writes. Only derived session/work-unit documents go to the DB.

**Log rotation.** The daemon rolls both its logs **daily**, keeping the **last 30 days**: the hook-appended `events.jsonl` → `events.<YYYY-MM-DD>.jsonl` and the daemon's own `daemon.log` → `daemon.<YYYY-MM-DD>.log` (all in `${CLAUDE_PLUGIN_DATA}`). The roll happens at the first tick past midnight (60s granularity) — `events.jsonl` is drained to EOF first so no event is lost, then its read offset resets; a same-day restart **appends** to the day's `daemon.log`, and a leftover file from a day the daemon was down is rolled out at startup. Older rolls past 30 are pruned.

**One clock.** Every periodic job in the daemon runs off a single 15s clock (`src/lib/schedule.ts`, the same shape as the ks mod's). Each tick runs the jobs whose interval has passed since their last run (kept in memory). A job still running from an earlier tick is skipped rather than stacked, and after sleep each overdue job runs once on the first tick.

| Job | Every | Gate |
|---|---|---|
| `stateYaml` | 15s (1 tick) | re-parse only `state.yaml` files whose mtime changed |
| `reminders` | 30s (2 ticks) | stop-nudges + due custom reminders; a gap > 2 min means the Mac woke |
| `worktrees` | 60s (4 ticks) | `git worktree list` vs the known set; on a change, recompute + kick `stateYaml` |
| `liveSessions` | 15s (1 tick) | re-read `~/.claude/sessions/*.json`; recompute only when the set of live processes changed |
| `backup` | 60s (4 ticks) | enabled → not tried today → no sweep running → not swept today → past the time (or > 24h) |
| `rotateLogs` | 60s (4 ticks) | today's date differs from the open log's |
| `linear` | 3 min (12 ticks) | every ticket with a live worktree, Done ones included; one `linear issue batch-get` call |
| `inbox` | 15s (1 tick) | Plannotator Inbox: read only what its project logs appended; `inbox.json` each tick, a health check every minute; recompute only on a change (see **Plannotator Inbox**) |

**Live Linear fields.** A card's title, status, priority, estimate and Linear URL start as the `state.yaml` snapshot taken when the ticket was started. The `linear` job reads the current values for every ticket on the board in one call (the ks plugin's `linear issue batch-get`, one GraphQL query per team) and lays them over the snapshot in the daemon's memory, so the card, its column and its Done check follow Linear without anything rewriting `state.yaml`. A failed call keeps the last values and logs one line. Once Linear says a ticket is finished (by status name, or by Linear's `completed`/`canceled` state type, so custom names like "Shipped" count), the card moves to the **Done** column. It is still polled while its worktree exists, so a reopened ticket moves back to its phase column.

Each card's header is a **status ribbon** in the colour Linear uses for that state (before the first sync, Linear's default colour for the status). Its **↻ refreshes the whole card** now: the board appends a `RefreshCard` event to `events.jsonl`, and the daemon runs the per-card form (`runFor`) of every clock job that has one, in table order — `worktrees` (the one `git worktree list`), `liveSessions` (re-read the running Claude processes), `stateYaml` (re-parse this card's `state.yaml` copies, ignoring the mtime gate), `linear` (`batch-get` for this ticket alone), `inbox` (the same read as the tick: one read covers every card) — then catches up the card's session transcripts and rewrites it with `cardRefreshedAt` (and `cardRefreshError` naming any step that failed). The board re-reads the backup status at the same time. `reminders`, the `backup` sweep and `rotateLogs` have no per-card form: they notify, upload or roll logs rather than read card data. The spinner stops when `cardRefreshedAt` moves; a failed step, or no answer in 60s, shows `!` with the reason in its tooltip.

Event-driven work stays off the clock: the chokidar watchers, the session-upsert (1s) and device-recompute (0.7s) debounces, and PocketBase's respawn. At start-up, backfill scans `state.yaml` and a reminder pass runs after the stop-nudges are re-armed; the clock's first tick follows 15s later.

**Live sessions (pid per card).** Claude Code writes `~/.claude/sessions/<pid>.json` (pid, session id, cwd, process start time, tmux pane) when a session starts and deletes it on a clean exit. The daemon reads that folder on each add/unlink and on the `liveSessions` tick, which catches a crash's leftover file. A file counts only while its pid is alive **and** `ps lstart` matches its recorded start time, since macOS reuses pids. Each live interactive process whose `cwd` is inside a card's worktree goes on that card as `liveSessions[]` (newest first). The newest one is also stored as `activeSession`: `{ pid, sessionId, cwd, procStart, startedAt, tmuxPane, name }`. Only fields that never change for the process are kept, so busy/idle flips don't rewrite the card. `ks-flow session <unit> --json` reads them back. The ks plugin's `claude-ks-restart` uses it to find the session to replace.

### Work-unit sourcing & I/O

A ticket's `state.yaml` lives in its worktree while in progress; on completion the workflow is copied back to the main checkout and the worktree is deleted. The same unit can therefore appear in both places, so the daemon dedups per unit by **source precedence**: a **worktree copy always overrides the main-checkout copy**, and the main copy wins only once no worktree carries that unit (i.e. after cleanup).

Both the start-up backfill and the 15s rescan are gated to avoid needless work:
- **Read gate** — `state.yaml` is re-parsed only when its `mtime` changed (completed tickets' files in the main checkout accumulate forever but never change, so they're stat-ed, not re-parsed).
- **Write gate** — a work-unit/device doc is upserted only when its content actually changed (signature compare, excluding `updatedAt`), so a single edit doesn't re-write the whole set.

Both gates are in-memory, so a daemon restart does one cold pass, then steady-state stays cheap.

## Setup

ks-flow depends on the ks plugin (`"dependencies": ["ks"]`) and is set up with
it: in the KarmaSuite checkout, `claude plugin install --scope local ks-suite@karmasuite` then `/ks:setup` (installed), or
`plugins/ks/init-dev` (a clone). `./init` here hands over to `ks-setup apply`.

Prerequisites (`ks-setup doctor` checks them): `node` ≥ 18.17, `npm`, `git`,
`jq`; `terminal-notifier` (notifications), `zstd` (backups), `tmux` and Ghostty
or Terminal.app (the master); the KarmaSuite checkout as `KS_PROJECT_ROOT_PATH`;
the Slack and Linear tokens in the Keychain (`ks-config secret …`).

The daemon, the store and the board are self-bootstrapping — no build step.
On a session start `bootstrap.sh` builds the daemon into the data dir,
registers the always-on launchd agent, and, for a clone, records the plugin's
folder in `~/.config/ks/plugins.json` (an installed copy is found live from
Claude Code's own plugin files, as `ks-root` does). It tracks `project_path`, else
`KS_PROJECT_ROOT_PATH`, else the one project already set up. PocketBase is only
downloaded and started when it is the store. `ks-setup store` picks the store
(`pocketbase`, or `firestore --project <id> --credentials <key.json>`).
The board's Remove runs `remove_worktree -D {{path}}` from the project root
unless Settings names another command.

### Brand-new setup

For a new person on a new Mac, from nothing. Each step is safe to re-run.

1. **Tools.** `brew install node jq tmux terminal-notifier zstd` (and `git`,
   Claude Code). Clone the KarmaSuite repo; it is `KS_PROJECT_ROOT_PATH` below.
2. **Plugins, per project.** In the KarmaSuite checkout:

   ```bash
   cd <your KarmaSuite checkout>
   claude plugin marketplace add <path or URL of the ks repo>
   claude plugin install --scope local ks-suite@karmasuite     # ks + ks-flow
   ```

   `ks-master` is not installed, on the master device either: its launcher loads it
   from the marketplace's copy of the repo, so any device can be the master.

   Nothing is enabled user-wide: the switch lives in the checkout's gitignored
   `.claude/settings.local.json`.
3. **`/ks:setup`** in a Claude session in that checkout. It runs `ks-setup
   doctor` and `ks-setup apply` (config folder, `~/.local/bin` shims and the
   PATH line, the project path) and hands you the steps it won't run itself.
4. **Tokens**, typed by you with hidden input, never in chat (`!` runs a
   command from the Claude prompt; in a terminal, leave it out):

   ```bash
   ! ks-config secret linear.LINEAR_API_KEY
   ! ks-config secret slack.SLACK_TOKEN          # Briefing, Notes
   ! ks-config secret grain.GRAIN_API_TOKEN      # optional
   ```

   With the sandbox on, `/ks:setup` first asks you to run
   `! ks-setup claude-settings --self` (only `ks-setup` leaves the sandbox), then,
   once you agree, runs `ks-setup claude-settings --yes` itself: the other KS
   commands' sandbox entries (`ks-flow`'s too, as it is enabled), the Keychain
   deny rules and the statusline env.
5. **Store.** PocketBase (local, this Mac only) needs nothing. For the shared
   Firestore board, get the `ks-flow-store@ks-flow` service-account key file
   from whoever runs the GCP project and copy it onto the Mac yourself (AirDrop,
   a password manager): it is a secret file, never sent through chat or
   committed to git. Keep it outside every repo, then:

   ```bash
   ! ks-setup store firestore --project ks-flow --credentials <path to key.json>
   ```
6. **Cloud backup** (optional): the GCS credentials go in the data dir's
   `.env` (Settings → **Edit .env**; see [GCS archive on removal](#gcs-archive-on-removal)).
7. **Start.** `ks-flow start`, then `ks-flow open`. `ks-setup doctor` and
   `ks-flow status` should be clean.
8. **Another device already uses this store?** Then this one is an extra
   device: see [Several devices](#several-devices), "Adding a device".

**From a clone** (developing the plugins): `git clone <ks repo>`, then
`plugins/ks/init-dev` in place of steps 2–3. It loads the clone as the
`karmasuite` directory marketplace in your KarmaSuite checkout (plugins read in
place; edits apply on `/reload-plugins`), installs the CLI dependencies, and
runs `ks-setup apply` and `ks-setup claude-settings`. Steps 4–8 are the same.

### Configuration (`/plugin configure`; all optional)

| Key | Default | Notes |
|-----|---------|-------|
| `project_path` | `KS_PROJECT_ROOT_PATH` | Main worktree / repo root to track. Empty: the ks config's project path. |
| `workflow_user` | auto | The `workflow/<username>/` segment. |
| `db_provider` | auto | Blank ⇒ `pocketbase` (local default) unless a cloud Firestore project is set ⇒ `firestore`. Force with `pocketbase`/`firestore`. |
| `pocketbase_port` | 8090 | Localhost port for the bundled PocketBase server (`pocketbase` provider). |
| `firestore_mode` | `emulator` | `emulator` (local, no GCP) or `cloud`. Only used when `db_provider=firestore`. |
| `gcp_project_id` | — | Required when `cloud`. |
| `firestore_credentials` | — | Path to the Admin SDK service-account key JSON (daemon, board server, CLIs). Raw env: `FIRESTORE_CREDENTIALS`. Falls back to Application Default Credentials. |
| `idle_minutes` | 30 | Idle threshold. |
| `notify_throttle_sec` | 20 | Repeat-notification suppression window. |
| `board_port` | 4317 | Next.js board port. |

### Local-only (no cloud) — the default

Out of the box the plugin uses **PocketBase**: `bootstrap.sh` downloads a single
local PocketBase binary into `${CLAUDE_PLUGIN_DATA}/pocketbase/`, and the daemon
starts it (and applies the bundled schema migrations) automatically. No GCP, no
emulator, no credentials. The board reads from it live over SSE.

To use Firestore locally instead, set `db_provider=firestore` and run the
emulator:

```bash
firebase emulators:start --only firestore
```

### Store: Firestore (cloud)

The KarmaSuite setup keeps the store in Firestore: GCP project `ks-flow`, its
`(default)` database (shared with ks-works' `slack_user_tokens`). The GCP
project holds one board, so the collections are **flat, at the database root**
(no per-project level): `devices`, `meta/settings`, `workUnits`, `sessions`,
`reminders`, `backupUnits`, `backupRuns`, `briefingItems`, `briefingRuns`,
`dailyLogs`, `masterEvents`, `masterRequests`, `deviceCommands` (the
[message board](#message-board-commands)) and the `slack_names` cache.
`meta/project` is retired: the [device backfill](#several-devices) moves it into
`devices/<id>`. One board may span [several devices](#several-devices); a
second *board* (another person, another project) on the same database would mix
its data in, so give it its own GCP project.

**Every read and write uses the Admin SDK.** That covers the daemon, the CLIs
and the board's own Next.js server. The browser never talks to Firestore: the
board server streams it the live collections over Server-Sent Events
(`/api/store/live?scope=board,briefing,activity`), one stream per tab for all three: a browser keeps at most 6 connections per site, so a stream per page part would starve every other request once two tabs are open. So there is no Firebase Auth,
no browser API key, and no client access at all.

**No timed reads: listeners only.** Nothing reads Firestore on a timer. The
daemon keeps one snapshot listener per collection a job needs (`src/lib/live-sources.ts`):
`meta/settings`, `devices`, the cards other devices own (`workUnits` where
`deviceId != self`), `reminders`, the open `briefingItems`, the newest 100
`backupRuns`, `backupUnits`, and `masterRequests` on the master device. Its jobs
read their latest copies from memory. A listener costs one read per doc when it
attaches and one per changed doc after that, so an idle store costs nothing. The
daemon has **one timer, every 15 s**: it first attaches again any listener that
stopped (an error ends a Firestore listener for good; the wait doubles from 15 s
up to 15 min), then runs every job that is due (each job's interval is a multiple
of 15 s). The board's polled routes read only files that the daemon keeps current
from those listeners:
- `backup-status.json` holds each card's backup chip and Restore, the last sweep
  and the Activity Log's Backup rows. The bucket is listed again only after a
  backup changes the index or a run.
- `devices.json` holds the master chip on another device.
- `errors.json` drives the ⚠ icon.

The board's live data comes from its SSE stream's listeners. On PocketBase (a
local server) the daemon reads the store directly, as before.

**Problems: the Errors page (`/errors`).** Each device's daemon records what
fails in `<dataDir>/errors.json`:
- a listener that stopped, with its error and the time of the next attempt
- a job that throws
- the fix: an entry resolves when the listener delivers again or the job next
  succeeds; resolved entries stay 7 days

When something fails:
- **macOS notice:** sent once when a problem opens (for a job, from its third
  failure in a row) and once when it works again.
- **Header:** a ⚠ icon links to the page; it turns red, with the count, while
  any problem is open.
- **Doctor:** `ks-setup doctor` reports them as `ks-flow:errors`.

**The live security rules deny everything** (`firestore.rules`: `allow read,
write: if false` on every document). No browser or app can read or write the
database; the Admin SDK ignores rules, so ks-flow and ks-works (which shares
the `(default)` database and also uses only the Admin SDK) are unaffected.
`firebase deploy --only firestore:rules --project ks-flow` replaces the whole
database's ruleset: only ever deploy this deny-all file, never a rule that
allows anything.

**Writes are whole documents**, like PocketBase's `data` column: a cleared
field (a note's due time) is gone, not merged back. The exceptions are
`devices/<id>` (the daemon and the board each merge only their own fields) and
the backfill's `deviceId` tags.

**Config:** one source, `$CLAUDE_PLUGIN_DATA/.env`. The daemon, the board server
and `bootstrap.sh` all read it:

```
DB_PROVIDER=firestore
FIRESTORE_MODE=cloud
FIREBASE_PROJECT_ID=ks-flow
FIRESTORE_CREDENTIALS=/Users/<you>/Documents/tkns/GCP/ks-flow/ks-flow-store.json
```

**Credentials:** a dedicated service account, `ks-flow-store@ks-flow`, with
`roles/datastore.user`. Its key is referenced by path. The private key is
never copied into the launchd plist.

**Moving from PocketBase:**

1. With PocketBase still the store (and running), copy what the daemon can't
   rebuild: `ks-flow migrate-store` (dry run: counts per collection), then
   `ks-flow migrate-store --write --project ks-flow --credentials <key.json>`.
   It covers:
   - reminders, including Notes and pause flags
   - Briefing items, runs and daily logs
   - master events
   - backup runs and units (so the next sweep doesn't re-upload everything)
   - `slack_names`

   It refuses to write if Firestore already holds ks-flow data, unless you pass
   `--force`.
2. Add the four `.env` lines, then `ks-flow restart` (it brings the board back too; `ks-flow open` opens it in the browser).
   The daemon's startup backfill writes the cards and sessions.
3. Keep `pocketbase/pb_data` as a backup for a couple of weeks.

**Rollback:** remove the `.env` lines (or set `DB_PROVIDER=pocketbase`) and
restart. PocketBase still holds the data as of the switch.

**Offline mode.** firebase-admin keeps no local copy, so ks-flow keeps its own.

- **Writes:** every write gets 8 s. On a network failure, or that timeout, it
  goes to `<dataDir>/outbox/` instead, one JSON file per write (named
  `<epoch-ms>-<pid>-<seq>.json`, so it sorts FIFO), and the caller carries on.
  While the outbox holds anything, new writes queue behind it too, so an old
  write can never overwrite a newer one.
- **Sync:** only the daemon syncs. Every 5 s while anything is queued, backing
  off from 30 s to 5 min while offline. It folds each document's entries into
  one whole-doc write, applies them in batches, and deletes each file once it
  lands.
  - A write Firestore refuses for any other reason (bad data) moves to
    `outbox/failed/` and is logged.
  - A write that timed out is given 70 s to settle before anything is synced,
    because firebase-admin may still deliver it late.
- **Reads:** the board server keeps the last snapshot of each live scope in
  `<dataDir>/cache/<scope>.json`. A board opened offline shows that, with the
  queued writes laid over it, so a note made offline shows at once. Notes and
  Briefing reads on the server fall back to the same view.
  - The header shows **offline · N changes waiting to sync** until everything
    is synced.
- **Status:** `ks-flow status` prints the store's reachability, this device's
  id, whether the store is set up for devices, and the outbox count.

The backup sweep still needs the store (and GCS), and the master's Briefing
needs Slack, so neither runs offline.

## Several devices

One board can span several Macs: each device runs its own daemon and board, all
on the same Firestore store, and every board shows every device's cards.
Nothing counts devices: three or five work the same way as two. PocketBase is
local, so a PocketBase board is one device.

### What a device is

- **Its id** is generated once, on the daemon's first start, and stored in
  `~/.config/ks/ks.env` as `KS_DEVICE_ID` (ks-config `ks.KS_DEVICE_ID`, one
  value for the whole machine). Every later start, the board, the CLIs and the
  one-off scripts read it back instead of generating it again.
- **Generated** as `HMAC-SHA256(key "ks-flow-device", the machine's hardware
  id)`, first 16 hex characters. The hardware id is the logic board's
  `IOPlatformUUID` on macOS (`/usr/sbin/ioreg`, called by absolute path because
  launchd's PATH has no `/usr/sbin`; `/etc/machine-id` on Linux). It is never
  logged, stored or sent: only the hash leaves the machine. A machine with no
  hardware id falls back to a hash of its host name, which is not stored, and
  the daemon logs a warning.
- **Kept** across OS updates, major upgrades, an erase-and-reinstall (the
  hardware gives the same id again) and a logic-board replacement (the stored
  id is kept; doctor warns that it no longer matches the hardware).
- **Never copy it to another Mac.** A config copied with Migration Assistant,
  synced dotfiles or a copy of `~/.config/ks` brings the first Mac's id along,
  and two Macs with one id overwrite each other's cards. The daemon's log and
  `ks-setup doctor` (`ks-flow:device-id`) warn when the stored id is not this
  Mac's own. On the copy: `ks-config unset ks.KS_DEVICE_ID`, then
  `ks-flow restart`.
- **`KS_DEVICE_ID`** in the environment (or the data dir's `.env`) overrides
  the stored id, for test daemons side by side. To keep an old id on new
  hardware, `ks-config set ks.KS_DEVICE_ID <id>` before the first start.
- The daemon also writes `<dataDir>/device.json` for the CLIs and the board:
  `{ deviceId, defaultName, label, name, deviceCount }` (`label`: its label
  below, or null; `name`: your name for it, or null; `deviceCount`: devices
  not forgotten). It is rewritten on the heartbeat whenever the label, the name
  or the count changes; a file from before 0.4.0 reads as `label: null,
  name: null, deviceCount: 1`. `ks-flow device-id --json` prints the id, where
  it came from and whether it matches the hardware; `ks-setup doctor` shows it
  (`ks-flow:device`).
- **A daemon that ran under a wrong id** (the 0.2.0 dev build under launchd):
  stop it, wait 3 minutes, then move that id's docs to this device and delete
  its record with
  `cd src && npx tsx ../scripts/one-off/retag-device.ts --from <wrong id> --dry-run`
  (then without `--dry-run`).
- **Its name** starts as the Mac's ComputerName (else the host name). Rename it
  in Settings → **Devices**; the new name shows everywhere at once.
- **Its label** is a short tag (`A`, `B`, … `A2`), shown before its name on
  every chip (`B · Mac mini`, `A · This device`), so Claude sessions can be
  named `<label>:<unit>` (`B:KAR-123`) and peers listed per device. A label is
  1–3 characters, `A`–`Z`/`0`–`9`, a letter first, unique among the devices not
  forgotten. The daemon gives its device one on the heartbeat when it has none:
  the lowest free of `A`..`Z`, then `A2`..`Z2`, `A3`…. When two devices hold one
  label (two new devices picking at once), the master device keeps it, else the
  smaller id, and the other picks again a minute later. A valid label nobody
  else holds is never changed by a daemon: set your own in Settings →
  **Devices** (uppercased as you type; a label another device holds is refused;
  empty = a free one is assigned). A forgotten device taken back onto a label
  someone else holds now gives it up and gets a free one. `ks-flow devices`
  lists them all.
- **Its running sessions** (`sessions`), for `ks-flow peers`: one entry per
  live `~/.claude/sessions/<pid>.json` (pid alive): the peer name, session id,
  Remote Control's id (`bridgeSessionId`: message it as `bridge:<id>`), pid,
  the card it works on (matched by folder, as the card's live sessions are)
  with the card's title, the folder's **name** (never the path), tmux pane,
  start time, Claude's own busy/idle and whether it waits on you. No prompt,
  no transcript. Its daemon checks every 15 s and writes them only when
  something changed. (`liveSessionNames`, the names-only list before it, is
  cleared.)
- **The local devices cache**, `<dataDir>/devices.json`: on each heartbeat's
  read of the devices the daemon writes
  `{ updatedAt, self, devices: [the rows of ks-flow devices --json] }`
  (write-then-rename; `updatedAt` is the last successful store read).
  `ks-flow devices` reads it (instant, works offline; `stale` is worked out
  against now) and says how old it is; `--live` reads the store instead, as
  does a missing cache.
- **Its record**, `devices/<id>`, is written by its own daemon every 60 s: name,
  platform, ks-flow version (`daemonVersion`: its `plugin.json` version), data
  format and dev build, last seen, the project path, its current worktrees,
  its Plannotator Inbox address, when it last read Linear, and, on the master
  device, the master's status (written when it changes, and at least every
  ~30 s while the master is alive, since its heartbeat moves), its label
  when it has none, and its live session names when they change. The board writes only its name, its label and `forgotten`
  (Settings → Devices; the route `/api/devices` answers 409 until the backfill
  has run).

### Each card belongs to one device

A ticket is worked in one session on one device. A card's `deviceId` is the
device whose daemon wrote it, and **a daemon never writes a card another device
owns**: there is no takeover. The skip is logged once per card.

Each device acts only on its own cards. On another device's card:

- **Remove**, **☁ backup** and the ribbon's **↻** are hidden.
- **Restore** is hidden on a live card, and allowed on a removed one from any
  device (it restores onto this device).
- **⧉ path** stays, with "path on <name>".
- The **NEEDS YOU** sash stays, but its Inbox links are off ("open the Inbox on
  <name>"): that Inbox runs on the other device's own `localhost`.
- Reminders, pause and the Linear / Slack / PR links stay: they only touch the
  store.

A card shows its device's chip (bottom-left of the footer) while the board has
two or more devices that aren't forgotten; the chip's colour comes from a
12-colour palette, picked by a hash of the id, so it is the same on every
board. Each daemon
reads Linear only for its own tickets, and backs up only its own cards.

**Moving a ticket between devices.** `ks-start-ticket` checks the card's owner
first (`ks-flow card-owner`):

- On another device that still has its worktree or a live session, it refuses:
  `KAR-123 is on <name>: remove it there first`.
- When the owner no longer works it (removed there, or the device forgotten),
  it moves the card: `moving KAR-123 from <A> to <B>` (`ks-flow card-move`).
  This is the only way a card changes device.
- With the store unreachable, or an older ks-flow, it goes on as before.

### Sleeping and stale devices

A device whose last heartbeat is over 5 minutes old is asleep or offline. Its
chip dims ("<name>: last seen 2 h ago"); its cards keep their place but lose the
active glow, show "sessions unknown" for the live-session count, and their
Linear status stays frozen until it wakes, since only the owner reads it.

**Forget** (Settings → Devices) is for a device that is gone: sold, replaced, or
given a new id. It is offered only on a stale device that is neither this one
nor the master; `/api/devices` itself refuses to forget this device, a device
seen in the last 5 minutes, or the master. **Take back** undoes Forget. It marks the device
`forgotten: true`; nothing is deleted. Its
cards stay tagged to it and are shown as removed cards (behind **show removed**,
in Done), with Restore and archiving like any removed card, never vanishing
silently. Its chip shows the name in grey, struck through. `ks-start-ticket` can then
move any of its tickets to the device you're on.

### One master

The master session runs on one device, chosen with the **Master** choice in
Settings → Devices (`meta/settings.masterDeviceId`). Only that device's daemon
runs the Briefing schedule and starts and supervises the master. A board on any
other device sends Brief me and Restart as a `masterRequests` doc that the
master device's daemon turns into a request file, and reads the master's status
from that device's record. The master chip says "on <name>".

- On a switch, the old device's daemon stops supervising within a minute and
  the new one starts the master. The old master session is **left running**
  (only its supervision stops); close it yourself (its tmux session
  `ks-master`) once the new one is up.
- While the master device is asleep or offline, Brief me is disabled ("master
  device <name> is offline"). After an hour, Settings asks you to pick another
  master device. The master never moves on its own.
- The master device needs `ks-master` installed, `tmux`, Ghostty or
  Terminal.app, and the Slack token.

Reminders and Briefing notices fire **on every device**: each keeps its own
"already notified" state (reminders in `<dataDir>/reminders-fired.json`,
Briefing notices in `<dataDir>/master/notices.json`). Stop-nudges and blocked-session notices come from the
session's own device.

### Upgrading to devices: the one-time backfill

A store from before devices holds `meta/project` and cards with no `deviceId`.
The backfill moves it to the devices model. Run it **once, on the device that
has been using the board, before ks-flow starts on any other device**.

1. Update the code on that device (a clone: `git pull`; installed: `claude
   plugin marketplace update karmasuite` and `claude plugin update`).
2. `ks-flow stop`: the daemon and the board. Don't open a Claude session in the
   checkout until step 5: its SessionStart would start the daemon again.
3. Dry run, which prints per collection how many docs it would tag and writes
   nothing:

   ```bash
   cd "$(ks-root ks-flow)/src"
   npm ci                                          # its dependencies, once
   npx tsx ../scripts/one-off/backfill-devices.ts --dry-run
   ```

   The script finds the configured data dir itself, as `ks-flow` does
   (`KS_FLOW_DATA`, else the configured project's); `--data-dir <dir>`
   overrides it. The command the daemon logs while the backfill is due (and
   the one `ks-setup doctor` prints) can be pasted as-is: it has the data dir
   filled in. Inside Claude's sandbox, use `node --import tsx` in place of
   `npx tsx`.
4. The same command without `--dry-run`. It:
   - creates `meta/settings` from this device's `board-settings.json` (Briefing,
     Notes, Reminders, GCS archive, transcript backup), with this device as the
     master. It refuses when `meta/settings` already exists; a run cut short
     finishes when re-run on the same device.
   - tags every `workUnits`, `sessions`, `backupRuns`, `backupUnits` and
     `masterEvents` doc that has no `deviceId` with this device (merges, 500 or
     fewer per batch, through the offline outbox);
   - copies `meta/project` into `devices/<this id>`, then deletes it.
5. `ks-flow start`: the daemon and the board **together** (`start` starts the board too), so a
   new board never talks to an old daemon or the other way round.
6. `ks-setup doctor`: `ks-flow:device` says the store is set up for devices.

Until the backfill has run, a new daemon keeps the one-device behaviour, writes
no device data, and logs that the backfill is due. Upgrade the existing device
first; add the others after.

### Adding a device

On the new device:

1. [Brand-new setup](#brand-new-setup) steps 1–4: tools, plugins, `/ks:setup`,
   and **its own tokens** (`! ks-config secret …`): the Keychain doesn't travel.
2. **Its own copy of the Firestore key file**, copied over by you (never
   through chat or git), then
   `! ks-setup store firestore --project ks-flow --credentials <key.json>`.
3. **Its own GCS credentials** in its `.env`, if cloud backup is on. The switch
   and the bucket are shared and already set.
4. **Check no device id came along**, if `~/.config/ks` was copied (Migration
   Assistant, synced dotfiles): `ks-config get ks.KS_DEVICE_ID` must print
   nothing before the first start. If it prints an id, `ks-config unset
   ks.KS_DEVICE_ID`. The daemon then generates this Mac's own on its first start.
5. `ks-flow start`, then `ks-flow open`. Within a minute the device appears in
   Settings → Devices on every board.
6. **Name it** in Settings → Devices.
7. **Remote Control in the project**, on every device: `/ks:setup` suggests it
   from the second device and, once you agree, runs `ks-setup remote-control --yes`. Claude sessions in the
   KarmaSuite checkout then start with Remote Control, so agents on different
   Macs see each other in `/peers` and can message each other.
7. **Master:** leave it where it is, or pick this device (it needs `ks-master`
   and the Slack token).
8. `ks-setup doctor` shows `this device: <name> (<id>); store set up for
   devices`.
9. **Shared memory**, if the other Macs use it: `ks-setup memory init <repo URL>`
   and `ks-setup memory link` (below).

### Shared memory

Claude Code keeps its auto memory per Mac (`~/.claude/projects/<path>/memory/`),
and its docs offer no remote or synced memory. Its `autoMemoryDirectory` setting
can move a project's memory anywhere, so with several Macs it can live in one
**private git repo**, cloned on every Mac at `~/git/claude-memory`, one folder
per project. Optional: off until `ks.KS_MEMORY_DIR` is set.

- **Set up** (`/ks:setup` suggests it from the second device): create an empty
  private repo once, then on each Mac `ks-setup memory init <repo URL>` (clones
  it, seeds an empty one, sets `ks.KS_MEMORY_DIR`) and `ks-setup memory link
  [<project folder>…]` (default: the KarmaSuite checkout).
- **Linking a project:**
  - Moves this Mac's memories into `<clone>/<project>/`, never overwriting the
    repo's, and merges `MEMORY.md`.
  - Keeps the old folder as `memory.linked-<date>`.
  - Sets `"autoMemoryDirectory": "~/git/claude-memory/<project>"` in the
    project's `.claude/settings.local.json`; `ks-setup` carries it into existing
    worktrees, and `create-worktree` copies it into new ones.
  - Writes the setting in the `~/` form, so it is the same on every Mac whatever
    the user name. `ks-setup memory status` lists what is and isn't linked.
- **Sync, by the daemon** (`src/lib/memory-sync.ts`). No periodic fetch:
  - **Push:** a watcher on the clone reacts only to a project's `MEMORY.md`, which
    every memory save or delete updates. Each change (re)starts a 2-min quiet
    window. Once it passes, the 15 s clock's `memory` job commits everything,
    pulls (rebase) and pushes, and publishes the new HEAD as
    `devices/{id}.memoryHead`. A burst of saves (a memory file, then the index,
    often several) is one commit.
  - **Pull:** another device's `memoryHead` that this clone lacks, seen by the
    devices listener the daemon already holds, makes the next tick pull.
  - **When it starts:** the daemon syncs once at start, for changes made while
    it was down.
  - **When it waits:** a memory edited without touching the index goes with the
    next index change, and a push from outside ks-flow arrives at the next sync.
- **Home paths:** every Mac reads the same files, and the home folder differs per
  Mac. Before each commit the sync rewrites `/Users/<name>/…` to `~/…` in the
  changed memories; `memory link` does it for the ones it moves in, and the KS
  rules ask agents to write `~/…` in the first place.
- **Conflicts:** memories are one fact per file, and `MEMORY.md` merges with
  git's union driver (`.gitattributes`), so index lines added on two Macs at
  once both stay. A real conflict (one memory changed on both Macs) aborts the
  rebase, and the sync retries every 2 min. It reaches the Errors page after the
  3rd failure: resolve it in the clone (`git pull --rebase`).
- **git runs through the login shell**, as the message board's commands do, so
  your SSH agent, Keychain or `gh` credentials work under launchd.
- **Sandbox:** `ks-setup claude-settings` adds the clone to
  `sandbox.filesystem.allowWrite`, so an agent can delete a stale memory there.
- **Cloud sessions** (claude.ai/code, routines) start on a fresh machine and
  keep nothing. To give them the memory, the environment's setup script can
  clone the repo and set `autoMemoryDirectory`; they don't push back unless it
  is set up to.

### Versioning

Devices may run different ks-flow versions for a while. `meta/settings` holds
two numbers, plus who raised them last and when (`versionBy`, `versionAt`):

- `schemaVersion`: the data format, an integer raised only by a change that
  older code would break (`SCHEMA_VERSION` in `src/lib/versioning.ts`; the
  devices model is 1).
- `version`: the release, ks-flow's `.claude-plugin/plugin.json` version
  (semver). Each device's `daemonVersion` is this too (bootstrap leaves it in
  `<dataDir>/daemon/build.json`), not the daemon's `package.json`.

**Raising.** Every daemon follows `meta/settings`. On start, a daemon running
newer code raises `version` (and `schemaVersion` if its code needs it) in a
transaction, only upward; nothing is raised before the device backfill. A
**dev build** never raises them: a clone that isn't on `main`, or has
uncommitted changes to tracked files (git in the plugin's folder). Its board
shows **dev build** next to the device chip, and Settings → Devices marks it.

**Behind on the data format** (the code's schema is older than the store's):

- The daemon drops every store write from this device, rather than queueing
  it in the outbox, where replaying old-format writes after the update would
  undo the new format. Writes queued before stay queued (not flushed) for the
  updated daemon. The backup and Briefing CLIs on the device drop theirs too:
  the gate is the local `<dataDir>/version-status.json`.
- It keeps reading local files, logging and sending local notices.
- The board goes read-only: a red banner, and every API route that writes to
  the store answers 409 with the reason. Local actions (Processes, Edit .env)
  still work.
- After the update, the daemon rebuilds its cards and sessions from local
  files, as on any start.

**Behind only on `version`:** it keeps working, with a banner.

**New release.** The store only says another device runs something newer, so
the daemon also looks for a new KS release itself: at most once an hour it runs
ks's `ks-setup update --check` (again right after an update, ten minutes later
when another update is running, never from a dev build or while an update
runs). The answer is kept in `<dataDir>/release-check.json` and shown as
`release` in `version-status.json`; when it says a newer ks, ks-flow,
ks-master, ks-browser or ks-suite is out, the daemon starts the same update.
It also checks at once when an installed version changed since its last check
(a `ks-setup update` run by hand).

**Release announcements** (`src/lib/release-announce.ts`). A push reaches the
other devices in a minute or two instead of at their hourly check:
`meta/settings.releases` holds each KS plugin's newest pushed version. A daemon
running from a clone that is on `main`, clean and level with its upstream
(pushed) raises it once a minute from the clone's `.claude-plugin/marketplace.json`,
only upward, in a transaction; anything unpushed is never announced. Every
daemon watches `meta/settings` (onSnapshot): when it names a plugin newer than
the one installed here, the daemon runs its release check at once, and an
available release starts the update (a new target is not held by the hourly
limit).

**Auto-update, always on** (no setting). A device behind on either, or with a
new release, starts `ks-flow update` as a detached process (its own session,
so the daemon restart can't kill it), output in
`<dataDir>/update.log`, the outcome in `<dataDir>/update-state.json`. Each
update records its target (the store's version, or the new release): a target
it already tried is retried at most once an hour, so a release that can't be
fetched yet doesn't loop, while a newer target (e.g. a release out minutes
after the last update) starts at once. The banner says "updating" only while an
update runs; otherwise it says how to start one. A dev
build never updates itself. `ks-flow update` (also by hand; `--dry-run` prints
the plan):

1. **New code**, fetched by ks's `ks-setup update` (see the ks scripts README):
   installed, it updates every KS plugin in the KarmaSuite checkout and each of
   its worktrees; a clone, `git pull --ff-only`, only on `main` with no
   uncommitted changes; otherwise it refuses and says why (a safety check, not a
   setting). An older ks without `ks-setup update` gets the old steps
   (`claude plugin update` for ks-flow and ks in the checkout). Another update
   already running is **busy**: nothing is done, the state says `busy` (not a
   failure), and the daemon tries again ten minutes later.
2. **Rebuild:** the new folder's `scripts/bootstrap.sh`, with the launchd job's
   settings carried over.
3. **Restart:** `launchctl kickstart -k` the daemon, then the board if it was
   running (no new browser tab).

`ks-flow update --no-fetch` is steps 2 and 3 only: what `ks-setup update` runs
once it has fetched a new ks-flow (the two never call each other back).

**Notices**, as soon as a device is behind, a new release is out or an update
fails:

- a macOS notification, once per state: "ks-flow on <name> is behind (1.4.2 →
  1.5.0): updating", "a new KS release on <name> (ks 1.1.0, ks-flow 0.3.0):
  updating", or "…: run `ks-flow update` (<reason>)";
- a banner on every board naming each device behind (its `daemonVersion`
  against `meta/settings.version`, and whether it is a dev build), red on the
  device's own board while it is read-only;
- one line from the ks-flow SessionStart hook on that device;
- `ks-setup doctor`'s `ks-flow:version` check (an error when behind on the data
  format, a warning when behind on the release or after a failed update) and
  its `ks-flow:release` line (the last release check).

Settings → Devices shows each device's version, amber when it is behind.

## CLI (`bin/ks-flow`, on PATH while enabled)

| Command | Purpose |
|---------|---------|
| `ks-flow start` | Start the daemon (+ PocketBase); builds/installs on first run. |
| `ks-flow open` | Build and open the board UI in the browser. |
| `ks-flow close` | Stop the board UI server. |
| `ks-flow stop` | Stop everything — board UI, daemon, and PocketBase. |
| `ks-flow restart` | `stop`, then `start`: the daemon and the board come back and re-read their config. Run it after a `ks-config` change (the daemon reads config once, at start; `start` alone keeps a running daemon). |
| `ks-flow update [--dry-run] [--no-fetch]` | Update this device's ks-flow to the newest release (the fetch is ks's `ks-setup update`: every KS plugin, in the KarmaSuite checkout and its worktrees; a clone: `git pull --ff-only` on a clean `main` only), rebuild, restart the daemon and the board. `--no-fetch`: rebuild and restart only. The daemon runs it on its own when the store holds a newer version or its hourly check finds a new release. See [Versioning](#versioning). |
| `ks-flow status` | Status of all services: daemon, store (PocketBase, or Firestore with its offline outbox count), board UI. |
| `ks-flow migrate-store` | One-off copy of the PocketBase store into Firestore. Dry run unless `--write`; `--project`, `--credentials`, `--force`. |
| `ks-flow daemon` | Run the ingester in the foreground (debug). |
| `ks-flow set-project <path>` | Re-point the tracked project (rewrites `project.conf`, re-backfills). |
| `ks-flow backup [target] [options]` | **The one uploader.** Targets: nothing = every live worktree; `--unit <id>`; `--worktree <path> [--identifier <id>]` (one worktree, live or about to be deleted); `--completed` (units whose worktree is gone). Options: `--since-hours <n>`, `--force`, `--dry-run`, `--json`, `--reindex` (upload nothing; rebuild the store's backup index from the bucket), `--runs` (upload nothing; print the run history), `--trigger <daily\|manual\|unit\|removal\|completed>` (recorded with the run; inferred from the target when left out). |
| `ks-flow session [<unit>] [--json]` | The Claude Code process live in a unit's worktree, as the daemon recorded it: `{ unitId, worktreeDir, workflowDir, activeSession, liveSessions, deviceId, device, local }`. A card on another device prints `on <name>` (`--json`: the record with `local: false`) and exits 1, since its pid and tmux pane are that device's. Exit 1 for an unknown unit or one with no live session; exit 2 when the store is unreachable or the running daemon predates live-session tracking. No unit lists every unit with a live session. The record can be up to one tick (15s) old, so check the pid before signalling it. |
| `ks-flow device-id [--json]` | This device's id on the shared board (`KS_DEVICE_ID`, else the stored `ks.KS_DEVICE_ID`, else the daemon's `device.json`, else generated). `--json`: `{ deviceId, defaultName, source, hardwareMatches }`. See [Several devices](#several-devices). |
| `ks-flow devices [--json] [--live]` | Every device on the board: this device first (marked `*`), then by label. Read from the daemon's cache `<dataDir>/devices.json` (instant, offline; a line says how old it is), from the store with `--live` or when the cache is missing. Plain: a table of label, name, id, last seen and flags (`this device`, `master`, `stale`, `forgotten`). `--json`: `{ source: cache\|store, updatedAt, self: <deviceId>, devices: [{ label, name, deviceId, lastSeenAt, self, master, forgotten, stale, sessions }] }` (`name`: yours, else its default name; `stale`: not seen for 5 min, against now; `updatedAt`: the cache's last store read, or now). Exit 2 when the store can't answer (10 s). See [Several devices](#several-devices). |
| `ks-flow peers [--md\|--json]` | Every running Claude session on every device (each device's `sessions`), grouped by device, this one first: device (`A · name`), peer name (`(you)` = the asking session, by `$CLAUDE_PID`), ticket, the card's title, state (`working`, `idle`, `waiting on you`, or `last seen …` for a device quiet for 5 min), address (`bridge:<Remote Control id>`; on this device the name works too; none = not reachable), tmux pane, started. A device with no session still gets a row. Reads the store; the daemon's cache when the store can't answer (10 s; a line says how old). `--md`: a Markdown table (what agents show; the KS rules' "Peers"); `--json`: `{ source, updatedAt, self, rows: [{ device, session, state, address, you }] }`. |
| `ks-flow card-owner <unit> [--json]` | Which device a card is on: owner id and name, whether it is this one, whether the owner still has its worktree or a live session, and what `ks-start-ticket` would do (`none`, `refuse`, `move`). Exit 2 when the store can't answer. |
| `ks-flow card-move <unit> [--json]` | Move a card to this device, only once its owner no longer has its worktree or a live session; else refuse (exit 1). The only way a card changes device; `ks-start-ticket` runs it. |
| `ks-flow backup-enabled` | Exit 0 when cloud (GCS) backup is switched on in Settings, else 1. Checked by `remove_worktree` and `ks-start-ticket`. |
| `ks-flow restore --unit <id> [--overwrite] [--workflow] [--workflow-only] [--workflow-dir <path>] [--overwrite-time-log] [--dry-run] [--json]` | Restore a unit's backed-up transcripts into `~/.claude/projects/<encoded>`, and merge its time log. Local files win unless `--overwrite`. Reads per-file objects, falling back to a legacy `transcript.tar.zst`. `--workflow` also unpacks the workflow folder; `--workflow-only` unpacks just that (no sessions, no time log); `--workflow-dir` says where it goes instead of working it out; `--overwrite-time-log` replaces the local time log instead of merging. |
| `ks-flow briefing <context\|find\|add\|evidence\|run\|daily> …` | The master session's read/write path for the [Briefing](#briefing-briefing): read what's known, look up items by thread, add or update items, attach evidence, record runs, write the daily log. It has no archive or delete: only the board archives. See `docs/briefing.md` ("CLI"). |
| `ks-flow archive <worktree> [id]` | Familiar alias — forwards to `backup --worktree … --force`. |
| `ks-flow backfill-archive [--dry-run] [--force]` | Familiar alias — forwards to `backup --completed`. |
| `ks-flow migrate-archives [--dry-run] [--unit <id>] [--backup-prefix <p>] [--delete-legacy] [--force]` | Convert legacy `transcript.tar.zst` archives to the per-file layout, after server-side copying every affected object to a safety prefix. |

## Board UI

`ks-flow open` builds and serves the Next.js board (dark theme). Every page shares one header: ks-flow with the board's version (the ks-flow it was built from; amber when the daemon runs another, until `ks-flow open` rebuilds it) and the project, tabs **Board · Briefing · Daily log · Notes · Activity Log** (Notes only when enabled), and on the right the **bell** (Briefing items hot or overdue, red when above zero), the **Inbox** button (opens the Plannotator Inbox; badge = open questions plus new messages), the **master** chip (live, busy, no heartbeat, starting, down, not started; "on <name>" when the master runs on another device, "device offline" once that device is stale), a **this device: <name>** chip, and links to Processes and Settings. The **Processes** page lists this Mac's ks-flow daemon(s), board and PocketBase with what each runs: ks-flow's version (the daemon's own, the board's build), Next.js, Node and PocketBase. Header actions (back up all, kill, Processes) act on this device only, and their tooltips say so. A page's own controls sit in a row under it.

**This Mac only.** The board has no login, and its actions run commands, kill processes and remove worktrees, so it answers only this Mac's own pages, in three layers:

1. It listens on `127.0.0.1` only (`next start -H 127.0.0.1`), so other machines can't connect. You can't open it from a phone or another laptop: every device runs its own board on the same store.
2. `web/proxy.ts` (Next.js 16's name for middleware; logic in `web/lib/localguard.ts`) refuses with 403 any request whose `Host` isn't `localhost`, `127.0.0.1` or `[::1]`. That stops a web page whose domain was re-pointed at `127.0.0.1` (DNS rebinding) from reading the board.
3. The same check refuses every write, and every `/api/` call, whose `Origin` isn't the board itself (another site, or another `localhost` port), and a write a browser marks cross-site. That stops other pages in your browser from pressing the board's buttons (CSRF).

Requests without those browser headers (`curl`, the ks-flow CLIs) pass, since code already running on this Mac has your access anyway. To check: `lsof -nP -iTCP:4317 -sTCP:LISTEN` shows `127.0.0.1:4317`, and `curl -H 'Host: evil.example' http://127.0.0.1:4317/` returns 403.

The Board's controls:

- **swimlanes** *(on by default)* — split cards into `ticket` / `project` lanes. Each lane shows only that type's phases (the ticket lane is the shorter init + context/research + plan/implement set), and a lane with no cards is hidden.
- **show removed** *(off by default)* — also show, in the [Done column](#done-column), finished work whose git worktree is already gone (dimmed, Restore only).
- **live / connecting…** — realtime subscription status.
- **↻ refresh** — manual re-pull of the project, work-units, and sessions from
  the store (the live subscription still pushes on its own; this is an on-demand
  pull, reused by UI actions such as worktree removal).
- **📝 notes** — the [Notes](#notes-notes) page (saved notes & reminders). Only shown when Notes is enabled in Settings.
- **▤ processes** — the running-processes page (below).
- **⚙ settings** — the settings page (below).
- **kill** — two-step kill switch that stops the daemon + PocketBase. They
  restart and re-backfill on the next Claude session, so it's reversible.

Only cards whose worktree is a **current** git worktree on the card's own device
are shown on the board (stale records linger in the store but are filtered out);
finished ones sit in the last column, **Done** (see [Done column](#done-column)).
The columns are derived on the board from every card's phases, so they don't
depend on which device wrote last. With [several devices](#several-devices),
each card carries its device's chip, and another device's card is read-only for
its machine actions.

The board also scrolls **horizontally only within each lane's column row** —
the header stays fixed to the viewport.

### Cards

Each card carries quick links + live state:

- **Linear ↗ / Slack ↗ / PR** — open the ticket/project in Linear (entity `url`),
  the source Slack thread (`slack.project_thread`), and the GitHub PR (latest
  entry in the top-level `prs[]` array, written at PR creation; legacy
  `slack.pr_review_threads[]` is a read fallback). Each shown only when present.
- **⧉ path** — copy the card's worktree directory to the clipboard.
- **priority / estimate / waiting** badges; a `⏳ waiting` badge (amber ring) when
  a session is blocked on you (`⏳ waiting: Inbox` when it asked in the Plannotator Inbox).
- **NEEDS YOU** — a diagonal sash across the card's top-right corner when an Inbox
  question, action item or unsent answer waits on you; red when the agent has
  stopped until you answer. Clicking it opens the thread. Below the links, one row
  per Inbox thread: `⛔ Stopped on you · 2 open questions · holds up: next commit
  on #6848`, the thread's subject, and `Inbox ↗`. A thread with only new agent
  messages shows a quiet `✉ 1 new message` row, without the sash. See **Plannotator Inbox**.
- **Glowing animated border** when a session is **active** — a session counts as
  active if it wrote within the last **5 minutes** (recency, evaluated client-side
  against a shared ticking clock, so it self-expires — not the daemon's snapshot).
- **`⟳ active <when>`** — when the session was last active (`lastActivity`, the
  last timestamped JSONL line); absolute time on hover.
- **`☁ backup`** — back up this unit now (transcript + workflow). Turns indigo
  with a count (`☁ backup 3`) when session files on disk are new or have grown
  since their last upload.
- **`⤓ restore N`** — appears **automatically** whenever the bucket holds session
  files this machine no longer has, which is the pruned-at-30-days case the
  backup exists for. Restoring only fills in what is missing; a local transcript
  is never overwritten. Each streams into its own bottom-right log panel.

The full parsed `state.yaml` is replicated onto each work-unit (a `state` field),
so any field can be surfaced on the board without new daemon plumbing.

### Settings (`/settings`)

Most settings are **shared by every device** on the board: Briefing, Notes,
Reminders, the GCS archive (enable flag, bucket, prefix) and the transcript
backup live in the store's `meta/settings`. Each device keeps a local copy in
its `board-settings.json` (what the hooks and CLIs read; the daemon keeps it
in step). The tracked project and the worktree removal command stay local to
the device.

- **Devices** — every device on the board: its chip, an editable name (empty =
  its default name), its short id, "this device", last seen, platform, ks-flow
  version (amber when behind the store's; **dev build** marked, see
  [Versioning](#versioning)) and worktree count; a **Master** choice (where the master session runs), with
  a warning when the master device has been stale over an hour; **Forget** /
  **Take back** for a device that is gone. Before the backfill it shows the
  backfill command instead. See [Several devices](#several-devices).
- **Tracked project** — re-point the board at another repo. The path is
  validated as a git repo; the daemon re-points and re-backfills on save.
- **Worktree removal command** — the command a card's **Remove** runs (see
  [Removing a worktree](#removing-a-worktree)). Local to this device, stored in
  `board-settings.json` (separate from `project.conf`, so bootstrap never
  clobbers it).
- **Archive to Google Cloud Storage** — opt-in (off by default). When enabled,
  Remove first archives the worktree before deleting it (see below). Toggling it
  on runs a **package preflight** (`/api/archive-preflight`) and, if `zstd` (or
  `tar`) is missing, shows a banner with the install command (`brew install
  zstd`). The enable flag, bucket, and optional object prefix are shared
  (`meta/settings`); **credentials never are**: each device keeps its own in
  its `.env` (see env below).
- **Notes** — opt-in (off by default). Master **Enable Notes** toggle plus
  per-source toggles (**Slack** needs `SLACK_TOKEN`, **Linear** needs
  `LINEAR_API_KEY` in `.env` — both shown live as detected / missing). See
  [Notes](#notes-notes).
- **Edit .env** — an **Edit .env** button in the settings **header** (the `.env`
  is shared by Notes, GCS archive, Firestore, … so it isn't tucked under one
  panel) opens `$CLAUDE_PLUGIN_DATA/.env` in your default text editor (`open -t`,
  macOS).
  The file is **never read by the board and never sent over HTTP** — the server
  only hands the path to the editor (it's `chmod 600`, created with a comment
  template if absent). Restart the daemon afterward (board **kill** button →
  restarts next session) for daemon-side consumers to pick up changes; note that
  a shell/launchd-exported value **overrides** the same key in `.env`.

### Processes (`/processes`)

Lists the ks-flow processes running on the machine — **process name, PID, start
time, and listening port** — so a stray/duplicate instance is visible at a
glance (e.g. an old manually-started `node dist/daemon.js` left running alongside
the launchd-managed one, which makes every notification fire twice). Built from
`ps` joined to `lsof` (pid → listening TCP port); classifies the **daemon**,
**PocketBase** (8090), and the **board** (4317). The daemon row shows no port —
it's a file-watcher/ingester and opens no socket. If more than one **ks-flow
daemon** appears, a warning banner shows: the newest is badged **kept** and the
older one(s) get a **Kill** button (a stray manual daemon is invariably the
older PID). `POST /api/processes` re-validates the pid against a live `ps` scan
and refuses to kill anything that isn't a running ks-flow daemon, so it can't
terminate an arbitrary process. (The launchd-managed daemon respawns if killed,
so the kill only sticks for the stray one.)

### Message board: commands (`/commands`)

One device (the master, an agent, you) can ask another device's ks-flow daemon
to do something on that Mac:

```
ks-flow device-run <device> <command> [<arg>] [--from <who>] [--note <why>] [--wait [<s>]] [--json]
ks-flow commands [--limit <n>] [--json]
```

`<device>` is its label (`A`, `B`), its name, its id, or `self`.

**Commands** (`src/lib/device-commands.ts`), a fixed list that is never a shell
command:

| Command | What it does on that Mac |
|---|---|
| `ping` | answers with its ks-flow version |
| `start-ticket <KAR-123\|URL>` | `ks-start-ticket --no-launch` in the checkout, then `claude-ks-start` in the worktree it printed, with the project-manager prompt it printed |
| `new-session <dir>` | `claude-ks-start <dir>`, with no first message. `<dir>` must be the checkout or one of its live worktrees |
| `restart-session <KAR-123>` | `claude-ks-restart <KAR-123>` |
| `backup [<unit>]` | the backup sweep now, as "Back up now" (one unit with an argument) |

**How a command runs:**
- **Posting:** `device-run` writes `deviceCommands/{uid}` with `to`, `from`
  (device and who), the command, its arguments and a note, as `queued`.
- **Taking it:** each daemon follows its own commands (`to == self`) with one
  listener. It checks each queued command, then takes it in a transaction
  (`queued` → `running`), so the command runs once.
- **Running it:** through the login shell, so the user's PATH, tmux and the KS
  commands are there, with arguments passed as argv.
- **The outcome** is written back onto the same doc: `ok` or `failed`, a
  one-line message, the exit code and the end of the output (at most 8000
  characters).

**Other endings:**
- `refused`: an unknown command, a bad argument, or a folder outside the
  checkout.
- `expired`: still queued after 15 minutes.
- `failed` ("interrupted"): the daemon restarted while it ran.

**Waiting and cleanup:**
- `--wait` follows the doc until the command ends (default 180 s). Exit codes:
  0 ok; 1 failed, refused or expired; 3 still running when the wait ends.
- The device that ran a command deletes it after 30 days.

**Commands carry no free text.** Anyone who holds the Firestore service-account
key can write the store, and so can post commands. So a command can never give
a Claude session its first message: a new session starts with the
project-manager prompt that `ks-start-ticket` derives, or with none. Any other
argument refuses the command. Keep the key file out of shared folders and
backups.

**The Commands page** lists the newest 200 commands live, from the board's
stream (the `activity` scope):
- when it was asked
- who asked, and from which device
- which device runs it
- the command and its argument
- its status and how long it took
- the outcome; a click shows the note and the output

The master uses commands to start tickets on another Mac
(`plugins/ks-master/instructions.md`). The KS rules tell every agent to use them
instead of asking a peer session to do such errands.

### An update reloads open tabs

`/api/version` returns the board's build id (`.next/BUILD_ID`) with the
versions. Every tab already polls it every 30 s, and also when the tab comes
back into view. A tab that sees a different build id than the one it loaded
with (an update rebuilt and restarted the board) reloads itself, so no tab is
left showing the old board. While a text field has the focus it waits for the
next poll, so nothing being typed is lost.

### Errors (`/errors`)

This device's ks-flow problems, from the daemon's `errors.json` (see [No timed
reads](#store-firestore-cloud)). **Open** problems come first: what failed
(a store listener or a daemon job), the last error, the number of failures since
when, and when the daemon tries again. Below them are the ones **resolved** in
the last 7 days. The header's ⚠ links here and turns red, with the count, while
any problem is open.

### Activity Log (`/activity`)

One history of everything ks-flow and the master session do in the background,
newest first, from every device: with two or more devices, a **Device** column
names where each Backup and Master row ran (also in the title row of their
dialogs). Each row has a type chip; filter chips narrow it (All · Backup ·
Briefing · Log-in/off · Master, with counts; `?type=backup|briefing|log|master`
in the URL). Click a row for its details. It replaces the old Backups page:
`/backups` redirects to `/activity?type=backup`.

| Type | Source | Row shows |
|---|---|---|
| **Backup** | `backup_runs` via `GET /api/backup-runs` (running / interrupted is checked on the server) | trigger (Daily, Back up now, Card backup, Worktree removal, Completed units), status, scope, files and units uploaded, uncompressed → compressed bytes, errors; *See logs* for a run this board started. The dialog lists every upload ([Run history](#transcript-backup--end-of-day)). |
| **Briefing** | `briefing_runs`, trigger `schedule` / `button` / `manual` | Scheduled 06:00 (the slot) / Brief me / Manual, status, items added and updated, where Slack was read up to, the master's summary or the error, duration |
| **Log-in / Log-off** | `briefing_runs`, trigger `log-in` / `log-off` | the same, plus a link to that day's `/daily?date=…` |
| **Master** | `master_events` | the daemon starting the master or hard-restarting it (why, and how the command exited), and each request sent to it — the daemon's schedule requests, the board's Brief me now / Restart master — written or *dropped* (one of that kind was already waiting) |

Briefing runs and master events are live through the shared store
subscription; backup rows re-read when `backup_runs` changes and every 30 s
(a run whose process died turns *interrupted* without a write). A briefing
run with no end two hours on shows as *interrupted*; a start/restart whose
exit the daemon never saw (it restarted meanwhile) shows *No result* after 15
min — `<dataDir>/master/launch.log` has its output.

### GCS archive on removal

Opt-in archival of a project's conversation for later analysis. Enable it in
Settings **and** provide a dedicated GCS service-account via
`$CLAUDE_PLUGIN_DATA/.env` (independent of any Firestore creds). The switch and
the bucket are shared by every device; the credentials are not, so **each
device needs its own** in its own `.env`:

```
GCS_BUCKET=my-ks-flow-archives          # or set the bucket in Settings
GCS_CREDENTIALS=/path/to/sa.json        # OR the client-email/private-key pair:
GCS_CLIENT_EMAIL=svc@project.iam.gserviceaccount.com
GCS_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n"
GCS_PROJECT_ID=my-gcp-project           # optional (falls back to the SA's)
```

When enabled, removing a worktree archives it first, then runs your
remove command. It goes through the same uploader as everything else (see
**Transcript backup** below), so it writes:

- one object per session file ← `~/.claude/projects/<encoded-worktree>/` (all
  session JSONL + `subagents/*.jsonl`), under `<identifier>/transcript/`.
- `workflow.tar.zst` ← that unit's own `workflow/<user>/<slug|tickets/id>/`
  folder (`state.yaml` + `resources/`).

Session files are compressed individually with `zstd -19` (~5x on JSONL);
the workflow folder is `tar -cf - … | zstd -19 -T0`. Read one back with
`zstd -dc <file>.jsonl.zst` or, for the workflow,
`zstd -dc workflow.tar.zst | tar -xf -`.

**Abort-on-failure:** if archiving is enabled but fails (missing `zstd`, bad
creds/bucket, network), the removal is **aborted** — the worktree is never
deleted un-archived. Fix the config (or disable archiving) and retry.

**Completed work:** `ks-flow backfill-archive` (alias for `backup --completed`)
covers units whose worktree has already been removed — their state.yaml is in the
main checkout's `workflow/` tree and their transcript dir survives under
`~/.claude/projects/` after `git worktree remove`. Re-runnable and incremental:
the backup index means it uploads only what is missing, `--force` re-uploads
everything, `--dry-run` previews.

### Transcript backup · end of day

Claude Code prunes `~/.claude/projects/**/*.jsonl` at **30 days**. A session you
park and come back to a month later has therefore lost its transcript, and
`--resume` finds nothing. The GCS archive above only fires on **Remove**, i.e.
only for work you were already finished with — the opposite case. This sweep
covers it.

Once a day (default **23:45** local) the daemon backs up every session transcript
that changed in the last 24h, for every unit reachable through a **live git
worktree** of the tracked project on this device. Each device sweeps only its
own cards, on its own schedule. It runs as a child process, and catches up on
wake or after a restart if a day was missed, so a Mac asleep through the window
does not silently skip a day.

**Run history (board → Activity Log, Backup rows).** Every real sweep — the daily one, the
board's buttons, a worktree removal, a run by hand — is one record in the store
(PocketBase `backup_runs`, or Firestore `backupRuns`): when it
started, what started it, its outcome, how many units it checked and how many
were already current (nothing to upload, no errors), and per unit every object
it uploaded — each with its uncompressed and uploaded (zstd) size, totalled per
run — and every error. It is written as the run starts and completed as
it ends, so a run that died mid-way still shows, as *interrupted*. The
[Activity Log](#activity-log-activity) lists the runs as **Backup** rows;
clicking one opens what it uploaded. The daemon's once-a-day
check reads the newest finished run **of this device** to decide whether
today's sweep has happened, so one device's sweep never stands in for
another's. Each run and each unit's index entry carries its `deviceId`. Status, reindex and dry runs upload nothing and are not recorded.

**The store is required.** The backup index (below) lives in the store too, so a
sweep refuses to run when PocketBase is down rather than re-uploading every
unit it can no longer see as backed up. PocketBase runs with the daemon. The one
exception is a `--force` run (a worktree removal): it ignores the index anyway,
and failing it would block the worktree's deletion; it goes ahead unrecorded.

**One object per session file, not a tarball:**

```
gs://<bucket>/<prefix>/<identifier>/transcript/<sessionId>.jsonl.zst
gs://<bucket>/<prefix>/<identifier>/transcript/subagents/<id>.jsonl.zst
gs://<bucket>/<prefix>/<identifier>/workflow.tar.zst
gs://<bucket>/<prefix>/<identifier>/time-log.jsonl.zst
```

`time-log.jsonl.zst` is the unit's time log: the ks plugin's
`~/.claude/ks-time/<identifier>.jsonl`, the events its `time-log.sh` hook
records, which `ks-time` turns into time spent (see the ks scripts README). It
goes up whenever it changed, on its own: every turn grows it, and it does not
wait for a session file to trigger the unit.

Two copies of one log are **merged, never replaced** (`src/lib/time-log-merge.ts`:
every line once, ordered by `ts`). The sweep uploads the union of the local log
and the bucket's copy, so a fresh local log — a short session on a new machine,
before any restore — cannot overwrite the full history in the bucket. A restore
writes the cloud copy when there is no local log, and otherwise appends the
cloud events the local one lacks (appends, so an event the hook writes at that
moment is not lost). Because every backup uploads the union, the cloud copy
already holds each backed-up local event, so replacing the local log could only
drop events logged since the last backup — the Restore dialog therefore offers no
choice. `--overwrite-time-log` on the CLI remains as an escape hatch for a
corrupted local log.

This layout is the whole point, not an implementation detail. Re-tarring the
transcript *directory* would eventually destroy the thing being protected: once
local pruning has removed an old session, the new tarball is built from a tree
that has **lost** that file and overwrites a good cloud copy with a lesser one —
silently, and precisely for the long-lived units worth keeping. Per-file objects
make that impossible (pruning locally never deletes from the bucket) and make the
sweep incremental: only the file that grew is compressed and uploaded, so nothing
is downloaded or rewritten. Compression is `zstd -19` (~5x on JSONL; measured
391,483 B → 76,921 B on a real session, restored byte-identical).

A unit is keyed by the **identifier out of its own `state.yaml`** — the one whose
`worktree_dir` points back at that worktree. `workflow/` is gitignored, but
`create-worktree` copies the main checkout's into each new worktree, so every
worktree carries every unit's `state.yaml`; taking the first one found made five
unrelated worktrees share one object prefix. Ticket units live at
`workflow/<user>/tickets/<id>/`, project units at `workflow/<user>/<slug>/`, so
the tree is walked rather than globbed at a fixed depth. Keying this way matches
the removal path, so both write under the same per-unit prefix.

**The trigger and the action are different, deliberately.** The trigger is a
session file that differs from the backup index — a lone `state.yaml` touch does
nothing, since `state.yaml` changes are made from inside a session, whose file
changes with them. That matters, because `workflow/` is gitignored: the
`workflow.tar.zst` refreshed then is its only copy off this machine. The
action is to back up **the whole worktree**: every session file not already in
the bucket, plus a refreshed `workflow.tar.zst`.

Scoping the *action* to the change window loses data, and did during development:
`KAR-12770` had 17 local sessions and exactly **one** in the bucket. The other 16
were older than the window, so they were skipped — and a finished session never
changes again, so they would never have been uploaded at all. They would simply
have reached 30 days and been pruned. `--since-hours` therefore narrows only the
trigger (a cheap "did anything happen lately" filter); it never limits which
files go up. The default is no window: visit every unit, upload whatever is
missing.

Transcript and workflow always travel together, so a restore hands back a
conversation and the workflow state that went with it.

**One uploader, several ways to choose targets.** `sweep()` is the only thing
that writes to the bucket; the daily run, both manual buttons, the worktree
removal hook, and the completed-work backfill all differ only in which targets
they hand it. The removal hook used to write a whole-directory
`transcript.tar.zst` through a second code path — which the board's Restore could
not read, leaving 35 archived units unrestorable — and the backfill wrote a third
variant. Both are gone; `ks-flow archive` and `ks-flow backfill-archive` remain
as aliases. Legacy tarballs already in the bucket stay usable: restore falls back
to unpacking one when a unit has no per-file objects.

**Restore.** The board shows local transcripts first. When the bucket holds
sessions this machine no longer does, the card grows an amber `⤓ restore N`
badge; clicking it fills in **only the missing** sessions — a transcript on disk
may be the live one Claude Code is appending to, so local always wins unless you
pass `--overwrite` on the CLI. Restore returns the **conversation, not the
worktree**: if the worktree is gone, the encoded transcript path matches no live
directory and `--resume` will not list the session until that worktree exists
again.

Clicking the badge opens a confirmation dialog with one opt-in:

- **Also restore the workflow folder** (`--workflow`) — unpacks `workflow.tar.zst`
  into the unit's folder under the live worktree's `workflow/`, or the main
  checkout's when the worktree is gone. The folder's path comes from a
  `state.yaml` already naming the unit, else from the archived `state.yaml`'s
  type and the only `workflow/<user>/` folder there. Missing files only; files
  on disk are kept unless `--overwrite`. Some removal-time archives hold the
  worktree's **whole** `workflow/` tree (the hook fell back to it for units whose
  `state.yaml` had no `worktree_dir`; it now finds the unit's folder by
  identifier, else the main checkout's copy, else archives no workflow). Restore
  takes just the unit's own folder out of such an archive and puts it back at
  the same path.

The time log is always merged (see above).

Outside the board, the same switch drives two terminal tools in the ks plugin:
`ks-flow backup-enabled` exits 0 when `gcsArchive.enabled` is on, and then
`remove_worktree` backs a worktree up before removing it (skipped when the
board's Remove already did — it sets `KS_FLOW_BACKED_UP=1`), and `ks-start-ticket`
offers to restore a reopened ticket's missing sessions and workflow files: the
workflow folder before it writes `state.yaml` (`--workflow-only --workflow-dir`),
so the backed-up one is refreshed rather than shadowed, and the sessions and time
log once the worktree exists (one `Restore?` answer covers both).

Restored files keep their original mtime (from the object's source stamp, or
the tarball), so the next sweep sees them as already backed up rather than
re-uploading them. Old-format units (`transcript.tar.zst` only) get the same
time-log and workflow handling as per-file ones.

Done tickets are the ones old enough to have been pruned. Their cards in the
**Done** column carry the same `☁ backup` / `⤓ restore N` pair, and a Done card
whose worktree is gone (behind **show removed**) carries the restore alone — the
sweep only backs up live worktrees. The restore CLI resolves where a
unit's transcripts belong exactly as the status does (live worktree, then the
completed-unit record, then the location stamped on its objects, then the backup
index), so a badge the board shows is one the restore can act on.

**Manual triggers.** The header `☁` backs up everything changed in the last 24h
without waiting for the schedule (useful before shutting down, or before leaving
a session for a month). Each card's `☁` backs up that one unit.

Both stream their output into a bottom-right log panel, as the worktree Remove
action does — a backup spends real time in zstd and in the upload, and a button
with no feedback is indistinguishable from a broken one (a no-op click looked
exactly like a failure during development).

**Action streams** (`web/components/StreamPanel.tsx`). Every long-running action
is a *stream* under a key it chooses — `backup:all`, `backup:<id>`,
`restore:<id>`, `remove:<id>` (`web/lib/backupStreams.ts` holds the backup
ones) — with its own panel, stacked bottom-right, so two actions at once each
keep their own output and outcome. The provider sits in the root layout
(`web/app/providers.tsx`), so a stream outlives a page change: start a backup on
the board, open the Activity Log, and it is still streaming there. A panel's ✕ only
hides it; `<SeeLogs streamKey=…>`, rendered beside the button that started the
action, brings it back (pulsing while it runs). *clear* forgets a finished
stream. Each button is disabled by its own stream (`useStreams().anyRunning`),
not by one board-wide flag. A backup stream also answers to its run's id — the
CLI prints `run <uid> started` — so the Activity Log's Backup row for that run shows
See logs too. Routes emit the `{ type: 'stdout' | 'stderr' | 'exit' }` line
protocol via `web/lib/streamproc.ts`.

**Settings** (`board-settings.json`, alongside `gcsArchive`):

```json
"transcriptBackup": { "enabled": true, "hour": 23, "minute": 45, "sinceHours": 0 }
```

Defaults to on — the feature is already gated behind the opt-in
`gcsArchive.enabled`, so if archiving is configured, transcripts get kept.

### What "changed" means, and losing the index

Change detection is per file, never by counting: `size` and `floor(mtimeMs)` are
compared against what was last uploaded. Appending to a JSONL moves both, so a
live session is always caught. (A rewrite that preserved byte length *and* mtime
would slip through; nothing in Claude Code does that, and hashing every session
each sweep would cost far more than it buys.)

Those numbers are the **local** file's. Nothing reads a modified time back from
GCS — an object's `updated` is when it was uploaded and its `size` is the
*compressed* size, so neither can be compared with a file on disk.

Bookkeeping therefore lives in three places, most convenient first:

1. **The backup index** in the store (PocketBase `backup_units`, or Firestore
   `backupUnits`): one doc per unit, the size/mtime/object of each
   session file it uploaded, its workflow and its time log. It used to be
   `archive-index.json` in the plugin data dir; the first sweep after the move
   imports that file and renames it `archive-index.json.imported`.
2. **`<identifier>/manifest.json`** in the bucket, written by the sweep that
   uploaded the data: the same record, but travelling *with* the unit rather than
   in one machine-wide file, and readable straight from the GCS console.
3. **Custom object metadata** — `srcSize`, `srcMtimeMs`, `srcWorktree`,
   `srcTranscriptDir` — stamped on each session object, so even a unit with no
   manifest can be reconstructed from a listing.

So no, losing the index is not fatal: `ks-flow backup --reindex` rebuilds it in
the store from the bucket. It prefers a manifest, falls back to object metadata, and resolves
"where do these transcripts belong" from a live worktree, else the completed-unit
record in the main checkout's `workflow/` tree, else the stamped location. On the
first real bucket that recovered **40 of 40 units, 0 skipped** — including units
whose worktree had already been removed. Objects predating the stamping carry no
source size/mtime, so they re-upload once, which is the safe direction.

### Migrating legacy archives

Units archived by the old removal hook hold a single `<id>/transcript.tar.zst`.
Restore can read those, so nothing is broken, but they cannot be updated
incrementally and carry no manifest or source stamps.

```bash
ks-flow migrate-archives --dry-run          # the plan; inspects no contents
ks-flow migrate-archives                    # safety-copy, then convert
ks-flow migrate-archives --unit KAR-1234    # one unit
ks-flow migrate-archives --delete-legacy    # also drop the old tarball
```

**Every object under a unit's prefix is server-side copied to
`_legacy-backup/<timestamp>/…` before anything is written** — no download, no
egress, and the original bytes stay addressable if a conversion goes wrong. Pass
`--backup-prefix` to choose where, `--skip-backup` to opt out (don't).

Conversion only ADDS objects; the tarball survives unless `--delete-legacy`, so a
half-finished unit is simply finished by re-running. Units that already have
per-file objects are skipped unless `--force`.

`tar` preserves each file's mtime, so a converted object's source stamp matches
what a local sweep would compute — the result is indistinguishable from a normal
upload and will not re-upload on the next run. The unit's transcript dir comes
from a live worktree, else the completed-unit record in the main checkout's
`workflow/` tree; without either, the manifest is written without one and a
restore will need the worktree recreated first.

Delete the `_legacy-backup/` prefix once you are satisfied.

### Done column

Finished work — Linear status done / merged / closed / canceled, or Linear's
`completed`/`canceled` state type — leaves its phase column for the last column
of its lane, **Done**, whatever phase it reached. It is the same card as
everywhere else: status ribbon, links, Inbox threads and the **NEEDS YOU** sash,
backup/restore, reminders and **Remove**. Newest activity first.

By default the column holds only Done work **whose git worktree still exists**
— cleanup candidates. Tick **show removed** in the header to add Done work whose
worktree is already gone: those cards are dimmed and offer only Restore, since
there is no worktree left to act on. A [forgotten device](#several-devices)'s
cards join them here, whatever their phase.

A Done ticket with a live worktree is still read from Linear every 3 minutes, so
reopening it moves its card back to its phase column.

### Removing a worktree

Every card with a live worktree on this device has a **Remove** button
(another device's card has none: remove it on that device). On a card outside the
Done column the confirmation adds a red warning that the ticket is still open
and unpushed commits go with the branch if your command deletes it.

0. **Confirm.** A dialog names the worktree, says whether it is backed up first, and shows the exact command it will
   run (placeholders filled in). Esc, the backdrop or Cancel back out.
1. **Live-session gate.** Before doing anything it checks (via `lsof`, by working
   directory) whether any live process sits in the worktree — an open shell or a
   Claude Code session (`node`, classified via `ps`). If so, it asks you to
   confirm; **Kill sessions & remove** then SIGTERM→SIGKILLs those processes
   (this ends the Claude session and its terminal) before continuing. If a
   process can't be killed, the remove is aborted.
2. **Archives to GCS (if enabled).** With the GCS archive enabled (see above),
   the transcript + workflow archives are built and uploaded first; a failure
   here **aborts** the removal so nothing is deleted un-archived.
3. **Runs your command.** The configured removal command (see Settings) runs via
   `zsh`, with `~/.zprofile` and `~/.zshrc` sourced first and the command itself
   `eval`'d — so your PATH, aliases, and shell functions resolve just like in a
   terminal. Placeholders `{{path}}` / `{{identifier}}` / `{{title}}` are
   substituted (also exposed as `$KS_WORKTREE` / `$KS_IDENTIFIER` / `$KS_TITLE`),
   and `{{path}}` is that card's worktree.
4. **Streams output.** stdout/stderr stream live into that worktree's own
   bottom-right panel (hide it, and See logs beside Remove brings it back); on
   success the board refreshes and the card goes (or, with **show removed** on,
   dims), on failure the error stays in the panel.

> The removal command is arbitrary shell authored by you and run on localhost —
> a single-user trust boundary. If no command is set, Remove prompts you to set
> one in Settings.

## Plannotator Inbox

Agents can ask in the [Plannotator Inbox](https://docs.plannotator.ai/open-source/inbox) instead of the terminal, so a session waiting there looks idle in its tmux pane. The daemon reads the Inbox's files and puts each card's open threads on the card (the **NEEDS YOU** sash and thread rows, under **Cards**), makes the card wait on you, and sends a notice. Read-only: the daemon never writes to the Inbox or calls it, except the health check.

- **Where.** `$PLANNOTATOR_DATA_DIR`, else `~/.plannotator`, else `$XDG_DATA_HOME/plannotator` (the Inbox's own order), then `inbox/projects/<key>/`. Only the project whose `root` is this board's repository is read. `src/lib/inbox.ts` holds the reader, with tests in `src/lib/inbox.test.ts` (`npm test` in `src/`).
- **Format.** `project.json`, `messages.jsonl` and `questions.jsonl` (questions **and** action items) are append-only logs of `{v, seq, at, kind, id, record}` lines, each a full snapshot: per `kind:id` the highest `seq` wins. The format is the Inbox's own, not a published one (plannotator 0.28.x, `packages/shared/inbox/store.ts`); it only adds fields. A line with `v` other than 1 is skipped and logged once, any line that doesn't parse is skipped, and annotations and Board cards are not read.
- **Changes.** Each file is read from where the last read stopped. A crash's half-written line waits until the Inbox ends it. Deleting a thread rewrites the files (new inode, shorter), so that project is read again from the start; deleting a project removes its folder, and its threads leave the cards.
- **What waits on you.** A question's state is worked out the way the Inbox does it (`inboxQuestionState`): replaced, closed by archiving (questions asked before the archive line) or Mark read, else **open** (no answer), **picked** (answered in the Inbox, not sent) or sent. An open question, an open action item, or a picked answer (it still has to be sent) waits on you. An answer whose reply line never landed counts as picked.
- **Which card.** By Claude session id only: a question shows on the card whose `sessionIds` hold its `asked_by_agent_id`, an unseen message the card whose sessions hold its `author.session`. A thread another session replied into shows each card only its own part. A message's `base_path` (the folder it was sent from) is not used, since any session can name any folder; the Inbox project's `root` is the main checkout, so it can't place a thread either.
- **No guard on Inbox calls.** ks-flow does not police what a session does in the Inbox: any session can send with any `project_path` and archive (`resolve_message`) any thread. A `PreToolUse` command hook (`scripts/inbox-guard.mjs`) that refused a send naming another checkout, and an archive of a thread the session never wrote in, was removed on 2026-10-31 because it could not work: the `plannotator_inbox` tool Claude Code sessions use is registered by the plannotator mod in-process (`$.tool.register`) and answered in its `tool.call` hook without `next(e)` (plannotator's `apps/hook/hooks/mod/register.ts`: "No other hook or core runs for it"), so Claude Code never reaches its pre-tool step, where plugin `PreToolUse` hooks run. Checked on 2.1.316: the hook was listed in `/hooks`, yet a probe line at the top of the script never ran across three calls, before and after `/reload-plugins`. The same mechanism skips the permission flow for a mod's own tool (anthropics/claude-code#104217). A working guard would need a ks-flow mod that answers `tool.call` for that tool before plannotator does (untested: depends on the order mods run in), or an ownership check in plannotator itself.
- **Limits.** The session id is what keeps a card honest, and it's reliable for messages sent through Claude Code's in-process `plannotator_inbox` tool, which stamps the real session id and takes no `agent_session` argument. The Inbox's stdio server (`plannotator inbox mcp`, which fills `agent_session` only when the caller leaves it out and trusts `PLANNOTATOR_SESSION_TAG`) and its HTTP API (with the token from `inbox.json`) accept any session id. Plannotator can't be changed, so an agent that goes around the tool can still post as another session.
- **Waiting.** A card with something waiting gets `waiting: { tool: 'Inbox', since }` (the oldest waiting question), unless it already waits on something older.
- **Notice.** When a question or action item newly waits, one notice per card: title the ticket, subtitle *Claude asked you in the Inbox* (*Stopped on you — …* when the agent stopped), body the question (`+N more`). What was already open when the daemon starts is not announced. Same switches as the rest: the reminders master switch and the card's Pause.
- **Links.** `<url>#thread=<root id>&msg=<message id>` (the first waiting message), where `url` comes from `inbox.json` read every tick, since the Inbox's port changes when it restarts. The daemon reads `url`, `port` and `serverSession` only, never the token. `GET /api/inbox/health` decides `inboxRunning`; when the Inbox is closed the links say so (`plannotator inbox` starts it).
- **Another Mac's card.** Each Inbox listens only on its own Mac, so another device's card had no Inbox link. With Plannotator's linked machines, two Inboxes are linked once over Tailscale (`plannotator inbox link`; `ks-setup doctor` guides it), and each window shows both Macs' threads; a `#thread=<id>` link to the other Mac's thread opens there too.
  - **What each daemon publishes:** its Inbox's id and the ids linked with it, as `devices/{id}.inboxId` and `inboxLinks`. It reads them from `inbox/machines.json`: the ids only, never a link's token.
  - **After a reboot: `ks-flow inbox-check`.** A stopgap until Plannotator fixes this. Tailscale keeps its `serve` mappings across a reboot, and the restarted Inbox then refuses to publish over its own leftover mapping, or to reuse its link door's: "Another tailscale serve mapping already uses port …". `ks-flow inbox-check` checks, in order:
  1. Plannotator is installed.
  2. Tailscale is running.
  3. The Inbox runs.
  4. There are no leftover mappings: a mapping on the Inbox's port or a link-door port (8443–8450) that points at a loopback port nothing listens on. Only those are removed.
  5. The Inbox has a tailnet address.
  6. The linked Macs are online.

  It removes leftovers and starts or restarts the Inbox (published) as needed, up to two rounds, which is what a reboot can take. `--dry-run` only reports. The person runs it, since restarting the Inbox is theirs to do (Plannotator's own rule for agents).
- **The chips:** an "Inbox ↗" chip, beside Slack and PR whenever the card has Inbox threads, opens the first thread that waits on you, else the newest. "⏳ waiting: Inbox" opens that thread too. Both follow the same rule as the sash, below.
  - **The card:** when the viewing device's `inboxLinks` holds the owner's `inboxId`, the sash and the thread rows open the viewing device's own Inbox at that thread ("Inbox ↗ · B"). Otherwise they stay plain rows that say to open the Inbox on the owner, or to link the two Inboxes.

## Notifications

Three hooks fire a `terminal-notifier` notification the moment a session in the tracked project blocks: the two blocking tools (`AskUserQuestion`, `ExitPlanMode`) and the two blocking hook events (`PermissionRequest`, `Elicitation`). These are daemon-independent and throttled per session.

**Rich content & layout.** A notice's **title** is the short work-unit identifier (ticket → **`KAR-1234`**; project → its slug; else **`ks-flow`**), its **subtitle** is the status phrase (*Claude is waiting on you*, *needs permission to continue*, …), and the **message body** carries the long ticket/project title. macOS truncates the title and subtitle to a single line but **wraps the body**, so the descriptive text lives there to avoid `…`-truncation (there is no terminal-notifier wrap flag — this layout is the wrap). Hooks resolve the unit from their cwd via `scripts/notify-context.mjs` (a zero-dep node reader that picks the workflow `state.yaml` whose `worktree_dir` matches the repo); the daemon matches the session to a unit by worktree.

**Delivery.** `terminal-notifier` is invoked **without `-sender`** — that masquerade hangs forever for terminals that aren't registered macOS notification clients (e.g. Ghostty), and there's no reliable way to brand a notice as an arbitrary terminal from an out-of-band process. `-closeLabel "OK"` relabels the close button; the system-added action button can't be removed (harmless — it has no action). Notices appear under terminal-notifier's own identity.

**Make them persist.** macOS notifications auto-dismiss (~5s banner) unless the app's style is **Alerts** — a per-app System Settings choice, not an API. To keep notices until you dismiss them: **System Settings → Notifications → terminal-notifier → Alert style: Alerts**. The Reminders settings panel has an **Open Notification Settings** button (`/api/open-notification-settings`) that deep-links there.

**Silent but everything looks fine? Check Focus first.** If `events.jsonl` is still appending, the daemon is alive, and units match — yet no notices appear — it's almost always macOS **Focus / Do Not Disturb** suppressing the banner, not ks-flow. Tell-tale: a manual `terminal-notifier … -group X` prints `* Removing previously sent notification…` (proof it *posted* to Notification Center) but no banner shows. Fix per-Focus (not the Notifications pane): **System Settings → Focus → \<active Focus\> → Allowed Notifications** → add terminal-notifier to "Allow Notifications From" (or ensure it's not silenced), or turn the Focus off. Don't debug the daemon until a manual terminal-notifier banner is confirmed visible.

## Reminders

Enabled by default; toggle + tune in `/settings`. **Enable reminders** is the master switch — turning it off silences **everything**: stop-nudges, per-card custom reminders, and Notes-page reminders. Reminder records live in the DB (`reminders` collection); the board's server writes them and the daemon (its `reminders` job on the one clock — every 30s, no OS scheduling) fires the notifications. "Remind on OS wake" is detected by a timer-gap on the daemon's tick, so no per-reminder OS jobs.

- **Stop-nudge (auto).** When a session stops (end of turn → idle), the `Stop` hook records the event and the **daemon owns all notices** (the hook fires none): the first notice waits until the session has been **quiet for the debounce window** (default **60s**), then it repeats every **N min** (default 5) until the session **resumes**, **ends** (`SessionEnd`), or hits the **cap** (default 12 nudges). "Quiet" spans the session transcript, its worktree siblings, **and its teammates' subagent transcripts** (`<session>/subagents/*.jsonl`) — so a notice never misfires at a main-turn boundary while background teammates are still working. The gate is *time-since-last-activity* (not a stop-timestamp comparison), which sidesteps the `Stop` event's whole-second timestamp vs the transcript's millisecond timestamps. The daemon only nudges a session that **matches a tracked ticket/project** — an ad-hoc / main-checkout session (no work-unit) is silent rather than firing a generic notice — and it **drops the nudge once the work-unit is complete** (its terminal phase `implementation` COMPLETED, or a closed Linear status: Done / Canceled / Merged / Duplicate). Across a **daemon restart** the `events.jsonl` read offset is persisted (in `checkpoints.json`), so already-consumed Stops aren't replayed/duplicated; instead, startup **reconstructs** the nudge for any session still waiting (its last lifecycle event is a `Stop`, within maxAge — resumed/ended sessions stay quiet). To avoid an N-notice burst, those first post-restart notices are consolidated into **one grouped notice** (*"N sessions waiting on you"* with the identifiers in the body; a lone session gets its normal rich notice), after which each session resumes individual nudges. Each card shows an **▶ active / ⏸ paused** control — **Pause** mutes **all** of that card's notices (the stop-nudge **and** its per-card custom reminders, even a lapsed one) and hides the red overdue glow; it **auto-returns to Active** when the session resumes.
- **Per-card custom reminder (manual).** The **⏰** control on a card sets a reminder — relative (`30m` / `2h` / `1d`) or an absolute datetime — with an optional note. It fires at due time, then **re-nags once a day** (and on OS-wake / daemon-start) until you stop it — **clear** it (✕), **reschedule** it (edit the due date — that's the snooze), or turn the master switch off. Notes-page reminders share this exact path (see **Notes** below).

Settings: **Enable reminders**, **idle debounce (sec)**, **stop-nudge interval (min)**, **max nudges (cap)** — shared in `meta/settings` and mirrored into each device's `board-settings.json` (read by the hooks and the daemon; changes apply without a restart).

**Every device notifies.** A reminder's "already notified today" is kept per device in `<dataDir>/reminders-fired.json` (`{uid: {firedAt, dueAt}}`), not in the shared reminder doc, so one device firing it doesn't silence the others; a changed due time re-arms it. Stop-nudges come from the session's own device only, since its hooks write the events. The panel also has the **Open Notification Settings** button (Alerts setup, above).

### Overdue glow

Any card with a reminder whose due time has **passed** gets a **red travelling-border glow** — the same animated ring as an active session, in red (`.overdue-glow` in `globals.css`). When a session card is **both** active and overdue, the **indigo active glow wins** (an in-progress session is the more useful signal). A **paused** session card shows **no** red glow (pause silences its visual cue too). It's a live, clock-driven UI cue (self-updates on the shared `useNow` tick) and applies to **both** session **work-unit cards** (their per-card custom reminders) and **Notes-page cards**. Clearing or rescheduling the reminder removes the glow.

**Requires `terminal-notifier`** (same as the other notifications). When reminders are enabled, `/settings` preflights it (`/api/reminders-preflight`) and offers an **Install** button (`brew install terminal-notifier`); the daemon also logs a one-line warning at startup if it's missing. Without it, every notification is a silent no-op.

> Notifications only fire for sessions **in the tracked project**. The data dir is derived from the project's **git-common-dir** (`~/.claude/plugins/data/ks-flow/<encoded-common-dir>/`), so hooks, daemon, and board always resolve the **same** dir regardless of how the plugin was loaded (inline `--plugin-dir` / `--local-plugin` vs marketplace). Set **`KS_FLOW_DATA`** to override the location. The single source of truth is `src/lib/datadir.mjs` (a zero-dep node module the bash entities call as a CLI and the TS daemon imports).

## Notes (`/notes`)

An opt-in page for **saved notes & reminders**. **Off by default** — enable it under `/settings` → **Notes**; a **📝** link then appears in the board header. Note rows live in the `reminders` collection (`kind:'note'`); the board's server reads/writes them (`/api/notes`), the daemon fires them. Every note can carry an **optional reminder** that fires at its due time and **re-nags once a day until cleared** — the same scheduler path as a per-card custom reminder. Past-due cards get a **red glowing border** (see [overdue glow](#overdue-glow)).

**Adding** — the **+ Add note** button in the header opens a small menu:
- **Any note** — free text. A modal takes the text, a **work type**, and an optional reminder.
- **Slack note** — shown only when `SLACK_TOKEN` is set. The modal takes a **Slack message permalink**; the server parses `channel` + `ts` and fetches the message **text + date** via `conversations.history` (or `conversations.replies` for a thread link) — `/api/notes/slack/resolve`. Needs the channel **history** read scope the link's channel type requires (`channels|groups|im|mpim:history`) — the same read scope the ks slack-cli uses. Slack notes show the official **Slack icon** top-left + an *open in Slack* link. **Mentions are humanized + colored at render time**: `<@U123>` / `<#C123>` / `<#C1|general>` / `<https://x|label>` render as `@Alice` / `#general` / `label`, with **user mentions in indigo, channel mentions in sky, broadcasts (@here/@channel) in amber, and links as indigo anchors** — the **stored text stays raw**, this is display-only. User **and channel** IDs without an inline name resolve **cache-first** from the DB (`slack_names` collection, PocketBase and Firestore — a workspace-global id→name cache covering both); only misses hit Slack (`users.info` for `U…`, `conversations.info` for `C…` — needs `users:read` / `channels:read`) and are written back (`/api/notes/slack/names`). **Why paste, not auto-list?** Slack **retired the saved-for-later / `stars.list` read APIs in 2023** — *"there are no direct APIs for Save it for Later"* ([changelog](https://docs.slack.dev/changelog/2023-07-its-later-already-for-stars-and-reminders/)) — so saved messages can't be enumerated, but a *single* message is still fetchable by its permalink.

**Layout** — the board splits by **work type**: **Professional** on the left, **Personal** on the right (each note picks one in the add modal; Professional is the default). Each column is **reverse-chronological** — newest-added (`createdAt`) first.

**Editing** — free-text (non-Slack) notes show a **✎** button → inline textarea → **save** (`PATCH {uid, text}`) / **cancel**. Slack notes are **read-only** (the body is the fetched message), so they have no ✎.

**Each card has three lifecycle actions** — don't confuse them with the reminder's **clear**, which only removes the ⏰ due time and leaves the note on the board:
- **✓ Done → Archive** — sets `done` (kept in the DB, hidden from the board, daemon skips it so it stops nagging). The header **✓ Archive** (with a count) lists completed notes; each can be **Reopened** (un-`done`, back to the board). Semantic: *finished this.*
- **✕ Delete → Trash** (soft) — asks for confirmation, then sets `cleared` (also hidden + daemon-skipped). The header **🗑 Trash** (with a count) lists soft-deleted notes; each can be **Restored** (un-`cleared`) or **Deleted forever** (the only hard `DELETE`). Semantic: *mistake / didn't matter.* So an accidental ✕ is always recoverable.

`done` and `cleared` are **independent flags** — Archive and Trash are separate drawers; GET filters are `?archive=1` (`done && !cleared`), `?trash=1` (`cleared`), and active (`!done && !cleared`).

**Notification titles** — a fired note reminder is titled by its work type + source: **Professional Slack note** / **Personal Slack note** / **Professional note** / **Personal note** (the daemon builds the subtitle from `workType` + whether `section === 'slack'`).

> Gating (`/api/notes/config`): the page + **Any note** show on the Notes **toggle**; the **Slack note** option also needs `SLACK_TOKEN` present (a `LINEAR_API_KEY` slot is wired for a future Linear source). Only a boolean (`tokenPresent` / `keyPresent`) is reported to the UI — the token never leaves the server. Set tokens with the **Edit .env** button in the settings header (see [Settings](#settings-settings)).

## Briefing (`/briefing`)

A master Claude session (the `ks-master` plugin, started by `claude-ks-master`) reads Slack every six hours and puts what needs you on the board with a due time. The full design and the contract between the parts is `docs/briefing.md`. **Off by default**: turn it on under `/settings` → **Briefing**.

- **What it reads:** your DMs (group DMs too), your @mentions, your name written anywhere (Settings → Briefing → names), and your own messages (to spot promises and replies). No channel is read in full.
- **Items:** an *ask* (someone wants something from you), a *promise* (you said you'd do something), or *FYI* (a mention or DM that asks nothing). Each stores the exact message link and, for a thread reply, the thread's first message link. Items from one thread show as one card.
- **Due times:** a deadline in the message as is; a promise as said ("by EOD" 19:00, "tomorrow" 12:00 the next working day); DM +4h; mention +24h; FYI +24h. Something arriving on a weekend starts its clock Monday 09:00, and a due time landing on a weekend moves to Monday at the same time (never a deadline from the message or one you set). Senders on the half-time list get half the time. Change any due time on the card; every change is kept, and pushing one later counts as "pushed N×".
- **Escalation:** calm (under 50% of the time used), warm (50–80%), hot (80–100%, one notice), overdue (full red, one notice, then a reminder at each scheduled run). FYI never passes warm. Several notices owed at once become one summary. The reminders switch mutes them, and pausing a card mutes items linked to its ticket. The daemon keeps what it sent in its own `<dataDir>/master/notices.json` and never writes an item, so it can't undo an archive or a due change.
- **Only you archive.** Nothing closes on its own, a reply doesn't close an ask, and the master can only attach "looks done" evidence. Archive asks Done / Not mine / Won't do and an optional note.
- **The page:** Next up, then Overdue, Hot, Quick replies, Due today, Later, and Worth knowing (folded); nearest due first in each, except Overdue, which shows the most recently due first (Next up is its top card). The sidebar has the master (Brief me now and Restart master while one runs, both disabled or refused while none does; **Start master** while none does, which the daemon launches right away even with the Briefing off; Open in Claude; one viewer window, opened by `claude-ks-master` when none is open, always shows it and reattaches after every restart), the session roll call and today's counts. **Daily log** (`/daily`) shows what `/ks-master:log-off` wrote: archived, slipped, promises due tomorrow, where each session stopped, engaged time.
- **The master:** one per board, on the device chosen in Settings → **Devices** (see [Several devices](#several-devices)); only that device's daemon runs the Briefing schedule and supervises it. It is woken by request files in that device's `<dataDir>/master/requests/` (daemon at each slot, the board's buttons); its mod submits them as turns when it's idle. A board on another device sends Brief me / Restart as a `masterRequests` doc that the master device's daemon turns into a request file (requests older than 15 min are dropped), and reads the master's status from `devices/<master>.master`. While the master device is asleep or offline, Brief me is disabled ("master device <name> is offline"). The daemon starts it when it's down and hard-restarts it when a request sits unanswered for 15 min with no heartbeat for 5 (the launch commands' output goes to `<dataDir>/master/launch.log`). A master counts as running while its process lives (found by pid, or by session id before the pid is recorded) or, for its first 3 minutes, while it is still starting: nothing starts a second one beside it. It restarts itself with a handoff (`/ks-master:restart`) after log-off or past 70% context. Each start, restart and request is kept in the store (`master_events`) and listed in the [Activity Log](#activity-log-activity) with the briefing, log-in and log-off runs. See `plugins/ks-master/README.md`.

## Development

```bash
claude plugin validate ./plugins/ks-flow
claude --plugin-dir ./plugins/ks-flow      # load locally
cd plugins/ks-flow/src && npm test         # daemon tests (node:test + tsx): lib/**/*.test.ts
```

Tests are excluded from the daemon build (`tsconfig.json`).

See `docs/IMPLEMENTATION_PLAN.md` for the full design.
