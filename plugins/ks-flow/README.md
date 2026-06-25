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
  PreToolUse[AskUserQuestion|ExitPlanMode]                 projects/{id}/{workUnits,sessions}
  PermissionRequest, Elicitation                           │ real-time (SSE / onSnapshot)
  │ filter on .cwd → terminal-notifier + events.jsonl      ▼
  ▼                                                  Next.js board (ks-flow open)
(notification, daemon-independent)                   COLUMNS = project phaseModel (from state.yaml)

<main_worktree>/workflow/<user>/**/state.yaml ─► daemon ─► WorkUnitDoc + project.phaseModel
```

- **Writer** = the ingester daemon (the only DB writer).
- **Hook scripts** = notify + append local events (never touch the DB).
- **Reader** = the Next.js board (subscribes in real time, never writes).

Ingestion bookkeeping (byte offsets, inode) stays in a local `checkpoints.json` in `${CLAUDE_PLUGIN_DATA}` — per-line churn that must not incur cloud writes. Only derived session/work-unit documents go to the DB.

### Work-unit sourcing & I/O

A ticket's `state.yaml` lives in its worktree while in progress; on completion the workflow is copied back to the main checkout and the worktree is deleted. The same unit can therefore appear in both places, so the daemon dedups per unit by **source precedence**: a **worktree copy always overrides the main-checkout copy**, and the main copy wins only once no worktree carries that unit (i.e. after cleanup).

Both the start-up backfill and the 15s rescan are gated to avoid needless work:
- **Read gate** — `state.yaml` is re-parsed only when its `mtime` changed (completed tickets' files in the main checkout accumulate forever but never change, so they're stat-ed, not re-parsed).
- **Write gate** — a work-unit/project doc is upserted only when its content actually changed (signature compare, excluding `updatedAt`), so a single edit doesn't re-write the whole set.

Both gates are in-memory, so a daemon restart does one cold pass, then steady-state stays cheap.

## Setup

The daemon, PocketBase, and the board are self-bootstrapping — no build step.

1. Enable it: `claude plugin enable ks-flow` (or via `/plugin`). You'll be prompted for the config below.
2. On the next session start, `bootstrap.sh` installs `node_modules` into the data dir, builds the daemon, and registers the always-on launchd agent.

Optional `./init` (PATH + launcher wiring) — run once if you want the `ks-flow`
CLI on your `PATH` outside a session, and to load ks-flow automatically via the
`ks` plugin's `claude-ks` launchers. It:
- adds `bin/` to your shell rc (`PATH`), and
- registers `ks-flow` in `KS_EXTRA_PLUGINS` in `plugins/ks/scripts/.env`
  (idempotent, non-destructive) so `claude-ks` / `claude-ks-serena` load it
  alongside `ks`. See `plugins/ks/scripts/README.md`.

### Configuration (prompted at enable)

| Key | Default | Notes |
|-----|---------|-------|
| `project_path` *(required)* | — | Main worktree / repo root to track. |
| `workflow_user` | auto | The `workflow/<username>/` segment. |
| `db_provider` | auto | Blank ⇒ `pocketbase` (local default) unless a cloud Firestore project is set ⇒ `firestore`. Force with `pocketbase`/`firestore`. |
| `pocketbase_port` | 8090 | Localhost port for the bundled PocketBase server (`pocketbase` provider). |
| `firestore_mode` | `emulator` | `emulator` (local, no GCP) or `cloud`. Only used when `db_provider=firestore`. |
| `gcp_project_id` | — | Required when `cloud`. |
| `firestore_credentials` | — | Admin SDK service-account JSON (daemon). Optional fallback when `cloud`. |
| `firebase_api_key` | — | Client SDK API key (board). Required when `cloud`. |
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

## CLI (`bin/ks-flow`, on PATH while enabled)

| Command | Purpose |
|---------|---------|
| `ks-flow start` | Start the daemon (+ PocketBase); builds/installs on first run. |
| `ks-flow open` | Build and open the board UI in the browser. |
| `ks-flow close` | Stop the board UI server. |
| `ks-flow stop` | Stop everything — board UI, daemon, and PocketBase. |
| `ks-flow status` | Status of all services (daemon, PocketBase, board UI). |
| `ks-flow daemon` | Run the ingester in the foreground (debug). |
| `ks-flow set-project <path>` | Re-point the tracked project (rewrites `project.conf`, re-backfills). |
| `ks-flow archive <worktree> [id] [title]` | Archive one worktree's transcript + workflow to GCS (same step the board runs before Remove). No-op if archiving is disabled. |
| `ks-flow backfill-archive [--dry-run] [--force]` | Archive every already-completed workflow (in the main checkout with no live worktree) to GCS. |

## Board UI

`ks-flow open` builds and serves the Next.js board (dark theme). Header controls:

- **swimlanes** *(on by default)* — split cards into `ticket` / `project` lanes. Each lane shows only that type's phases (the ticket lane is the shorter init + context/research + plan/implement set), and a lane with no cards is hidden.
- **show completed** *(off by default)* — reveal the [Completed · worktree removed](#completed--worktree-removed) table (finished work whose git worktree is already gone).
- **live / connecting…** — realtime subscription status.
- **↻ refresh** — manual re-pull of the project, work-units, and sessions from
  the store (the live subscription still pushes on its own; this is an on-demand
  pull, reused by UI actions such as worktree removal).
- **📝 notes** — the [Notes](#notes-notes) page (saved notes & reminders). Only shown when Notes is enabled in Settings.
- **▤ processes** — the running-processes page (below).
- **⚙ settings** — the settings page (below).
- **kill** — two-step kill switch that stops the daemon + PocketBase. They
  restart and re-backfill on the next Claude session, so it's reversible.

Only cards whose worktree is a **current** git worktree and whose Linear status
is not done are shown on the board (stale records linger in the store but are
filtered out).

The board also scrolls **horizontally only within each lane's column row** —
the header and the Completed-worktrees table below stay fixed to the viewport.

### Cards

Each card carries quick links + live state:

- **Linear ↗ / Slack ↗ / PR** — open the ticket/project in Linear (entity `url`),
  the source Slack thread (`slack.project_thread`), and the GitHub PR. Each shown
  only when present.
- **⧉ path** — copy the card's worktree directory to the clipboard.
- **priority / estimate / waiting** badges; a `⏳ waiting` badge (amber ring) when
  a session is blocked on you.
- **Glowing animated border** when a session is **active** — a session counts as
  active if it wrote within the last **5 minutes** (recency, evaluated client-side
  against a shared ticking clock, so it self-expires — not the daemon's snapshot).
- **`⟳ active <when>`** — when the session was last active (`lastActivity`, the
  last timestamped JSONL line); absolute time on hover.

The full parsed `state.yaml` is replicated onto each work-unit (a `state` field),
so any field can be surfaced on the board without new daemon plumbing.

### Settings (`/settings`)

- **Tracked project** — re-point the board at another repo. The path is
  validated as a git repo; the daemon re-points and re-backfills on save.
- **Worktree removal command** — the command run by the Completed worktrees
  view (below). Stored in `board-settings.json` (separate from `project.conf`,
  so bootstrap never clobbers it).
- **Archive to Google Cloud Storage** — opt-in (off by default). When enabled,
  Remove first archives the worktree before deleting it (see below). Toggling it
  on runs a **package preflight** (`/api/archive-preflight`) and, if `zstd` (or
  `tar`) is missing, shows a banner with the install command (`brew install
  zstd`). The enable flag, bucket, and optional object prefix live in
  `board-settings.json`; **credentials never do** (see env below).
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

### GCS archive on removal

Opt-in archival of a project's conversation for later analysis. Enable it in
Settings **and** provide a dedicated GCS service-account via
`$CLAUDE_PLUGIN_DATA/.env` (independent of any Firestore creds):

```
GCS_BUCKET=my-ks-flow-archives          # or set the bucket in Settings
GCS_CREDENTIALS=/path/to/sa.json        # OR the client-email/private-key pair:
GCS_CLIENT_EMAIL=svc@project.iam.gserviceaccount.com
GCS_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n"
GCS_PROJECT_ID=my-gcp-project           # optional (falls back to the SA's)
```

When enabled, removing a completed worktree first builds **two** maximally
compressed archives and uploads both, then runs your remove command:

- `transcript.tar.zst` ← `~/.claude/projects/<encoded-worktree>/` (all session
  JSONL + `subagents/*.jsonl`).
- `workflow.tar.zst` ← the worktree's `workflow/` folder (`state.yaml` +
  `resources/`).

Compression is `tar -cf - … | zstd --ultra -22 -T0` (the contents are plain
text, so they shrink dramatically). Objects land at
`gs://<bucket>/<prefix>/<identifier>/{transcript,workflow}.tar.zst`.
Unpack one with `zstd -dc X.tar.zst | tar -xf -`.

**Abort-on-failure:** if archiving is enabled but fails (missing `zstd`, bad
creds/bucket, network), the removal is **aborted** — the worktree is never
deleted un-archived. Fix the config (or disable archiving) and retry.

**Backfill:** `ks-flow backfill-archive` archives workflows that were *already*
completed before this feature existed — those in the main checkout's `workflow/`
whose worktree has already been removed. It locates each unit's transcript dir
(which persists under `~/.claude/projects/` after `git worktree remove`) and
uploads both archives. Re-runnable: it skips units already in GCS unless
`--force`; use `--dry-run` to preview candidates first.

### Completed worktrees · not removed

A table below the board lists finished work — Linear status done / merged /
closed / canceled — **whose git worktree still exists**. These are cleanup
candidates: the daemon nulls a card's `worktreeDir` once its worktree is gone,
so a row here means the directory is still live.

Each row has a **Remove** button:

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
   and `{{path}}` is that row's worktree.
4. **Streams output.** stdout/stderr stream live into a bottom-right panel; on
   success the row is hidden and the board refreshes, on failure the error
   stays in the panel.

> The removal command is arbitrary shell authored by you and run on localhost —
> a single-user trust boundary. If no command is set, Remove prompts you to set
> one in Settings.

### Completed · worktree removed

The board's archive tail: finished work (same done/merged/closed/canceled
statuses) **whose git worktree no longer exists** — the inverse of the table
above. **Hidden by default**; tick **show completed** in the header to reveal it.
**Read-only** (ticket + Linear link, title, status, PR, last activity) — there's
no worktree left to act on, so no Remove button.

So the board reads top-to-bottom as a lifecycle: **active cards** (in their phase
columns) → **Completed · not removed** (worktree still around, cleanup candidates)
→ **Completed · worktree removed** (fully wrapped up).

## Notifications

Three hooks fire a `terminal-notifier` notification the moment a session in the tracked project blocks: the two blocking tools (`AskUserQuestion`, `ExitPlanMode`) and the two blocking hook events (`PermissionRequest`, `Elicitation`). These are daemon-independent and throttled per session.

**Rich content & layout.** A notice's **title** is the short work-unit identifier (ticket → **`KAR-1234`**; project → its slug; else **`ks-flow`**), its **subtitle** is the status phrase (*Claude is waiting on you*, *needs permission to continue*, …), and the **message body** carries the long ticket/project title. macOS truncates the title and subtitle to a single line but **wraps the body**, so the descriptive text lives there to avoid `…`-truncation (there is no terminal-notifier wrap flag — this layout is the wrap). Hooks resolve the unit from their cwd via `scripts/notify-context.mjs` (a zero-dep node reader that picks the workflow `state.yaml` whose `worktree_dir` matches the repo); the daemon matches the session to a unit by worktree.

**Delivery.** `terminal-notifier` is invoked **without `-sender`** — that masquerade hangs forever for terminals that aren't registered macOS notification clients (e.g. Ghostty), and there's no reliable way to brand a notice as an arbitrary terminal from an out-of-band process. `-closeLabel "OK"` relabels the close button; the system-added action button can't be removed (harmless — it has no action). Notices appear under terminal-notifier's own identity.

**Make them persist.** macOS notifications auto-dismiss (~5s banner) unless the app's style is **Alerts** — a per-app System Settings choice, not an API. To keep notices until you dismiss them: **System Settings → Notifications → terminal-notifier → Alert style: Alerts**. The Reminders settings panel has an **Open Notification Settings** button (`/api/open-notification-settings`) that deep-links there.

**Silent but everything looks fine? Check Focus first.** If `events.jsonl` is still appending, the daemon is alive, and units match — yet no notices appear — it's almost always macOS **Focus / Do Not Disturb** suppressing the banner, not ks-flow. Tell-tale: a manual `terminal-notifier … -group X` prints `* Removing previously sent notification…` (proof it *posted* to Notification Center) but no banner shows. Fix per-Focus (not the Notifications pane): **System Settings → Focus → \<active Focus\> → Allowed Notifications** → add terminal-notifier to "Allow Notifications From" (or ensure it's not silenced), or turn the Focus off. Don't debug the daemon until a manual terminal-notifier banner is confirmed visible.

## Reminders

Enabled by default; toggle + tune in `/settings`. **Enable reminders** is the master switch — turning it off silences **everything**: stop-nudges, per-card custom reminders, and Notes-page reminders. Reminder records live in the DB (`reminders` collection); the board's server writes them and the daemon (the scheduler — one ~30s tick, no OS scheduling) fires the notifications. "Remind on OS wake" is detected by a timer-gap on the daemon's tick, so no per-reminder OS jobs.

- **Stop-nudge (auto).** When a session stops (end of turn → idle), the `Stop` hook records the event and the **daemon owns all notices** (the hook fires none): the first notice waits until the session has been **quiet for the debounce window** (default **60s**), then it repeats every **N min** (default 5) until the session **resumes**, **ends** (`SessionEnd`), or hits the **cap** (default 12 nudges). "Quiet" spans the session transcript, its worktree siblings, **and its teammates' subagent transcripts** (`<session>/subagents/*.jsonl`) — so a notice never misfires at a main-turn boundary while background teammates are still working. The gate is *time-since-last-activity* (not a stop-timestamp comparison), which sidesteps the `Stop` event's whole-second timestamp vs the transcript's millisecond timestamps. The daemon only nudges a session that **matches a tracked ticket/project** — an ad-hoc / main-checkout session (no work-unit) is silent rather than firing a generic notice — and it **drops the nudge once the work-unit is complete** (its terminal phase `implementation` COMPLETED, or a closed Linear status: Done / Canceled / Merged / Duplicate). Across a **daemon restart** the `events.jsonl` read offset is persisted (in `checkpoints.json`), so already-consumed Stops aren't replayed/duplicated; instead, startup **reconstructs** the nudge for any session still waiting (its last lifecycle event is a `Stop`, within maxAge — resumed/ended sessions stay quiet). To avoid an N-notice burst, those first post-restart notices are consolidated into **one grouped notice** (*"N sessions waiting on you"* with the identifiers in the body; a lone session gets its normal rich notice), after which each session resumes individual nudges. Each card shows an **▶ active / ⏸ paused** control — **Pause** mutes **all** of that card's notices (the stop-nudge **and** its per-card custom reminders, even a lapsed one) and hides the red overdue glow; it **auto-returns to Active** when the session resumes.
- **Per-card custom reminder (manual).** The **⏰** control on a card sets a reminder — relative (`30m` / `2h` / `1d`) or an absolute datetime — with an optional note. It fires at due time, then **re-nags once a day** (and on OS-wake / daemon-start) until you stop it — **clear** it (✕), **reschedule** it (edit the due date — that's the snooze), or turn the master switch off. Notes-page reminders share this exact path (see **Notes** below).

Settings: **Enable reminders**, **idle debounce (sec)**, **stop-nudge interval (min)**, **max nudges (cap)** — stored in `board-settings.json` (read by the hooks and the daemon; changes apply without a restart). The panel also has the **Open Notification Settings** button (Alerts setup, above).

### Overdue glow

Any card with a reminder whose due time has **passed** gets a **red travelling-border glow** — the same animated ring as an active session, in red (`.overdue-glow` in `globals.css`). When a session card is **both** active and overdue, the **indigo active glow wins** (an in-progress session is the more useful signal). A **paused** session card shows **no** red glow (pause silences its visual cue too). It's a live, clock-driven UI cue (self-updates on the shared `useNow` tick) and applies to **both** session **work-unit cards** (their per-card custom reminders) and **Notes-page cards**. Clearing or rescheduling the reminder removes the glow.

**Requires `terminal-notifier`** (same as the other notifications). When reminders are enabled, `/settings` preflights it (`/api/reminders-preflight`) and offers an **Install** button (`brew install terminal-notifier`); the daemon also logs a one-line warning at startup if it's missing. Without it, every notification is a silent no-op.

> Notifications only fire for sessions **in the tracked project**. The data dir is derived from the project's **git-common-dir** (`~/.claude/plugins/data/ks-flow/<encoded-common-dir>/`), so hooks, daemon, and board always resolve the **same** dir regardless of how the plugin was loaded (inline `--plugin-dir` / `--local-plugin` vs marketplace). Set **`KS_FLOW_DATA`** to override the location. The single source of truth is `src/lib/datadir.mjs` (a zero-dep node module the bash entities call as a CLI and the TS daemon imports).

## Notes (`/notes`)

An opt-in page for **saved notes & reminders**. **Off by default** — enable it under `/settings` → **Notes**; a **📝** link then appears in the board header. Note rows live in the `reminders` collection (`kind:'note'`); the board's server reads/writes them (`/api/notes`), the daemon fires them. Every note can carry an **optional reminder** that fires at its due time and **re-nags once a day until cleared** — the same scheduler path as a per-card custom reminder. Past-due cards get a **red glowing border** (see [overdue glow](#overdue-glow)).

**Adding** — the **+ Add note** button in the header opens a small menu:
- **Any note** — free text. A modal takes the text, a **work type**, and an optional reminder.
- **Slack note** — shown only when `SLACK_TOKEN` is set. The modal takes a **Slack message permalink**; the server parses `channel` + `ts` and fetches the message **text + date** via `conversations.history` (or `conversations.replies` for a thread link) — `/api/notes/slack/resolve`. Needs the channel **history** read scope the link's channel type requires (`channels|groups|im|mpim:history`) — the same read scope the ks slack-cli uses. Slack notes show the official **Slack icon** top-left + an *open in Slack* link. **Mentions are humanized + colored at render time**: `<@U123>` / `<#C123>` / `<#C1|general>` / `<https://x|label>` render as `@Alice` / `#general` / `label`, with **user mentions in indigo, channel mentions in sky, broadcasts (@here/@channel) in amber, and links as indigo anchors** — the **stored text stays raw**, this is display-only. User **and channel** IDs without an inline name resolve **cache-first** from the DB (`slack_names` collection / Firestore `slackNames` — a workspace-global id→name cache covering both); only misses hit Slack (`users.info` for `U…`, `conversations.info` for `C…` — needs `users:read` / `channels:read`) and are written back (`/api/notes/slack/names`). **Why paste, not auto-list?** Slack **retired the saved-for-later / `stars.list` read APIs in 2023** — *"there are no direct APIs for Save it for Later"* ([changelog](https://docs.slack.dev/changelog/2023-07-its-later-already-for-stars-and-reminders/)) — so saved messages can't be enumerated, but a *single* message is still fetchable by its permalink.

**Layout** — the board splits by **work type**: **Professional** on the left, **Personal** on the right (each note picks one in the add modal; Professional is the default). Each column is **reverse-chronological** — newest-added (`createdAt`) first.

**Editing** — free-text (non-Slack) notes show a **✎** button → inline textarea → **save** (`PATCH {uid, text}`) / **cancel**. Slack notes are **read-only** (the body is the fetched message), so they have no ✎.

**Each card has three lifecycle actions** — don't confuse them with the reminder's **clear**, which only removes the ⏰ due time and leaves the note on the board:
- **✓ Done → Archive** — sets `done` (kept in the DB, hidden from the board, daemon skips it so it stops nagging). The header **✓ Archive** (with a count) lists completed notes; each can be **Reopened** (un-`done`, back to the board). Semantic: *finished this.*
- **✕ Delete → Trash** (soft) — asks for confirmation, then sets `cleared` (also hidden + daemon-skipped). The header **🗑 Trash** (with a count) lists soft-deleted notes; each can be **Restored** (un-`cleared`) or **Deleted forever** (the only hard `DELETE`). Semantic: *mistake / didn't matter.* So an accidental ✕ is always recoverable.

`done` and `cleared` are **independent flags** — Archive and Trash are separate drawers; GET filters are `?archive=1` (`done && !cleared`), `?trash=1` (`cleared`), and active (`!done && !cleared`).

**Notification titles** — a fired note reminder is titled by its work type + source: **Professional Slack note** / **Personal Slack note** / **Professional note** / **Personal note** (the daemon builds the subtitle from `workType` + whether `section === 'slack'`).

> Gating (`/api/notes/config`): the page + **Any note** show on the Notes **toggle**; the **Slack note** option also needs `SLACK_TOKEN` present (a `LINEAR_API_KEY` slot is wired for a future Linear source). Only a boolean (`tokenPresent` / `keyPresent`) is reported to the UI — the token never leaves the server. Set tokens with the **Edit .env** button in the settings header (see [Settings](#settings-settings)).

## Development

```bash
claude plugin validate ./plugins/ks-flow
claude --plugin-dir ./plugins/ks-flow      # load locally
```

See `docs/IMPLEMENTATION_PLAN.md` for the full design.
