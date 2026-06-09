---
date: 2026-06-08T22:57:19+05:30
git_commit: 185259a
branch: feat/ks-flow-plugin
task: ks-flow plugin — swapped local store to PocketBase, reworked the board UI/CLI, and fixed phase-accuracy + deploy bugs. Verified live; uncommitted.
---

# Handoff: ks-flow — PocketBase store + board/CLI overhaul

> Builds on the three earlier ks-flow handoffs (plan-approved → built → creds-env-refactor). This is the **delta** since `2026-06-08_16-31-02_ks-flow-creds-env-refactor.md`. Full design in `plugins/ks-flow/docs/IMPLEMENTATION_PLAN.md`; dev guidance in CLAUDE.md.

## What Happened

Big session. The local/default backing store was switched from a Firestore-emulator dependency to **PocketBase** (a single local Go binary, SQLite inside, REST + realtime SSE), and the board UI + `ks-flow` CLI were substantially reworked. Everything below was built, typechecks/builds clean, and the daemon→PocketBase→board path was **verified live** against the real `karmasuite` project (daemon running under launchd, 102 work-units + sessions ingested).

**PocketBase provider (new default).**
- `src/lib/db/providers/pocketbase.ts` — `PbWriter` (upsert via unique `key` field + in-memory id cache) + `PbSource` (getFullList + SSE subscribe). Full doc stored in a `data` json field; `projectKey`/`inProject` mirrored for filtering.
- `src/lib/pbserver.ts` — daemon spawns + health-waits (`/api/health`) + supervises PocketBase as a child (respawn on exit, SIGTERM on shutdown). One launchd agent, not two.
- `pocketbase/pb_migrations/1700000000_init_collections.js` — creates `projects`/`work_units`/`sessions`, **public API rules** (localhost single-user, no auth), unique `key` index. Verified valid against PB v0.39.2.
- `src/lib/config.ts` `resolveDbProvider`: explicit `db_provider` wins → else `firestore` iff cloud+`gcp_project_id` → else **`pocketbase`**. Daemon + board resolve identically. Added `pocketbasePort`/`pocketbaseUrl`.
- `db/index.ts` routes `pocketbase`. `plugin.json`: dropped `db_provider` default (blank ⇒ auto), added `pocketbase_port` (8090).
- bootstrap.sh: downloads pinned **PB v0.39.2** binary per OS/arch from GitHub releases into `$CLAUDE_PLUGIN_DATA/pocketbase/`, copies migrations, `superuser upsert` (random pass → `.env`), only when resolved provider = pocketbase.

**Board (web/).** Branching realtime in `useBoard.ts` (PocketBase getFullList+SSE subscribe vs Firestore onSnapshot). Full **dark mode** (slate-950) across all components + globals. New **settings page** (`/settings`) with a **native folder picker** (`/api/pick-folder` → `osascript choose folder` → absolute path) + git-validation route (`/api/project` → validates repo, derives common-dir/projectId, writes project.conf, runs bootstrap). **Kill button** (`/api/kill`). Backend badge in header.

**CLI verbs restructured** (`bin/ks-flow`): `start` (daemon up, falls back to project.conf for project_path, prints state + recent log), `open` (rebuilds board when source changed, waits for readiness, auto-opens default browser), `close` (UI only), `stop` (everything: UI + daemon + PB), `status` (all services). `init` script added (PATH wiring, idempotent).

**Daemon logging.** `daemon.log` now **truncates on every start** (daemon owns it via `createWriteStream('w')`; launchd `StandardOutPath` → `/dev/null`); PocketBase output funnels into it; timestamped. Same dir as `.env` (`$CLAUDE_PLUGIN_DATA/`).

**Two bugs fixed live (important):**
1. **Phase accuracy** — `workflow/` is gitignored, so each worktree holds its own progressed `state.yaml`; the main repo only has stale phase-0 stubs. Daemon now scans **all worktrees'** `workflow/<user>` dirs (`scanAllStateYaml`/`workflowRoots`) and **dedups each ticket to the most-advanced copy** (prefers live worktree). KAR-12259 went phase 0 → **phase 10**. Also: cards filtered to **live git worktrees** (`ProjectDoc.worktreePaths`) + not-done (`linearStatus`), collapsing 102 → ~10 visible; sessions collapsed to latest-per-path.
2. **Deploy gap** — bootstrap rebuilt `dist` but only restarted the daemon on a *plist* change, so code-only updates never took effect. Now `launchctl kickstart -k` on rebuild-with-unchanged-plist.

## Key Decisions Made

- **PocketBase over SQLite/NeDB/PouchDB/RxDB** — only true-realtime NoSQL-ish local option that's a single managed server (replaces the Firestore emulator). Cross-process daemon↔browser is solved by it being a central local server; PB's default CORS `*` confirmed, so the browser reads it directly (no Next proxy).
- **PB binary downloaded at bootstrap**, daemon-spawns-as-child (one launchd agent, guaranteed ordering), public collection rules (localhost single-user).
- **Live-worktree set authoritative for visibility** — PocketBase is upsert-only and never prunes, so 102 stale records linger; the board filters against `ProjectDoc.worktreePaths` so staleness can't leak through.
- **Most-advanced dedup** for phase, since each worktree carries a copy of every ticket's gitignored state.yaml.

## Deviations from Plan

- The plan's local-fallback slot was `sqlite` (and earlier this session I started building SQLite). Superseded by **PocketBase** at user request — better realtime + zero-config. `sqlite`/`file` remain documented future stubs. Firestore kept as the cloud provider.

## Uncommitted Changes

Everything still uncommitted on `feat/ks-flow-plugin` (nothing committed across any ks-flow session):
- `plugins/ks-flow/` — entire plugin (untracked), incl. new `pocketbase/pb_migrations/`, `src/lib/{pbserver,db/providers/pocketbase}.ts`, `web/app/{settings,api/{project,kill,pick-folder}}/`, reworked `bin/ks-flow`, `scripts/bootstrap.sh`, `init`.
- `.claude-plugin/marketplace.json` — modified (ks-flow entry).
- `docs/` + the 4 handoffs in `handoffs/` — untracked.
- `src/dist`, `node_modules`, PB binary live in `$CLAUDE_PLUGIN_DATA` (gitignored / outside repo).

## Known Issues

- **Stale PocketBase records never pruned** — 102 work-units (and old sessions) accumulate in the store; only hidden by the board's live-worktree filter. Daemon-side pruning (delete units whose worktree is gone) was offered, not done.
- **All-worktree scan cost** — ~100 state.yaml × ~21 worktrees ≈ 2k file reads per 15s rescan (backfill ran ~3.5s, acceptable now). Narrow to each worktree's own ticket if it drags.
- **UI changes need a board rebuild** — the user's running board may be stale until `ks-flow close && ks-flow open` (the rebuild-on-source-change logic now handles it).
- **Folder picker / kill / SSE push not all individually live-tested** end-to-end in the browser (daemon→PB→board data path and PB CRUD/CORS were). 3 worktrees lack `workflow/<user>` (e.g. KAR-11862 stays phase 0).
- Env caveats (machine, not code): `~/.npm` was root-owned (EPERM) — bootstrap now uses `--cache "$DATA_DIR/.npm"`; PB serve needs an **unsandboxed** shell for port binds (launchd daemon is fine); a `tr </dev/urandom | head` SIGPIPE under `set -o pipefail` previously aborted bootstrap (fixed).

## Resume Point

Daemon is **running live** under launchd against `/Users/jassu/karmasuite/karmasuite` (pocketbase healthy on :8090). Code complete, daemon + web typecheck/build clean, `claude plugin validate` passes. Nothing committed.

1. **See the current board:** `~/git/ks/plugins/ks-flow/bin/ks-flow close && ~/git/ks/plugins/ks-flow/bin/ks-flow open` → dark board, ~10 live-worktree cards with correct phases, settings page. (`ks-flow status` shows all services.)
2. **Commit** (user hasn't asked yet) — large batch on `feat/ks-flow-plugin`. Suggest logical commits: PocketBase provider+daemon, board UI (dark+settings+kill), CLI verbs+init+bootstrap, phase/worktree fixes.
3. **Optional follow-ups offered, not done:** daemon-side pruning of stale PB records; durable project re-point (bootstrap currently re-applies the plugin-config `project_path` each session, can override UI/`set-project`); remove now-redundant daemon `worktreeDir`-nulling (superseded by board worktreePaths filter, harmless).

Verify build first: `cd plugins/ks-flow/src && npx tsc`; `cd ../web && npx tsc --noEmit`. Daemon rebuild/redeploy: `CLAUDE_PLUGIN_OPTION_project_path=<repo> bash plugins/ks-flow/scripts/bootstrap.sh` (now restarts daemon on rebuild).
