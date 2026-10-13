---
date: 2026-10-13T14:09:07+05:30
git_commit: 6bb0e81
branch: main
task: ks-flow transcript restore — fix invisible Restore (truncated status JSON), restore for Done tickets, confirm dialog with workflow-folder restore, mtime preservation, merged time logs
---

# Handoff: ks-flow restore for Done tickets, workflow restore, merged time logs

> See CLAUDE.md for dev guidance and plugins/ks-flow/README.md ("Restore", time log section) for the behaviour described here.

## What Happened

All in `6bb0e81`. The user could not see a Restore button on any card (example: KAR-12765, Done, worktree still on disk, every transcript pruned).

### 1. Two bugs hid every Restore
- **Truncated status JSON (the real cause).** `transcript-backup --status` wrote its JSON then called `process.exit()`. On macOS stdout to a pipe is async, so output past 64 KB was dropped (repro: write 300 KB then exit → exactly 65536 bytes arrive). With 177 units the JSON was cut mid-object; `/api/transcript-backup` could not parse it and returned `ok:false, units:[]` — no badge anywhere. `emitAndExit()` in `src/transcript-backup.ts` now exits from the write callback; used for `--status`, `--runs`, `--reindex --json`, sweep `--json`.
- **Done tickets had no button at all.** The control lived only on board cards; Done units go to the completed tables. Extracted to `web/components/TranscriptBackup.tsx`, now on `CompletedWorktrees` (backup + restore) and `CompletedNoWorktree` (`restoreOnly`).
- **CLI/status mismatch.** `transcript-restore.ts` resolved the transcript dir narrower than `unitStatuses` (live worktree → index only). Now same order: live worktree → completed-unit record → object stamps → index.

After restart the status returned all 177 units, 51 restorable.

### 2. Restore changes (`src/lib/transcript-archive.ts`, restore section rewritten)
- **Confirm dialog** (`RestoreDialog` in `TranscriptBackup.tsx`, portalled to `<body>`, Esc/backdrop cancel): one checkbox, *Also restore the workflow folder*.
- **Workflow restore** (`--workflow`): unpacks `workflow.tar.zst` into the live worktree's `workflow/…`, else the main checkout's. Path from a `state.yaml` naming the unit, else archived state.yaml type + the only `workflow/<user>/`. Missing files only unless `--overwrite`.
- **mtime preserved** on restored transcripts (`setMtime`, from `srcMtimeMs` or the tarball), mid-millisecond so `floor(mtimeMs)` matches the stamp → no re-upload.
- **Legacy (`transcript.tar.zst`) units** now share the time-log + workflow tail (`restoreFromTarball` fills `out`, returns nothing).
- **Time log merged** (`src/lib/time-log-merge.ts`: verbatim-line union, sorted by `ts`). Restore appends cloud-only lines (append, not rewrite, so a concurrent hook write survives). Sweep uploads `mergeLogs(local, cloud)` with the local file's stamp.

### 3. Verified live on KAR-12765
Restore brought back its one session (37 lines, valid). Later `--workflow` run (dry + real, via board API and the user's own CLI run): destination resolved to the worktree's `workflow/jaswanth/tickets/kar-12765`, 0 restored / 1 kept, `no time log in the bucket` (unit last backed up 2026-08-29, before time logs).

## Key Decisions Made
- **No time-log overwrite in the UI.** User first asked for an overwrite checkbox; after merge landed on both sides, agreed it can only drop events logged since the last backup (cloud already holds the rest). Removed from dialog and route; `--overwrite-time-log` kept on the CLI as an escape hatch.
- **Workflow restore never overwrites by default** — files on disk are the ones being edited (same rule as transcripts).
- **Restore-only on the worktree-removed table** — the sweep only backs up live worktrees.

## Deviations from Plan
None beyond the overwrite checkbox being added then removed (above).

## Uncommitted Changes
None.

## Known Issues
- The badge still appears only when sessions are missing (or legacy-only with nothing local). A unit whose sessions are all on disk but whose workflow folder is gone has no UI path — use `ks-flow restore --unit <id> --workflow`.
- KAR-12765 shows `pendingCount: 1`: its session was restored before the mtime fix, so the next backup re-uploads it once. Expected, harmless.
- The dialog has not been clicked through by a human yet; the first restore that actually writes files with this code has not run.
- `workflowDestination` throws if `workflow/` has zero or several user folders and no state.yaml names the unit (new machine, multi-user checkout).
- Lint not run from the sandbox (npm `~/.npm` EPERM); `next build` lint/typecheck passed on the user's restart.

## Resume Point
1. On the board (http://localhost:4317), click `⤓ restore 1` on **KAR-12352** (or KAR-12366), tick *Also restore the workflow folder*, confirm. Expect the restored session, a time-log line, and `workflow → <dir>: restored N, kept M` in the log panel; afterwards that unit's `pendingCount` should be 0 (mtime fix).
2. Optional: surface a workflow-only Restore (badge when the workflow folder is missing locally) — needs `unitStatuses` to report workflow presence.
3. The GCS credentials `.env` is unreadable from the sandbox: exercise restore via `curl -X POST localhost:4317/api/transcript-restore -d '{"unit":…,"dryRun":true}'` (board server runs outside the sandbox) or ask the user to run `ks-flow restore`.
