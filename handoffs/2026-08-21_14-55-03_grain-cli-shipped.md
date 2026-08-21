---
date: 2026-08-21T14:55:03+05:30
git_commit: 5e5ed9e
branch: feat/grain-cli
task: Ship the Grain CLI branch — push to both remotes, open a PR on each, merge both
---

# Handoff: Grain CLI shipped; crv is the backend we kept

> Predecessor: `handoffs/2026-08-21_13-57-22_grain-cli-crv-vs-video-vision.md` — it holds the
> full evidence behind the backend decision and the six rounds of hardening. Read that one
> for *why*; this one records *what shipped*.

## What Happened

A peer session ran the CLI end to end one more time from a clean context and produced no
changes, so `feat/grain-cli` shipped exactly as it stood at `5e5ed9e` — 10 commits, 13 files,
+3810/-6.

`feat/grain-cli` was pushed to both remotes and a PR opened on each:

- `karmasuite/ks` → PR #5 (base `main`)
- `Jassu225/ks` → PR #2 (base `main`)

Both PRs carry the same content diff. The commit *counts* differ wildly — PR #2 shows 54
commits — because `jassu/main` (`ed9378b`) and `origin/main` (`bacacc4`) have diverged in
history: 44 commits on one side, 45 on the other, the same work merged two different ways
(Jassu225 took `feat/ks-flow-plugin` through a GitHub merge commit). `git diff
jassu/main..feat/grain-cli` is byte-identical to `git diff main..feat/grain-cli`, so the noise
is history-shaped, not content-shaped.

## Key Decisions Made

- **claude-real-video is the frame-extraction backend.** The predecessor handoff left this
  open; shipping this branch closes it. crv is maintained upstream (8 commits in two weeks,
  0 open issues, three releases in two days), its scene-change selection catches on-screen
  edits that uniform sampling misses, and its two weaknesses are worked around locally
  (`--from/--to` clipping for the missing time-range flag, `--full-res` for the hardcoded
  `scale=640:-1`).
- **`feat/grain-video-vision` (`7703923`) is not deleted.** It stays on the remotes as the
  recorded alternative — a nicer native API on a repo whose last code change was 2026-05-18,
  with 17 open issues and two unfixed crashes (`png` and a 90-frame batch at 2048px each kill
  the MCP server).
- **No Linear ticket reference.** This is the plugin monorepo, so the usual `Closes KAR-XXX`
  rule in `CLAUDE.md` does not apply; both PR bodies say so explicitly.

## Deviations from Plan

The predecessor's resume point recommended filing two upstream crv issues (a time-range flag
and a configurable frame width) as part of committing to crv. That was not done — the branch
shipped first. Both reproductions are still written up in the predecessor handoff, ready to
paste.

## Uncommitted Changes

None at the time of the merge.

## Known Issues

Carried forward unchanged from the predecessor — shipping did not resolve any of them:

- **`--crop-in-grid` has only ever run against one 1280x720 source.** The width probe is
  correct by inspection but unverified on a 1920-wide or portrait recording; the factor should
  print `(1920÷480)` = 4.0 on any 1920-wide call.
- **Three code paths have never executed:** the `.grain-lock` refusal, the `$TMPDIR` findings
  fallback, and the `crv-out…-2` side-step. Two deliberate concurrent watches on the cached
  recording `eb542359-ab12-4c67-a6db-e70935172cab` would settle the first and third cheaply.
- **`~/Documents/Grain` is not writable from a sandboxed session** — the agent falls back to
  `$TMPDIR/grain-findings/`. Add it to `sandbox.filesystem.write.allowOnly` if reports should
  land in the user's Documents.
- Report front matter should carry cell/field coordinates for spreadsheet content; one run
  produced correct cell *contents* with no cell addresses because its crops excluded the
  gutters.
- Whether crv's `MANIFEST.txt` frame↔speech timeline still earns its keep is unjudged now that
  full-res filenames carry absolute timecodes.

## Resume Point

1. **File the two upstream crv issues** — a `--from/--to` time-range flag and a configurable
   frame width — using the reproductions in the predecessor handoff. Landing either deletes a
   workaround from `grain-cli.ts`.
2. **Verify `--crop-in-grid` on a non-720p recording.** Any 1920-wide call; check the printed
   factor.
3. **Settle the three untested paths** with two concurrent watches on the cached recording.
4. Decide whether `feat/grain-video-vision` stays as a record or gets deleted from the
   remotes.
