---
date: 2026-10-13T20:18:17+05:30
git_commit: 7167544
branch: main
task: Workflow-restore fix, worktree lifecycle (remove/recreate) with cloud backup gating, Remove confirmation, one daemon clock, live Linear sync + status ribbon + whole-card refresh
---

# Handoff: ks-flow live Linear sync, one daemon clock, worktree lifecycle

> See CLAUDE.md for dev guidance, plugins/ks-flow/README.md ("One clock", "Live Linear fields", "Restore", "Completed worktrees") and plugins/ks/scripts/README.md (worktree reuse / ks-flow cloud backup) for the behaviour described here.

## What Happened

Resumed from the previous handoff's Resume Point; a dry-run restore of KAR-12352 exposed a bug, and the session grew from there.

### 1. Whole-tree workflow archives (fixed both sides)
- `targetForWorktree` (removal-hook backup) fell back to the worktree's **whole** `workflow/` dir when no state.yaml had a matching `worktree_dir` (old tickets lack the field). Restore then nested ~750 files under `tickets/kar-12352/`.
- Backup now finds the unit's folder by identifier (worktree, then main checkout), never the whole tree. Restore's `unitFolderIn()` cuts the unit's own folder out of an existing whole-tree archive and restores it at the same path. Verified by dry-run on KAR-12352/12366.

### 2. Worktree lifecycle
- `remove_worktree`: falls back to the ticket id (from the worktree dir name, `tickets/<id>/state.yaml` only) when no `worktree_dir` matches; backs up to the cloud first when `ks-flow backup-enabled` (aborts on failure; skipped when the board sets `KS_FLOW_BACKED_UP=1`).
- Fixed the 3 live worktrees missing `worktree_dir` (KAR-11331, 11509, 11512) in both copies; root cause `updateWorktreeDir` only replaced an existing line — it now inserts one.
- `create-worktree`: recreates the branch from `origin/<branch>` (with `--track`) when `git ls-remote` finds it and no base was given.
- `ks-start-ticket`: after the worktree exists, offers `Restore? [Y/n]` from the cloud backup when enabled and something is missing locally.
- New `ks-flow backup-enabled` (exit 0 iff `gcsArchive.enabled`): the single switch for all of the above.

### 3. Board
- `RemoveWorktree.tsx` (shared by cards and the completed table): confirm dialog showing backup step + the exact command; red warning on open tickets; red button everywhere.
- Status **ribbon** as each card's header in Linear's state colour; its ↻ refreshes the whole card (`/api/card-refresh` → `RefreshCard` event in events.jsonl).
- Done check also uses Linear's `completed`/`canceled` state type.
- `ks-flow open` now prunes `app/ components/ lib/` before copying (stale routes lingered).

### 4. Daemon
- One 15s clock (`src/lib/schedule.ts`, copy of the ks mod's): jobs worktrees 60s, stateYaml 15s, reminders 30s, backup 60s, rotateLogs 60s, linear 3 min. No stacking; no tick at startup (would pre-empt the stop-nudge re-arm).
- `runFor(unitId)` per-card forms (worktrees, stateYaml ignoring mtime, linear single ticket) + session catch-up → `cardRefreshedAt` / `cardRefreshError` on the card.
- Live Linear overlay (`src/lib/linear-sync.ts`) for board tickets only, via new `linear issue batch-get` (one GraphQL query per team, state inline). Kept in daemon memory; state.yaml is never rewritten.

Verified live: first sync updated all 14 board tickets (most snapshots were stale; KAR-13178 is Done and moved to the completed table); card refresh round-trip ~1.5s with the single-ticket Linear read.

## Key Decisions Made
- Gate cloud backup/restore in terminal tools on the board's GCS setting, not on `KS_EXTRA_PLUGINS` (user's call: one switch).
- Linear access via the `linear` CLI from the daemon (CLAUDE.md rule), resolved through the login shell once.
- Linear values live as an in-memory overlay applied before `currentPhase()`, not written to state.yaml.
- Refresh = the per-card form of each clock job; reminders/backup sweep/log rotation have none (they notify/upload/roll, not read card data).
- The board talks to the daemon by appending to `events.jsonl` (already tailed), no new IPC.

## Deviations from Plan
- One-clock proposal said "jobs run once at startup"; dropped — an immediate reminder tick would run before `reconstructStopState()` and break the grouped restart notice. First tick is at +15s.
- Ribbon ↻ started as Linear-only refresh; changed to whole-card refresh at the user's request (`/api/linear-refresh` → `/api/card-refresh`).

## Uncommitted Changes
None after this session's commit.

## Known Issues
- Not exercised for real (sandbox: no GCS creds, no GitHub SSH, no `tsx`): `remove_worktree`'s cloud backup step, `ks-start-ticket`'s restore prompt, `create-worktree`'s origin-branch path. The board/daemon Linear path *was* verified live.
- `linear issue batch-get` was only run by the daemon (outside the sandbox); its human-readable (non `--json`) output is untested.
- Concurrent full Linear sync and a card refresh can race; last write wins (harmless — both are fresh).
- Ribbon fallback colours (before first sync) are Linear's defaults by status type; custom statuses show slate until synced.
- KAR-13178 sits in "Completed worktrees · not removed" — removable.

## Resume Point
1. `remove_worktree -D <a done worktree>` in a terminal (e.g. KAR-13178's): expect "Backing up sessions + workflow to the cloud…" then removal.
2. `ks-start-ticket` on that ticket: expect "Branch … is on origin — recreating it from there", then `Restore? [Y/n]`; check `--resume` lists the restored sessions in the new worktree.
3. Click ↻ on a few cards; on failure the `!` tooltip and `daemon.log` (`linear sync failed`, `<job> (<unit>) failed`) say why.
