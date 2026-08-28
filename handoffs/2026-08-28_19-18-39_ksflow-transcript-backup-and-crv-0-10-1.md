---
date: 2026-08-28T19:18:39+05:30
git_commit: 315d33f
branch: main
task: Retire the crv head clip on 0.10.1; build ks-flow transcript backup (daily sweep, per-file objects, restore, legacy migration)
---

# Handoff: crv 0.10.1 head-clip removal shipped; ks-flow transcript backup built

> Predecessor: `handoffs/2026-08-26_23-29-00_retire-claude-ks-serena-injection.md`.
> See CLAUDE.md for dev guidance.

## What Happened

Two pieces of work. The first closed out an old thread; the second is new and is
the bulk of the session.

### 1. crv 0.10.1 — head clip deleted (merged, PR #7)

Upstream `claude-real-video` merged all three window fixes filed from this repo
(#21/#23/#24), closed #19/#20/#22, and released **0.10.1** on 2026-08-27. The
maintainer, silent for the whole earlier episode, merged by hand and thanked the
diagnosis.

That unblocked the payoff: `grain recording watch` no longer stream-copies a
`<base>_head_<to>.<ext>` clip (~100–137MB per bounded run, never cleaned up) to
work around `--to` destroying frame timestamps. Both bounds now go straight to
crv. Verified on a real 47-minute call: 40 frames spanning 1910.0–2836.0 on the
source clock with no `None`, transcript clipped 891→82 lines, zero head clips.

The version gate needed thought: 0.10.1 adds **no flag** and crv exposes neither
`--version` nor `__version__`, so `crv --help` cannot distinguish it from 0.10.0,
where the new code would silently produce `t=None` frames. `crvVersion()` reads
the resolved launcher's shebang and asks *that* interpreter for
`importlib.metadata.version('claude-real-video')` — not whichever `python3` is on
PATH, which in a pipx install knows nothing about the package. Below 0.10.1 exits
1; an unreadable version warns and continues. All three branches were exercised
with venv/shell shims.

Merged as karmasuite/ks#7 (admin merge — `main` requires a review) and
Jassu225/ks#3. The two remotes' `main` now differ by one merge commit each with
identical trees; realigning was offered and **declined**, so they stay diverged.

### 2. ks-flow transcript backup (this commit, uncommitted before now)

**The problem.** Claude Code prunes `~/.claude/projects/**/*.jsonl` at 30 days —
confirmed empirically: the oldest surviving JSONL on this machine was exactly 30
days old, zero older, out of 537 files. Until now the only thing that pushed a
transcript to GCS was the board's **Remove** button, i.e. only work you were
already finished with. A session parked and revisited a month later had lost its
transcript entirely.

**What was built** (all through one uploader, `sweep()` in
`src/lib/transcript-archive.ts`):

- daily end-of-day sweep in the daemon (default 23:45, with wake/startup catch-up
  so a sleeping Mac cannot skip a day), run as a child process
- `ks-flow backup` with four target modes: all live worktrees, `--unit`,
  `--worktree` (the removal hook), `--completed` (ex-`backfill-archive`)
- `ks-flow restore --unit`, `ks-flow migrate-archives`, `--reindex`, `--status`
- board: `☁ backup` on each card and in the toolbar, `⤓ restore N` appearing
  automatically, all streaming into the shared bottom-right log panel
- per-unit `manifest.json` + source stamps on every object, so the bucket is
  self-describing

## Key Decisions Made

- **One object per session file, never a directory tarball.** This is the load-
  bearing decision. Re-tarring the transcript directory after local pruning has
  removed an old session uploads a tree that has *lost* that file, overwriting a
  good cloud copy with a lesser one — silently, and precisely for the long-lived
  units the feature protects. Per-file objects make it impossible and make the
  sweep incremental. Cost: `zstd -19`, ~5x on JSONL (391,483 B → 76,921 B
  measured, restored byte-identical).
- **Trigger ≠ action.** A session file differing from the index triggers a unit;
  the action then backs up the *whole worktree*. Scoping the action to the change
  window lost data in testing: KAR-12770 had 17 local sessions and **one** in the
  bucket, and the other 16 would never have been uploaded because a finished
  session never changes again. `--since-hours` now narrows only the trigger.
- **Transcript and workflow travel together**, gated on transcript change only. A
  lone `state.yaml` touch does nothing — `workflow/` is committed to git, so it is
  already recoverable. An earlier version had the workflow tracking its own mtime;
  that was reverted on explicit instruction to keep one path.
- **The index is a cache, and is now treated like one.** It is reconciled against
  a bucket listing before every decision (one list call per unit), because objects
  deleted in the cloud otherwise leave it asserting a backup that no longer exists
  — the sweep reported "nothing to upload" forever. A failed index *write* is a
  warning, never a failure: the objects are already uploaded, and the removal hook
  aborts a worktree deletion on any non-zero exit.
- **Status is derived from the bucket, not the index.** The index only lists units
  *this* machine backed up, so units archived earlier/elsewhere showed no Restore
  at all — the cards with the most to recover showed nothing. `--status` lists the
  bucket and reads source stamps; the board execs it with a 30s cache (the web
  package has no GCS client).
- **Safety copy before migration.** `migrate-archives` server-side copies every
  object under a unit's prefix to `_legacy-backup/<timestamp>/` before writing
  anything, and only *adds* objects — the tarball survives unless
  `--delete-legacy`, so an interrupted run is finished by re-running.
- **Local always wins on restore.** Only files missing from disk are written; a
  transcript on disk may be the live one Claude Code is appending to.

## Deviations from Plan

- The original plan was to gate transcript uploads on a 24h window. That is now
  trigger-only — see above; the window as an upload filter was a data-loss bug.
- `ks-flow archive` and `ks-flow backfill-archive` survive as **aliases** rather
  than being deleted, since both are documented and muscle-memory. Their
  implementations are gone.
- No Settings UI for the schedule. `transcriptBackup` in `board-settings.json`
  (`enabled`, `hour`, `minute`, `sinceHours`) is read mtime-gated; defaults apply
  and nobody asked for a UI.

## Bugs Found and Fixed Along the Way

Worth reading before touching this code — several were only visible against real
data:

1. **Unit keying.** `workflow/` is committed, so every worktree carries every
   unit's `state.yaml`; taking the first one on disk made five unrelated
   worktrees share one object prefix. Must match the state.yaml whose own
   `worktree_dir` points back at the worktree.
2. **Ticket units invisible.** Tickets live at `workflow/<user>/tickets/<id>/`,
   one level deeper than the original fixed-depth glob, so every ticket fell back
   to its directory slug. The tree is now walked.
3. **`sinceHours: 0` meant "since now."** `Date.now() - 0` triggered nothing at
   all. Zero now means no window.
4. **`bin/ks-flow` never exported its resolved data dir**, so node entrypoints
   re-derived it from the CWD — running `ks-flow backup` from another repo read a
   data dir with no `board-settings.json` and reported "GCS archive is disabled".
   Now `export KS_FLOW_DATA="$DATA_DIR"`. This affected every archive subcommand.
5. **`bootstrap.sh` copied additively**, so `archive.ts` / `backfill-archive.ts`
   lingered in the deployed source tree and broke the build against the module
   they imported. It now prunes stale `*.ts`, `lib/`, and `dist/` first.
6. **`bootstrap.sh` rebuild detection only compared `lib/` and `daemon.ts`**, so a
   change confined to another entrypoint deployed nothing while reporting success
   — very likely why an earlier "deploy" silently carried no fixes. All top-level
   entrypoints are compared now, and an upstream deletion forces a rebuild.
7. **Dry-run migration downloaded all 35 tarballs** just to count sessions.
8. **Empty index entries** were written for every worktree scanned (28 of 33 had
   nothing behind them).

## Uncommitted Changes

None after this commit. It covers: `CLAUDE.md`, `plugins/ks-flow/README.md`,
`bin/ks-flow`, `scripts/bootstrap.sh`, `src/daemon.ts`, `src/lib/archive-core.ts`,
`src/lib/boardsettings.ts`, new `src/lib/{archive-index,transcript-archive}.ts`,
new `src/{transcript-backup,transcript-restore,migrate-legacy-archives}.ts`,
deleted `src/{archive,backfill-archive}.ts`, new
`web/{components/StreamPanel.tsx,lib/streamproc.ts,lib/backupStatus.tsx}`, new
`web/app/api/transcript-{backup,restore}/route.ts`, and edits to
`web/components/{Board,SessionCard,CompletedWorktrees}.tsx` +
`web/app/api/run-command/route.ts`.

## Known Issues

- **The sandbox cannot write `~/.claude/plugins`**, so every verification run in
  this session logged `WARNING: could not write the archive index — EPERM`. The
  uploads themselves succeeded, and the daemon/board (outside the sandbox) write
  it fine. Do not "fix" that warning.
- **`ks-flow migrate-archives` was mid-run at handoff time.** The user had
  converted many units (KAR-11445 shows 37 per-file objects, KAR-12473 shows 86).
  `KAR-12243` was converted during testing, and its safety copy sits at
  `_legacy-backup/test/` — deletable. Re-running the migration is safe and
  finishes whatever is left.
- **`ks-flow backfill-archive` has never been run**: ~269 files across 13
  completed units whose worktrees are already gone, so those transcripts exist
  only on this disk. Highest-value remaining action.
- **Pre-stamp objects re-upload once.** Objects written before source stamping
  carry no `srcSize`/`srcMtimeMs`; `--reindex` records them as size/mtime 0 so
  they re-upload a single time. Safe direction, but expect one large sweep.
- **Restore returns the conversation, not the worktree.** If the git worktree is
  gone, the encoded transcript path matches no live directory and `--resume` will
  not list the session until that worktree exists again. The UI says so.
- **crv still copies the source media into its own output dir**
  (`crv-out_*/source.mp4`, 131MB on the test call), so a bounded `grain recording
  watch` still duplicates the media. Not filed upstream; the user said leave it.
- **A rewrite preserving both byte length and mtime would evade detection.**
  Nothing in Claude Code does that (it appends). Content hashes are the fix if
  that guarantee is ever wanted.
- **`--status` returns 143 units**, including completed units with no backup at
  all, because it unions the bucket with everything discoverable in `workflow/`.
  The board only renders rows matching its cards, so this is harmless.

## Resume Point

1. **Finish the migration and the backfill**, in this order:
   `ks-flow migrate-archives --dry-run` → `ks-flow migrate-archives` →
   `ks-flow backfill-archive --dry-run` → `ks-flow backfill-archive`.
2. **Do one real restore from a converted unit** before dropping anything. Only
   after that: `ks-flow migrate-archives --delete-legacy --force`, then delete the
   `_legacy-backup/` prefix (including `_legacy-backup/test/`).
3. **Watch the first unattended 23:45 sweep** land in `daemon.log` — the schedule
   path has been exercised only by hand.
4. Optional: a Settings toggle for `transcriptBackup` (hour/minute/enabled), and
   filing the crv `source.mp4` copy upstream as a hardlink/symlink patch.
