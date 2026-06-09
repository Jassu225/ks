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

## Setup

The plugin is fully self-bootstrapping — no manual `./init`.

1. Enable it: `claude plugin enable ks-flow` (or via `/plugin`). You'll be prompted for the config below.
2. On the next session start, `bootstrap.sh` installs `node_modules` into `${CLAUDE_PLUGIN_DATA}`, builds the daemon, and registers the always-on launchd agent.

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

## Board UI

`ks-flow open` builds and serves the Next.js board (dark theme). Header controls:

- **swimlanes** — split cards into `ticket` / `project` lanes.
- **live / connecting…** — realtime subscription status.
- **↻ refresh** — manual re-pull of the project, work-units, and sessions from
  the store (the live subscription still pushes on its own; this is an on-demand
  pull, reused by UI actions such as worktree removal).
- **⚙ settings** — the settings page (below).
- **kill** — two-step kill switch that stops the daemon + PocketBase. They
  restart and re-backfill on the next Claude session, so it's reversible.

Only cards whose worktree is a **current** git worktree and whose Linear status
is not done are shown on the board (stale records linger in the store but are
filtered out).

### Settings (`/settings`)

- **Tracked project** — re-point the board at another repo. The path is
  validated as a git repo; the daemon re-points and re-backfills on save.
- **Worktree removal command** — the command run by the Completed worktrees
  view (below). Stored in `board-settings.json` (separate from `project.conf`,
  so bootstrap never clobbers it).

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
2. **Runs your command.** The configured removal command (see Settings) runs via
   `zsh`, with `~/.zprofile` and `~/.zshrc` sourced first and the command itself
   `eval`'d — so your PATH, aliases, and shell functions resolve just like in a
   terminal. Placeholders `{{path}}` / `{{identifier}}` / `{{title}}` are
   substituted (also exposed as `$KS_WORKTREE` / `$KS_IDENTIFIER` / `$KS_TITLE`),
   and `{{path}}` is that row's worktree.
3. **Streams output.** stdout/stderr stream live into a bottom-right panel; on
   success the row is hidden and the board refreshes, on failure the error
   stays in the panel.

> The removal command is arbitrary shell authored by you and run on localhost —
> a single-user trust boundary. If no command is set, Remove prompts you to set
> one in Settings.

## Notifications

Three hooks fire a `terminal-notifier` notification the moment a session in the tracked project blocks: the two blocking tools (`AskUserQuestion`, `ExitPlanMode`) and the two blocking hook events (`PermissionRequest`, `Elicitation`). Notifications are daemon-independent and throttled per session.

## Development

```bash
claude plugin validate ./plugins/ks-flow
claude --plugin-dir ./plugins/ks-flow      # load locally
```

See `docs/IMPLEMENTATION_PLAN.md` for the full design.
