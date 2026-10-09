---
date: 2026-10-09T15:11:16+05:30
git_commit: 0e71fe4
branch: main
task: live pane (Linear/Vercel/toggle), per-ticket time tracking, ks-flow Backups page + backup data in PocketBase, per-action stream panels
---

# Handoff: Time Tracking, ks-flow Backups Page and Action Streams

> See CLAUDE.md for dev guidance. Plugin docs: `plugins/ks/README.md` (statusline + pane), `plugins/ks/scripts/README.md` ("Time tracking"), `plugins/ks-flow/README.md` ("Transcript backup", "Action streams").

## What Happened

1. **ks pane, live** (`0e71fe4`, pushed):
   - Linear status fetched live while the pane is open (`linear issue get --json` via tsx; the CLI now emits `state.color`).
   - Vercel preview pill plus a pane section, via `$.mcp.call('plugin:vercel:vercel', …)`.
     - Previews come from Vercel's GitHub integration on every push, not `deploy-preview.yml`.
     - The pill links to the branch's stable alias, found with `list_deployment_aliases` and cached per branch.
     - Hidden when the vercel plugin is missing.
   - `≡ more` / `≡ less` toggle.
   - All refreshes run off one 5s clock (`hooks/live/schedule.ts`).
   - Fixed `scripts/lib/env.ts` so `dist/` builds find `scripts/.env`.
2. **Time tracking** (`a38e98c`, pushed, plus uncommitted fixes):
   - `scripts/time-log.sh` hooks 8 events and appends to `~/.claude/ks-time/<id>.jsonl`.
   - `ks-time` reports engaged and agent time, by phase and day.
   - `ks-time --write` puts `phases[].engaged_minutes` and `time_spent` into `state.yaml`, on Stop/SessionEnd. Both fields are in both schemas.
   - ks-flow uploads the log as `time-log.jsonl.zst`.
   - The pane shows engaged time per phase (calendar span dropped) and the fetch time with AM/PM.
3. **Time-tracking bug fixed this session (uncommitted):**
   - The statusline mod's 2-minute Vercel poll raises `PostToolUse` between turns. The gap rules billed those gaps as agent time: KAR-13030 Implement showed 184m, really ~31m.
   - `intervals()` is now a per-session state machine (idle/busy/waiting). Only a prompt starts a turn; tool events while idle are ignored.
   - The logger records `tool` names.
   - KAR-13030's state.yaml was rewritten (114 → 31).
4. **ks-flow Backups page (uncommitted):**
   - `/backups` (☁ in the board header): a table of runs and a detail dialog.
   - Each run records trigger, scope, outcome, units checked/current, and per-file uploads with uncompressed and compressed sizes.
   - The CLI records runs via `--trigger` and prints `run <uid> started`.
5. **Backup data moved to PocketBase (uncommitted):**
   - `backup_units` replaces `archive-index.json`; `backup_runs` holds the run history (migration `1700000004_backups.js`).
   - Both sit behind a new `BackupStore` role on the db provider (PB, Firestore and memory all implement it).
   - The legacy file is imported once and renamed `.imported`.
   - `lastSweepAt` is now derived from runs.
6. **One sweep at a time (uncommitted):**
   - The daemon skips while a run is running, and counts any full sweep (daily or manual) that started today.
   - The CLI refuses a second sweep (a daily one skips quietly); a removal (`--worktree`) proceeds.
   - Prompted by a duplicate daily run spawned 33s after a manual one; its record was deleted from PB at the user's request.
7. **Action streams (uncommitted):**
   - `web/components/StreamPanel.tsx` keeps streams by key (`backup:all`, `backup:<id>`, `restore:<id>`, `remove:<id>`).
   - Each stream has its own stacked panel. The provider is in the root layout (`app/providers.tsx`), so streams survive page changes.
   - `<SeeLogs streamKey>` sits beside each action.
   - Backup streams alias to `backup-run:<uid>`, so `/backups` rows show See logs.
   - The Backups table is widened, with no wrapping.

## Key Decisions Made

- Write mod/probe code in the repo (`plugins/ks/hooks`), never `~/.claude/dev-mods` (memory: `feedback_mods_in_repo`).
- Excluded sandbox commands must be the first token: bare `git push`, not `cd … && git` or `git -C` (memory updated).
- karmasuite `workflow/` is gitignored, and the project workflow is unused (memory: `project_workflow_gitignored`). Stale "committed" comments were fixed in `a38e98c`.
- A sweep refuses to run with the store down (it would re-upload everything), except `--force` removals.
- Units "already current" = units with no uploads and no errors, so checked = current + touched.

## Deviations from Plan

- The preview deploy uses the Vercel MCP, not `gh` / `deploy-preview.yml`, because previews come from Vercel's Git integration.
- The run log started as a JSONL file and was moved to PocketBase on request before it shipped.

## Uncommitted Changes

None after this handoff's commits (ks time fix + ks-flow work + docs).

## Known Issues

- **Time log noise inside a phantom turn:** a prompt with no `Stop` (a slash command) is still kept "busy" by the mod's polls until the next prompt (~5m on KAR-13030). Now that `tool` is logged, filter the mod's MCP calls once their `tool_name` is confirmed in real logs.
- **Unverified:** nothing was run against the GCS bucket from here (no creds/network). The first real sweep after deploying is the test of uploads, compressed sizes, the store index and run records.
- **Not seen in a browser** (Chrome connection was down): the per-action panels, See logs and the widened table. The user saw an earlier Backups page.
- **Pane close mark cut off at the top** (reported 2026-10-08): no screenshot yet.
- **KAR-12961** re-uploaded the same session file three days running (Sep 26–28): possible index-not-sticking bug, not investigated.
- `SubagentStop` events with no matching `SubagentStart` (empty `agent_type`) appear in the time log. Harmless to the maths; origin unknown.

## Resume Point

1. **Deploy ks-flow:** `ks-flow start` (rebuilds the daemon, copies the migration; `ks-flow stop` then `start` if PB doesn't pick up the collections), then `ks-flow open` (rebuilds the board).
2. **Verify:**
   - Press ☁ backup on the board: one stream panel, `/backups` shows the run with See logs, and a second press is refused.
   - Close a panel: See logs appears beside the button.
   - Switch to /backups and back: the panel persists.
3. **Check `~/.claude/ks-time/*.jsonl` for `"tool":"mcp__plugin_vercel_vercel__…"`** on idle PostToolUse lines. If confirmed, ignore those in `lib/time-tracking.ts` even inside a turn.
4. **Checks after edits:**
   - `claude plugin validate plugins/ks`
   - `claude plugin test plugins/ks`
   - `node --import tsx --test lib/*.spec.ts` (in `plugins/ks/scripts`)
   - `src/node_modules/.bin/tsc -p src` and `web/node_modules/.bin/next build` (in ks-flow)
