---
date: 2026-06-17T18:38:02+0530
git_commit: c89f151
branch: feat/ks-flow-plugin
task: ks-flow — two new features built this session (GCS archive-on-removal + backfill; session reminders: stop-nudge + per-card). Typecheck-verified, daemon deployed + running. ALL UNCOMMITTED. Open bug: CLAUDE_PLUGIN_DATA split-brain (inline vs marketplace) blocks reminder notifications — design agreed, not yet implemented (the resume point).
---

# Handoff: ks-flow — GCS archive + reminders (uncommitted) + data-dir fix pending

> Builds on `2026-06-09_19-01-43_ks-flow-board-ux-and-daemon-perf.md`. Plugin docs: `plugins/ks-flow/README.md` (updated this session for both features + the data-dir caveat). Approved design docs for both features were written to `~/.claude/plans/polymorphic-swinging-badger.md` (the file was reused: it last holds the **reminders** plan; the GCS plan was overwritten but is fully implemented).

## What Happened (this session)

Two features built end-to-end, both **typecheck-clean** (daemon `npx tsc` in `src/`, web `npx tsc --noEmit` in `web/`) and **uncommitted**. The daemon was redeployed (`ks-flow start`) and is running with the reminder engine; `terminal-notifier` was installed mid-session.

### 1. GCS archive on worktree removal (+ backfill)
Opt-in: on the board's "Completed worktrees · Remove", first zip the worktree's **transcript** (`~/.claude/projects/<enc>/`, incl. `subagents/`) and **workflow** folders into **two** `zstd --ultra -22` `.tar.zst` archives and push to GCS, then run the remove command. Abort-on-failure (never delete un-archived). Separate GCS service-account via `.env`.
- **New**: `src/archive.ts` (CLI), `src/backfill-archive.ts` (archives already-completed/worktree-removed units), `src/lib/archive-core.ts` (`archiveUnit` + creds/binary resolution + `tar -cf - … | zstd --ultra -22 -T0` pipe — bsdtar lacks GNU `-I`, verified), `src/lib/archive-deps.ts` (required binaries), `web/app/api/archive-preflight/`, `web/lib/serverdb.ts` (shared with reminders).
- **Edited**: `web/app/api/run-command/route.ts` (archive-before-remove hook, abort on non-zero, 600s archive timeout), `web/app/api/settings/route.ts` + `settings/page.tsx` (`gcsArchive` toggle/bucket/prefix + missing-`zstd` banner), `bin/ks-flow` (`archive` + `backfill-archive` subcommands), `src/package.json` (+`@google-cloud/storage`).
- Verified: disabled→no-op, enabled+misconfigured→abort, `backfill-archive --dry-run` against the real repo (10 skipped-live, transcript dirs resolved, 57 workflow-only). **Not** tested against a real GCS bucket (needs creds).

### 2. Session reminders (stop-nudge + per-card) — enabled by default
- **Stop-nudge**: `Stop` hook → immediate notify + appends `{kind:'Stop'}` to `events.jsonl`; daemon repeats every N min (default 5) until resume (JSONL `lastActivity` advances) / `SessionEnd` / new session in worktree / cap (default 12). Card shows **▶ active / ⏸ paused** (Pause writes a `kind:'pause'` reminder; daemon auto-deletes it on resume).
- **Per-card custom**: ⏰ control → relative (`30m`/`2h`/`1d`) or absolute datetime + note. Fires once at due, then re-nags once per **OS-wake** (timer-gap on the daemon tick) + **daemon-start** until cleared.
- Scheduler = the daemon (one ~30s `reminderTick`, no OS scheduling). Reminder DATA in the DB (new `reminders` collection, doc-id field **`uid`** per the user convention — see memory `feedback_db_doc_id_uid`); the **board's server** writes it, the daemon polls + writes back.
- **New**: `pocketbase/pb_migrations/1700000002_reminders.js` (`uid`-keyed collection), `src/lib/notify.ts` (terminal-notifier from node + `terminalNotifierAvailable()`), `src/lib/boardsettings.ts` (mtime-gated `reminders:{enabled,stopIntervalMin,capCount}`), `scripts/notify-stop.sh`, `scripts/session-end.sh`, `web/app/api/reminders/`, `web/app/api/pause/`, `web/app/api/reminders-preflight/` (GET check + POST `brew install terminal-notifier`).
- **Edited**: `src/lib/db/types.ts` (`ReminderDoc` + writer `getReminders/upsertReminder/deleteReminder`, source `getReminders/subscribeReminders`), providers `pocketbase.ts`/`firestore.ts`/`memory.ts`, `src/daemon.ts` (events + `reminderTick` + startup notifier warning), `hooks/hooks.json` (`Stop`, `SessionEnd`), `web/lib/types.ts` + `useBoard.ts` (reminders read/subscribe), `web/components/{Board,Column,SessionCard}.tsx` (thread reminders + ⏰/pause UI), settings route+page (reminders block), `web/package.json` (+`firebase-admin` for Firestore server writes).

### 3. Debugging "no notification" → found the open bug
Notifications never fired. Diagnosed in order: (a) `terminal-notifier` not installed → installed it (`/opt/homebrew/bin`); (b) `Stop` hook not loaded in out-of-project / wrong-launch sessions; (c) **root cause — `CLAUDE_PLUGIN_DATA` split-brain.** The hook script + daemon + board each key their data dir off `CLAUDE_PLUGIN_DATA` (`<pluginName>-<marketplaceName>`). Loading ks-flow **inline** (`claude-ks --local-plugin ks-flow` → `--plugin-dir`) yields `ks-flow-inline`; the marketplace (name `karmasuite`) yields `ks-flow-karmasuite` (where the daemon lives, with `project.conf`). So the hook writes events to `ks-flow-inline/` (which has no `project.conf` → `require_in_project` silently exits 0) while the daemon reads `ks-flow-karmasuite/`. Two dirs that never meet.

## Key Decisions Made
- GCS: two separate `.tar.zst` (not one), `zstd --ultra -22` via portable pipe, separate GCS SA, abort-on-failure, dedup-by-prefix on backfill.
- Reminders: daemon-as-scheduler (poll, no OS jobs); OS-wake via timer-gap; reminder data in DB, board-server writes; pause per-session auto-unpause on resume; settings (enable/interval/cap) in `board-settings.json`, data in DB.
- Doc-id field is **`uid`** for new collections (Firestore doc id + PB). Saved as memory.
- Stop hook fires immediate notice; daemon owns repeats. Resume detected via JSONL activity (no extra hook).

## Deviations from Plan
- `archiveUnit` core lives in `src/lib/archive-core.ts` (not inline in `archive.ts`) so backfill reuses it.
- Oversize-line handling for archives became moot (we archive whole folders, not per-line).

## Uncommitted Changes
Everything below is **uncommitted** (see `git status plugins/ks-flow`). Modified: README, bin/ks-flow, hooks/hooks.json, src/daemon.ts, src/lib/db/{types,providers/*}.ts, src/package*.json, web/app/api/{run-command,settings}/route.ts, web/app/settings/page.tsx, web/components/{Board,Column,SessionCard}.tsx, web/lib/{types,useBoard}.ts, web/package*.json. New: pb_migrations/1700000002_reminders.js, scripts/{notify-stop,session-end}.sh, src/{archive,backfill-archive}.ts, src/lib/{archive-core,archive-deps,boardsettings,notify}.ts, web/lib/serverdb.ts, web/app/api/{archive-preflight,pause,reminders,reminders-preflight}/.
- (`plugins/ks/scripts/.env.example: Operation not permitted` in git status = sandbox read-denial on a gitignored file — not a change.)

## Known Issues / State
- **OPEN BUG (resume point): `CLAUDE_PLUGIN_DATA` split-brain.** Reminder notifications won't fire when ks-flow is loaded inline (dev) because the hook's data dir ≠ the daemon's. Daemon currently runs under `ks-flow-karmasuite`; inline sessions use `ks-flow-inline` (empty, no `project.conf`).
- Daemon deployed + running with the reminder engine; `terminal-notifier` installed and recognized (no startup warning after the last restart).
- `reminders` PB collection exists (migration applied on the last `ks-flow start`).
- GCS archive untested against a real bucket.

## Resume Point — implement the stable data-dir fix (design agreed with user)
Make ks-flow's data dir **independent of the load method** so hooks + daemon + board always agree, safe for multi-plugin dev + inline + marketplace.

**Agreed scheme:** stop trusting `CLAUDE_PLUGIN_DATA`'s marketplace suffix. Derive a stable dir from the project's **git-common-dir**:
```
~/.claude/plugins/data/ks-flow/<encoded-common-dir>/
```
`<encoded-common-dir>` = common-dir with `/` and `.` → `-` (the existing `encodeProjectDir` rule; identical in bash `sed 's/[/.]/-/g'` and TS). Resolution:
- hooks (`scripts/_common.sh`): cwd → `git rev-parse --git-common-dir` (already resolved there) → encode → dir.
- daemon (`src/lib/config.ts` `dataDir()` / `paths.ts`): `project_path` (plist) → common-dir → encode → dir.
- board (`web/app/page.tsx`, `web/lib/serverdb.ts`, settings/run-command/reminders routes): `project_path` env → common-dir → encode → dir; `bin/ks-flow` computes the same for status/open/stop.
- Honor a `KS_FLOW_DATA` override; use `CLAUDE_PLUGIN_DATA` only as last-resort fallback.
- `scripts/bootstrap.sh`: write the plist `CLAUDE_PLUGIN_DATA` + `project.conf` into the derived dir, and **migrate** any existing `ks-flow-<marketplace>` dir once (move, or just re-backfill).

Safety: inline + marketplace resolve the *same* dir (bug fixed); `ks-flow/` namespace won't collide with other dev plugins; per-project subdir avoids multi-project collisions; `require_in_project` becomes "hook writes its own project's dir, daemon reads it".

User chose **per-project subdir** (`ks-flow/<encoded-common-dir>`) over a single fixed `ks-flow/` dir. This is a multi-file refactor + one-time migration → was about to be written up as a plan. **Next step: enter plan mode, lay it out (per-project scheme), get approval, implement.**

## After the fix — verify + commit
1. Rebuild/redeploy: `ks-flow start` (daemon + migration) + `ks-flow open` (board with new routes/UI + `firebase-admin`).
2. Reminders e2e in a tracked-project session (loaded so its data dir == daemon's): end a turn → immediate banner → 5-min repeats; Pause/resume; ⏰ custom reminder fires + re-nags on daemon restart; settings toggle off → silent.
3. GCS: `ks-flow archive <worktree>` + `backfill-archive` against a real test bucket.
4. Commit the two features + the data-dir fix (likely separate commits) once verified.
