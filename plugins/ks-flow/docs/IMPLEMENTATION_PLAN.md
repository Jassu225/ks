# ks-flow — Claude Code Session Kanban + Waiting Notifications

## Context

The user runs many concurrent Claude Code sessions (heavy git-worktree user on macOS) and has no single place to see them. Claude Code writes every session as an append-only JSONL transcript under `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, but has no "status" concept and deletes transcripts after ~30 days. The user wants:

1. A **local Kanban board** of the project's work, backed by a durable archive that outlives the 30-day cleanup. **Columns are the workflow phases defined per project, not hard-coded statuses** — they come from the ks workflow `state.yaml` (`phases[]`) and differ by workflow type (ticket vs project) and can change per project. Cards are work-units (tickets/projects), each sitting in the column of its current phase; Claude sessions are joined to a card by worktree and contribute live activity + waiting state.
2. **macOS notifications** the moment a session blocks waiting for the user — i.e. the two blocking tools (`AskUserQuestion`, `ExitPlanMode`) and the two blocking hook events (`PermissionRequest`, `Elicitation`).

It must be **read-only** w.r.t. Claude Code for v1 (observe + notify; never launch/resume), but the schema/API should not preclude a control surface later. Delivered as a **Claude Code plugin** named `ks-flow`.

**Scope is one project, not the whole machine.** At enable time the plugin asks for a **project path** (the main worktree / repo root). It then tracks **only** sessions whose working directory belongs to that project **or any of its git worktrees** — every other session on the machine is ignored. The plugin is installed at **user scope** (so its hooks can fire in any session regardless of how it was launched), but both the ingester and the hook scripts apply a **runtime project filter** keyed off the project's shared git-common-dir, so only in-project sessions are recorded or notified.

This plan reflects the official plugin docs (code.claude.com/docs/en/plugins, /plugins-reference, /hooks) — not just mirroring the existing `plugins/ks`.

## Why a plugin (and what the docs gave us)

- **Plugin hooks at user scope fire in every session**, including plain `claude`. This replaces manually merging into `~/.claude/settings.json`. Project scoping is then applied at runtime inside the hook/ingester (a hook can't be limited to one project tree by config alone).
- **`${CLAUDE_PLUGIN_DATA}`** is the persistent state dir that survives updates → home for the SQLite DB, `events.jsonl`, and installed `node_modules`. Its location is **derived from the project's git-common-dir** (`~/.claude/plugins/data/ks-flow/<encoded-common-dir>/`, resolved by `src/lib/datadir.mjs`; override with `KS_FLOW_DATA`) so it is independent of how the plugin was loaded — the launchd plist exports this derived path as `CLAUDE_PLUGIN_DATA` to the daemon/board, and the hooks derive the same path themselves. **`${CLAUDE_PLUGIN_ROOT}`** is ephemeral (recycled ~7 days post-update) → only for referencing bundled scripts, never for state. Both are exported as env vars to hook processes.
- **`bin/`** executables are auto-added to PATH while enabled → home for a `ks-flow` CLI.
- **`userConfig`** prompts the user at enable time and exposes values as `${user_config.*}` / `CLAUDE_PLUGIN_OPTION_*` → replaces the ks-style `.env`/`.config` + manual `init`.
- **`SessionStart` hook** + the documented `diff`-the-manifest pattern installs `node_modules` into `${CLAUDE_PLUGIN_DATA}` on first run / dependency change, and idempotently bootstraps the launchd agent.

## Architecture

```
project_path (userConfig) ─► PROJECT_COMMON_DIR = git -C <project> rev-parse --git-common-dir
                             worktrees = git -C <project> worktree list  → encoded projects/ dirs
                                          │
~/.claude/projects/<in-project dirs>/<sessionId>.jsonl ──┐  (only watched worktree dirs; per-file cwd membership check)
                                          │  chokidar → byte-offset tail → parse complete lines
                                          ▼
   plugin hooks (user scope, hooks.json)  ingester daemon (launchd, always-on)
   PreToolUse[AskUserQuestion|ExitPlanMode]   │  FILTER: keep iff session cwd's common-dir == PROJECT_COMMON_DIR
   PermissionRequest, Elicitation             │  derive status, batch upsert
        │ FILTER on .cwd (skip out-of-project) │       │
        │ terminal-notifier (instant)          │       ▼
        │ append → $CLAUDE_PLUGIN_DATA/events.jsonl ─►  Store layer (interface)
        ▼                                      ▲        └─► Firestore (firebase-admin)
   (notification, daemon-independent)          │              projects/{projectId}/sessions/{id}
   local checkpoints (offsets/inode) ──────────┘                       │ onSnapshot (real-time)
   in $CLAUDE_PLUGIN_DATA/checkpoints.json                             ▼
                                       Next.js board (bin/ks-flow open) — realtime via provider.source()
                                       COLUMNS = project phaseModel (from state.yaml) — not hard-coded
                                       cards = work-units in currentPhase; waiting/PR badges from sessions

<main_worktree>/workflow/<user>/**/state.yaml ─► daemon (yaml parse) ─► WorkUnitDoc + project.phaseModel
                                                  join worktree_dir ↔ session cwd ─► waiting badge on card
```

Role separations: **writer** = ingester daemon (the only Firestore writer, via the Store layer); **hook scripts** = notify + append local events (never touch Firestore); **reader** = Next.js board (subscribes to Firestore in real time, never writes). **Ingestion bookkeeping** (byte offsets, inode, residual) stays in a **local** `checkpoints.json` in `${CLAUDE_PLUGIN_DATA}` — it's per-line churn that must not incur cloud writes; only derived **session documents** go to Firestore. Everything is gated by the **project filter** below.

## Project scoping & worktree discovery (key behavior)

The plugin tracks exactly one project and all of its worktrees, nothing else.

- **Membership key = shared git-common-dir.** All worktrees of a repo share one common git dir. At bootstrap, resolve `PROJECT_COMMON_DIR = realpath(git -C <project_path> rev-parse --git-common-dir)` and persist it to `$CLAUDE_PLUGIN_DATA/project.conf` (alongside `project_path`). A session belongs to the project iff `realpath(git -C <session.cwd> rev-parse --git-common-dir) == PROJECT_COMMON_DIR`.
- **Which `projects/` dirs to watch.** `~/.claude/projects/<dir>` names are the session `cwd` with `/`→`-` encoding, so they can't be reverse-decoded reliably. Two-pronged discovery:
  1. **Worktree enumeration (fast path):** `git -C <project_path> worktree list --porcelain` → every current worktree absolute path → encode each (`/`→`-`, leading `-`) → the set of `projects/` dirs to watch directly. Re-run on an interval (e.g. 60s) and on FS events so newly-created worktrees are picked up.
  2. **Per-file cwd check (correctness backstop):** for any candidate `*.jsonl`, read the first `user`/`assistant` line to get `cwd`, compute its common-dir, keep the file only if it matches `PROJECT_COMMON_DIR`. This catches worktrees created/removed between enumerations and is the authority when the encoded-name guess is ambiguous. The decision is stable per file (a file's `cwd` never changes), so cache it (the session doc's `inProject` flag + local checkpoint) and skip re-checking.
- **Deleted/moved worktrees:** if `git -C <cwd>` fails (cwd gone after a worktree was removed), fall back to **path-prefix** match against the known worktree paths recorded at the last successful enumeration, or against `dirname(PROJECT_COMMON_DIR)`. Sessions already stored keep their `worktreePath`/lane; they aren't re-evaluated.
- **Hook-side filter:** the `PreToolUse`/`PermissionRequest`/`Elicitation` scripts read `.cwd` from the stdin payload, compute its common-dir (cheap; cache a resolved-cwd→commondir map under `$CLAUDE_PLUGIN_DATA/cwdcache/`), and **exit 0 immediately without notifying or appending** if it ≠ `PROJECT_COMMON_DIR`. So a notification only ever fires for an in-project session.
- **Multiple projects = multiple installs/configs** is out of scope for v1 (single `project_path`); the per-project `projects/{projectId}` collection tree already generalizes to many projects later.

(Alternative considered: installing the plugin at **project scope** in the repo's `.claude/settings.json` so hooks only load inside the project tree. Rejected for v1 because worktrees are separate dirs, the always-on daemon must run independent of any session, and the runtime cwd-filter works regardless of launch method. Noted for future consideration.)

## Workflow state model — project-defined columns (the second ingest source)

Board columns are **not** hard-coded. They are the ks workflow **phases**, which live in `state.yaml` files and vary by workflow type and project.

- **Source.** Each work-unit has a `state.yaml` at `<main_worktree>/workflow/<username>/<tickets|projects>/<slug>/state.yaml` (the workflow dir lives in the main worktree; its `worktree_dir` field points to the code worktree). Schema refs: `~/.claude/plugins/ks/scripts/{ticket,project}-state.schema.json`. Shape (verified):
  ```yaml
  worktree_dir: "…/karmasuite-worktree/jaswanth/kar-12261-…"
  ticket|project: { identifier, name, url, status:{name}, priority, estimate, parent_project, … }
  slack: { … }   # thread refs incl. pr_review_threads[].pr_url
  phases:
    - { number, name, status, started_at, ended_at, iterations?:[{started_at,ended_at}] }
  ```
  `PhaseStatus = NOT_STARTED | IN_PROGRESS | COMPLETED | SKIPPED` (+ runtime `REVISITING`, `INVALIDATED`). Ticket phases observed: 0 ticket-initialization, 1 context-creation, 2 codebase-research, 9 implementation-plan-creation, 10 implementation. Project phases: 0…10. Only reached phases are written, so the array grows over time.
- **`phaseModel` (the column set), stored project-level, mutable per project.** The daemon computes the project's ordered column list as the **union of `{number,name}` across all the project's `state.yaml` phases**, ordered by `number`, seeded by the type template (ticket vs project — detected via the schema ref or `tickets/` vs `projects/` path) so unreached phases still render as empty columns. It is persisted on the `projects/{projectId}` doc as `phaseModel:[{number,name}]` and re-derived as new phases appear → columns change with the project, never hard-coded. The board renders one column per `phaseModel` entry, in order.
- **Card = work-unit; column = current phase.** `currentPhase` = the `IN_PROGRESS` phase, else the highest-numbered non-`SKIPPED`/non-`NOT_STARTED` phase (furthest progress); `REVISITING` takes precedence as the active column. A card carries its Linear `status`, `priority`, `estimate`, PR (from `slack.pr_review_threads[].pr_url` and/or session `pr-link`), and `worktree_dir`.
- **Join to sessions.** A work-unit's `worktree_dir` (expanded `~`) is matched against session `cwd`/`worktreePath`; the unit aggregates its sessions' **live waiting state** (the AskUserQuestion/ExitPlanMode/permission overlay) and `lastActivity`. So "this card is blocked waiting on you" is a badge driven by the session layer, while the card's **column** is driven by the phase layer.
- **Discovery.** The daemon also watches `<main_worktree>/workflow/<username>/**/state.yaml` (chokidar) and re-parses on change. `username` from `userConfig.workflow_user` (default: the `whoami.username` found in any state.yaml, else `git config user.name`-derived). A work-unit with no live session still shows as a card in its phase column (the phase layer is independent of session existence).

## Plugin layout (`plugins/ks-flow/`)

```
plugins/ks-flow/
  .claude-plugin/plugin.json     # name, version, description, author, userConfig, defaultEnabled:false
  hooks/hooks.json               # PreToolUse(AskUserQuestion|ExitPlanMode), PermissionRequest, Elicitation, SessionStart(bootstrap)
  bin/ks-flow                    # CLI on PATH: open|status|daemon|install-daemon|stop
  scripts/
    notify-waiting.sh            # hook: terminal-notifier + append event line   (uses ${CLAUDE_PLUGIN_ROOT}/_common.sh)
    notify-permission.sh
    notify-elicitation.sh
    bootstrap.sh                 # SessionStart: node_modules diff-install + launchd ensure-running (idempotent)
    _common.sh                   # jq parse, per-session throttle, terminal-notifier -group
  launchd/com.ksflow.ingester.plist.tmpl   # rendered by bootstrap.sh with abs node path + daemon entry
  src/                           # TypeScript (built to dist/ at install via bootstrap)
    package.json                 # type:module; deps: firebase-admin, chokidar, yaml; build: tsc
    tsconfig.json                # ES2022/ESNext/strict, outDir dist  (mirror plugins/ks/scripts/tsconfig.json)
    daemon.ts                    # entry: backfill → chokidar watch (sessions + events.jsonl + workflow/**/state.yaml) → ingest → store
    lib/
      paths.ts                   # CLAUDE_PROJECTS_DIR, DATA_DIR=$CLAUDE_PLUGIN_DATA, EVENTS_PATH, CHECKPOINTS_PATH, workflowDir()
      db/types.ts                # ProjectDoc / WorkUnitDoc / SessionDoc + SessionWriter / SessionSource / DbProvider — the stable seam
      db/index.ts                # factory: select provider by db_provider config (auto-resolved)
      db/providers/pocketbase.ts # default provider (local PocketBase server: REST writer + SSE source)
      db/providers/firestore.ts  # cloud/emulator provider (admin writer + client-SDK source)
      db/providers/{file,sqlite}.ts  # future provider slots (stubs/docs)
      checkpoints.ts             # local byte_offset/inode persistence (checkpoints.json)
      jsonl.ts                   # readRange + residual buffer + per-line JSON.parse guard
      stateyaml.ts               # parse state.yaml (yaml lib), map → WorkUnitDoc, expand worktree_dir ~
      phasemodel.ts              # derive ordered phaseModel (union of phases + type template); currentPhase()
      derive.ts                  # applyLine() accumulator + resolveWaiting()  ← session waiting/activity overlay
      join.ts                    # match session.cwd↔worktreeDir; aggregate session waiting → unit.waiting
      worktree.ts                # commonDir(cwd) via `git -C <cwd> rev-parse --git-common-dir`, ENOENT-safe; worktreePath
  web/                           # Next.js App Router + Tailwind (read-only, realtime board)
    app/page.tsx                 # Board: columns + per-worktree swimlanes
    lib/useSessions.ts           # hook → DbProvider.source().subscribe(); board never imports a provider directly
    components/{Board,Column,Swimlane,SessionCard}.tsx
  README.md
```
Add a `ks-flow` entry to repo-root `/Users/jassu/git/ks/.claude-plugin/marketplace.json` (`source: "./plugins/ks-flow"`).

## Empirical ground truth (verified on this machine)

- One file per session, filename == `sessionId`, **append-only** across resumes. Subagents live at `<sessionId>/subagents/agent-*.jsonl` — excluded structurally by the depth-1 glob `projects/*/*.jsonl`.
- `message.content` is **sometimes a string, sometimes an array** — every access must guard `Array.isArray` or the parser throws and a session sticks "waiting" forever.
- **Last activity = last line that HAS a `timestamp`**, not the last physical line (trailing meta lines `ai-title`/`mode`/`permission-mode`/`pr-link` etc. often have none) and **not** file mtime (harness writes mtime later).
- Title from the last **`aiTitle`** record (key is `aiTitle`).
- `cwd`/`gitBranch` present on every `user`/`assistant` line; null on meta lines.
- **`pr-link`** records (`{prNumber, prUrl, prRepository, timestamp}`) already exist in the JSONL → v1 "has PR" badge with zero `gh` calls.
- `AskUserQuestion`/`ExitPlanMode` appear as `tool_use` blocks; resolved (approve **and** reject both) by a later `user` line with `content[].type=="tool_result"` and matching `tool_use_id`.
- Scale ~617 files / 42 dirs / ~102K lines — small.

## Waiting + activity overlay (the load-bearing session logic, `derive.ts`)

Columns come from `state.yaml` phases (above). This layer only computes the **waiting badge** and **activity recency** that decorate a card. JSONL is the **source of truth**; `events.jsonl` is an **enrichment overlay**, never a second authority.

- Maintain per-session **open-ask set** (`openAsks`): on assistant `tool_use` with name ∈ {AskUserQuestion, ExitPlanMode}, add `(toolUseId, tool, since)`. On any line, for each `content[]` block (guard `Array.isArray`) with `type=="tool_result"`, remove its `tool_use_id`. **Never clear on "any newer line"** for asks — only the matching `tool_result` clears (a later thinking/meta line in the same turn must not clear a real wait).
- **Overlay waits** (`overlayWaits`) for PermissionRequest/Elicitation, which are *not* visible in the transcript: the hook writes `{ts, sessionId, kind, id, cwd}` to `events.jsonl`. These clear when **any JSONL line with timestamp > overlay.since** is ingested for that session (forward progress = the human responded — the one place "newer line clears" is correct), **or** a TTL (default 10 min) expires. AskUserQuestion/ExitPlanMode event lines are ignored for state (their JSONL `tool_use` already governs) — no double-count because they carry no `tool_use_id`.
- **`resolveWaiting(session)`** (computed each upsert): `waiting = openAsks non-empty || any uncleared overlayWait`; `waitingTool` = oldest open ask else Permission/Elicitation; `activity = (now - lastActivity > IDLE_THRESHOLD) ? "idle" : "active"`. Idempotent under replay (re-ingest from offset 0 reproduces the sets → safe crash recovery).
- **Aggregate to the card:** after a session upsert, recompute its work-unit's `waiting` = OR of its sessions' waiting (carry the blocking `tool`/`since`/`sessionId`), so the board shows a "waiting on you" badge on the card regardless of which session blocked.

## Ingester read loop (`daemon.ts`, single-flight per path)

```
on chokidar add|change(path): enqueue(path)        # dedupe by path
processFile(path):
  cp = checkpoints[path]                            # local: byte_offset, file_size, inode
  st = stat(path)                                   # ENOENT → store.markArchived(sessionId), return
  start = cp?.byteOffset ?? 0
  if cp && (st.ino != cp.inode || st.size < cp.byteOffset):
      start = 0; resetDerived(sessionId)            # truncate/replace → idempotent replay
  if st.size == start: return
  data = residual[path] + readRange(path, start, st.size)
  nl = data.lastIndexOf('\n'); if nl<0: residual[path]=data; return
  complete = data.slice(0,nl); residual[path]=data.slice(nl+1)
  newOffset = start + byteLength(complete)+1        # newline-aligned only
  for line in complete.split('\n'): try applyLine(JSON.parse(line)) catch: continue
  checkpoints[path] = {byteOffset:newOffset, fileSize:st.size, inode:st.ino}  # local, sync
  scheduleFlush(sessionId, acc)                     # debounced ~1s → store.upsertSession(projectId, doc)
```
`applyLine` also runs the **project filter**: the first message line's `cwd` decides `inProject` (common-dir match); non-matching files are flagged out-of-project (local checkpoint) and skipped for all further work — never written to Firestore. Startup **backfill sweep** scans only the worktree-enumerated `projects/` dirs (plus a cwd-check pass) and reconciles against stored `(size,inode)` through the same queue (second pass is a no-op once offset==EOF). A periodic (~60s) **worktree re-enumeration** adds watches for newly-created worktrees. chokidar `awaitWriteFinish:false`; `KS_FLOW_POLL` escape hatch for polling FS. Also watch `events.jsonl` for overlay events. Residual buffers are in-memory; restart re-reads from the persisted newline-aligned offset (no loss).

## Hooks (`hooks/hooks.json`, user-scope = global)

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "AskUserQuestion|ExitPlanMode",
        "hooks": [{ "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}\"/scripts/notify-waiting.sh", "timeout": 5 }] }
    ],
    "PermissionRequest": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}\"/scripts/notify-permission.sh", "timeout": 5 }] }
    ],
    "Elicitation": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}\"/scripts/notify-elicitation.sh", "timeout": 5 }] }
    ],
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}\"/scripts/bootstrap.sh", "timeout": 120 }] }
    ]
  }
}
```
Each notify script (bash + jq): read stdin JSON → `cwd`, `session_id`; **project filter first** — compute `cwd`'s common-dir (cached under `$CLAUDE_PLUGIN_DATA/cwdcache/`), and `exit 0` immediately if it ≠ `PROJECT_COMMON_DIR` from `project.conf` (no notify, no append). If in-project: throttle via `$CLAUDE_PLUGIN_DATA/notify-state/<sid>` (suppress if notified within `${user_config.notify_throttle_sec}`); append one event line to `$CLAUDE_PLUGIN_DATA/events.jsonl`; fire `terminal-notifier -group <sid> ... &` (backgrounded — never blocks the tool); **exit 0 with no `permissionDecision`** (purely observational). Tight matcher means 99% of Bash/Edit/Read tool calls never invoke the hook. No infinite-loop risk (daemon/Next are not Claude sessions, so they emit no PreToolUse).

## Daemon lifecycle (always-on, auto-bootstrapped)

`bootstrap.sh` (SessionStart): (1) resolve `PROJECT_COMMON_DIR` from `${user_config.project_path}` and write `$CLAUDE_PLUGIN_DATA/project.conf` (skip rest early if `project_path` unset); (2) `diff` bundled `src/package.json` vs the copy in `$CLAUDE_PLUGIN_DATA`; on mismatch `cp` + `npm install` + `tsc` into `$CLAUDE_PLUGIN_DATA` (documented pattern); (3) render `launchd/com.ksflow.ingester.plist.tmpl` with `$(command -v node)` and the built `daemon.js` path → `~/Library/LaunchAgents/com.ksflow.ingester.plist`; (4) idempotent `launchctl bootstrap gui/$UID …` / `enable` so the daemon runs 24/7 and restarts at login (`KeepAlive`). `bin/ks-flow install-daemon|stop|set-project <path>` expose manual control. Daemon observes even with no session open → best capture before 30-day deletion (scoped to the project's worktrees).

## Next.js UI (read-only, realtime via provider)

- `lib/useSessions.ts`: a hook that calls `DbProvider.source().subscribe(projectId, onChange)` and returns the live session list. The board components are **provider-agnostic** — they never import Firestore. Swapping `db_provider` changes only what `subscribe` does under the hood.
- For the **Firestore** provider, `subscribe` wraps `onSnapshot(query(collection('projects/{projectId}/sessions'), where('inProject','==',true)))` → live per-doc deltas, no flicker, no SSE/polling. For a future **file/sqlite** provider, `subscribe` polls a provider-owned Next route. `projectId` from `project.conf`/env.
- Board: **columns rendered dynamically from `projects/{projectId}.phaseModel`** (one per phase, in `number` order) — not hard-coded. Cards = `workUnits`, each in its `currentPhase` column, showing identifier/title, Linear status, priority, a **PR badge**, and a **"waiting on you" badge** when `waiting.active` (driven by the session overlay). Optional swimlane by `type` (tickets vs projects) — togglable, default off. `bin/ks-flow open` runs `next start` (port `${user_config.board_port}`, default 4317) and opens the browser; project name/path in the header.
- (If browser-exposed Firestore is undesirable, the Firestore provider's `source` can instead run server-side via admin SDK + SSE behind the same `SessionSource` interface — deferred unless required.)

## Database provider abstraction (provider-agnostic) + Firestore as first impl

Persistence sits behind a **first-class, provider-agnostic DB interface** so the backing store can be swapped (Firestore now; a file DB or SQLite later) without touching ingestion, derivation, hooks, or the board components. Firestore is just the first implementation of the contract.

The contract is split by **role**, because writes happen in the Node daemon and reads/real-time happen in the browser board — a provider supplies whichever halves its runtime allows:

```ts
// lib/db/types.ts — the stable seam (no provider imports here)
export interface SessionWriter {            // daemon (Node) side
  upsertSession(projectId: string, doc: SessionDoc): Promise<void>;
  upsertMany(projectId: string, docs: SessionDoc[]): Promise<void>;   // batched (backfill)
  markArchived(projectId: string, id: string): Promise<void>;
  close?(): Promise<void>;
}
export interface SessionSource {            // board (UI) side
  getSessions(projectId: string): Promise<SessionDoc[]>;
  subscribe(projectId: string, onChange: (docs: SessionDoc[]) => void): Unsubscribe;  // real-time
}
export interface DbProvider { name: string; writer(): SessionWriter; source(): SessionSource; }

// lib/db/index.ts — factory: selects provider by config (db_provider, auto-resolved), returns DbProvider
// lib/db/providers/pocketbase.ts — default impl: writer = REST (pocketbase SDK); source = SSE subscribe; daemon spawns the local PocketBase server
// lib/db/providers/firestore.ts — cloud/emulator impl: writer = firebase-admin; source = client SDK onSnapshot
// (future) lib/db/providers/file.ts   — writer = atomic JSON writes in $CLAUDE_PLUGIN_DATA; source = fs.watch via a tiny local read endpoint
// (future) lib/db/providers/sqlite.ts — writer = better-sqlite3 (WAL); source = Next route + light poll
```
The daemon imports only `SessionWriter`; the board imports only `SessionSource`. `derive.ts`/`jsonl.ts`/hooks never import any provider. Each provider lives in exactly one file under `lib/db/providers/` and is the only module aware of its backend. Adding a provider = implement the two interfaces + register in the factory; nothing else changes.

**Runtime note:** providers may split impls by environment — e.g. Firestore's `writer` is admin-SDK (Node only) and its `source` is the client SDK (browser). A future file/SQLite provider, whose data is local, supplies a `source` backed by a small Next route (browser can't read local disk directly); that route is part of the provider, not the board.

The provider-agnostic records (`ProjectDoc`, `WorkUnitDoc`, `SessionDoc`) map, in the **Firestore provider**, to one collection tree scoped per project so cross-project data never mixes:
```
projects/{projectId}                       # projectId = stable hash of PROJECT_COMMON_DIR
  ├─ (fields) projectPath, commonDir, workflowType,
  │           phaseModel: [ { number, name } ],          # the ORDERED COLUMN SET (mutable, project-defined)
  │           updatedAt
  ├─ workUnits/{unitId}                     # unitId = ticket identifier (KAR-####) or project slug → the CARDS
  │    type: "ticket"|"project", identifier, title, linearStatus, priority, estimate,
  │    worktreeDir, stateYamlPath,
  │    phases: [ { number, name, status, startedAt, endedAt, iterations? } ],
  │    currentPhase: { number, name },                   # derived → which column the card sits in
  │    pr: { number, url, repo } | null, slack: { … },
  │    waiting: { active: bool, tool, since, sessionId } | null,   # overlay aggregated from joined sessions
  │    sessionIds: [ … ], lastActivity, updatedAt
  └─ sessions/{sessionId}                   # JSONL-derived activity, joined to a unit by worktree
       sessionId, unitId, title, cwd, gitBranch, worktreePath,
       projectDir, filePath, firstActivity, lastActivity, # lastActivity = last line WITH a timestamp
       userMsgs, assistantMsgs, version, entrypoint,
       activity: "active"|"idle",                         # recency only — NOT a column
       waitingSince, waitingTool,
       pr: { number, url, repo } | null,
       openAsks:     [ { toolUseId, tool, since } ],       # embedded — JSONL-derived waits
       overlayWaits: [ { overlayId, kind, since, cleared } ], # permission/elicitation overlay
       inProject: true, archived: false, updatedAt
```
- **Columns come from `projects/{projectId}.phaseModel`**, never from a hard-coded enum. Cards are `workUnits`, placed in the column matching `currentPhase`. A session's `activity` (active/idle by recency) and `waiting*` are surfaced as **badges** on the parent card, not as columns.
- **Embed `openAsks`/`overlayWaits` as arrays on the session doc** (not subcollections): counts are tiny and the whole waiting state must update atomically in one doc write. `resolveWaiting` (the former `resolveStatus`, now just the waiting/activity overlay — phase/column comes from `state.yaml`) runs in the daemon and writes the materialized session fields + arrays together, then recomputes the parent unit's aggregated `waiting`.
- **Write discipline (cost + rate control):** the daemon never writes per JSONL line. Backfill accumulates each session in memory → one `upsertMany` using Firestore `WriteBatch` (≤500 ops/commit → chunk). Live tailing **debounces** per-session writes (~1s) so a burst of appended lines collapses into one doc update. Byte offsets/inode live only in local `checkpoints.json`.
- **No `meta.rev`, no SSE, no polling.** Real-time is Firestore-native: the board attaches `onSnapshot` to `projects/{projectId}/sessions where inProject==true` and patches cards live.
- **Deployment modes:** *cloud* (a real Firestore project — a durable archive that trivially outlives the 30-day transcript cleanup) or *local-only* (`firebase emulators:start --only firestore`, optionally under launchd) for a no-cloud setup. Chosen via config.
- **Security:** the daemon authenticates with the Firebase **Admin SDK** via a service-account key (path in `userConfig`, stored sensitive). The board reads with the **client SDK** under Firestore **security rules** restricting reads to the signed-in owner (or, in emulator/local mode, open rules on localhost). No write path is exposed to the browser.

## userConfig (plugin.json, prompted at enable)

- **`project_path`** (`directory`, **required**) — the main worktree / repo root to track. Bootstrap resolves its git-common-dir → `PROJECT_COMMON_DIR` and writes `$CLAUDE_PLUGIN_DATA/project.conf`. The workflow dir (`<project_path>/workflow/<workflow_user>/`) is watched for `state.yaml` files.
- **`workflow_user`** (`string`, optional) — the `workflow/<username>/` segment; defaults to the `whoami.username` found in a state.yaml, else derived from git config.
- **`db_provider`** (`string`, auto-resolved) — selects the DB provider. Blank ⇒ `pocketbase` (zero-config local default) unless a cloud Firestore project is configured ⇒ `firestore`. Set explicitly to `pocketbase`/`firestore` to force; `file`/`sqlite` are documented future slots. The daemon and board resolve this identically.
- **`pocketbase_port`** (`number`, default `8090`) — localhost port for the bundled PocketBase server (downloaded by bootstrap; the daemon spawns it). Only used when `db_provider=pocketbase`.
- **`firestore_mode`** (`string`, default `"emulator"`) — `"cloud"` or `"emulator"` (local-only, no GCP). Only used when `db_provider=firestore`.
- **`gcp_project_id`** (`string`, required when `cloud`) — Firestore/Firebase project id.
- **`firestore_credentials`** (`file`, `sensitive`, required when `cloud`) — path to the Admin SDK service-account JSON (daemon writer).
- **`firebase_web_config`** (`string`, `sensitive`, required when `cloud`) — client SDK config JSON for the board reader.
- `idle_minutes` (number, default 30), `notify_throttle_sec` (number, default 20), `board_port` (number, default 4317).

Consumed in hooks via `${user_config.*}`/env and in the daemon/Next via `CLAUDE_PLUGIN_OPTION_*`. Changing `project_path` later (re-enable / `ks-flow set-project <path>`) rewrites `project.conf` and triggers a fresh backfill scoped to the new project.

## Reuse / mirror

- tsconfig/package conventions + `yaml` dep: `/Users/jassu/git/ks/plugins/ks/scripts/{tsconfig.json,package.json}`.
- `state.yaml` shape, `Phase`/`PhaseStatus` types, and phase templates: `/Users/jassu/git/ks/plugins/ks/scripts/{ks-start-ticket.ts,ks-start-project.ts,lib/workflow-types.ts}` and schemas `~/.claude/plugins/ks/scripts/{ticket,project}-state.schema.json`. Sample: `~/karmasuite/karmasuite/workflow/jaswanth/tickets/<id>/state.yaml`.
- Hook stdin-via-jq + exit-code pattern: `/Users/jassu/git/ks/plugins/ks/scripts/protect-neon-branch.sh`.
- Existing plugin manifest + marketplace entry shape: `/Users/jassu/git/ks/plugins/ks/.claude-plugin/plugin.json`, `/Users/jassu/git/ks/.claude-plugin/marketplace.json`.

## Verification (end-to-end)

1. **Build/install (dev):** `claude --plugin-dir ./plugins/ks-flow`; confirm `claude plugin validate ./plugins/ks-flow` passes and `/plugin` lists `ks-flow`. Start a session → `bootstrap.sh` installs node_modules into `${CLAUDE_PLUGIN_DATA}` and starts the launchd daemon (`launchctl list | grep ksflow`).
2. **Project filter + backfill:** with `firestore_mode=emulator`, `firebase emulators:start --only firestore` running, set `project_path` to a real repo (e.g. the karmasuite main worktree); daemon log shows only that project's sessions ingested, out-of-project dirs skipped; the emulator UI (or a small admin-SDK query) shows `projects/{projectId}/sessions` count matching the project and excluding unrelated projects (e.g. `git-ks`, `ever-unfolding-love`). Titles populated from `aiTitle`. Confirm writes are **batched** (not one-per-line) in the emulator request log.
3. **Phase columns (project-defined):** daemon parses the project's `workflow/<user>/{tickets,projects}/*/state.yaml`; `projects/{projectId}.phaseModel` equals the ordered union of phases (e.g. ticket: 0,1,2,9,10) — confirm it differs for a ticket-type vs project-type workflow and is **not** a hard-coded list. Board renders exactly those columns in order.
4. **Cards in phase columns:** `ks-flow open` → each work-unit appears as a card in its `currentPhase` column (e.g. KAR-12261 with phase 10 `COMPLETED` lands in the implementation column); editing a `state.yaml` phase to `IN_PROGRESS` moves the card live (onSnapshot). Card shows Linear status, priority, PR badge.
5. **Waiting badge + notify (live):** in a session whose cwd is one of the project's worktrees, trigger `AskUserQuestion` (or enter/exit plan mode) → macOS notification fires within ~1s and the parent card gets a **"waiting on you"** badge (`waiting.tool` correct); answer → `tool_result` ingested → badge clears. A `PermissionRequest` sets an overlay wait, cleared on next activity/TTL. A session in a non-project worktree triggers **no** notification.
6. **Edge:** a session whose `message.content` is a bare string still ingests (no crash); a work-unit with no live session still shows as a card in its phase column; `pr-link` / `slack.pr_review_threads` populate the PR badge.
7. **Real-time + recovery:** board updates live via `onSnapshot` as the daemon writes (no manual refresh); kill+restart daemon → resumes from `checkpoints.json` offsets, re-derives identical docs (idempotent), no dup/missed sessions in Firestore.

## v1 scope vs deferred

**Build:** ingester daemon (session JSONL backfill+tail + `state.yaml` parse + join), **project-defined `phaseModel` columns** from `state.yaml`, **DB provider abstraction (`SessionWriter`/`SessionSource`/`DbProvider`, with `ProjectDoc`/`WorkUnitDoc`/`SessionDoc`) + Firestore provider** (emulator + cloud), local `checkpoints.json`, three notify hooks + SessionStart bootstrap, launchd auto-start, provider-agnostic Next board (dynamic phase columns + work-unit cards + waiting/PR badges, realtime via `source().subscribe`), `bin/ks-flow` CLI, marketplace entry, README.

**Defer (v2):** additional DB providers behind the interface (`file`, `sqlite`); real "PR merged" state via `gh pr view` polling; REVISITING/INVALIDATED visual cascade; archived-unit hiding/cleanup UI; subagent drill-down; search/filter; multi-project boards; control surface (launch/resume from card — would add an MCP server via `.mcp.json`); admin-SDK+SSE fallback if browser Firestore is undesirable; n8n push; analytics/time-in-phase.

## Top failure modes (mitigations baked in above)

1. string-vs-array `content` → `Array.isArray` guard + per-line try/catch.
2. last-activity from a timestamp-less trailing line / mtime → only accept timestamps from lines that carry them.
3. overlay waits never clearing → clear on newer timestamp + TTL.
4. offset drift on truncate/crash → inode+size reconciliation + newline-aligned offsets + idempotent replay.
5. Firestore write cost/rate blowup on backfill → in-memory accumulate + `WriteBatch` (≤500/commit) + ~1s per-session debounce on live tailing; offsets stay local (no per-line cloud writes).
6. Firestore unreachable / creds invalid → daemon keeps local `checkpoints.json` advancing and **buffers pending session docs to a local queue**, flushing when connectivity returns (no data loss; notifications are independent and still fire). Emulator mode removes the cloud dependency entirely.
7. Browser-exposed Firestore creds → lock down with security rules (owner-only) + sensitive `userConfig` storage; admin-SDK+SSE fallback path noted if exposure is unacceptable.
8. malformed/partial `state.yaml` (mid-write by ks) → parse in try/catch, keep last good `WorkUnitDoc`, retry on next change event; never crash the daemon.
9. `worktree_dir` not matching any session `cwd` (e.g. `~` not expanded, or worktree moved) → expand `~`/`realpath` both sides before compare; a unmatched unit still renders as a card (just no live session badge).
10. phase model drift (new phase appears) → `phaseModel` re-derived as union on each `state.yaml` change, so a new column appears automatically; ordering by `number` keeps columns stable.
11. terminal-notifier blocking a tool call → backgrounded + 5s hook timeout + tight matcher.
12. first-install racing 30-day deletion of very old sessions → those are already gone; archive captures what exists at install (documented limitation).
