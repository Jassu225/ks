---
date: 2026-10-19T13:41:35+05:30
git_commit: c9b640b
branch: main
task: slack --no-unfurl + PR review request in two parts (12c1e4f); ks-start-ticket restores the workflow folder before writing state.yaml (c9b640b)
---

# Handoff: Slack --no-unfurl, two-part PR review, restore before write

> See CLAUDE.md for dev guidance. `plugins/ks/RELEASES.md` (2026-10-19), `plugins/ks/commands/slack.md`, `plugins/ks/scripts/slack-templates/pr-review-request.md`, `plugins/ks/scripts/README.md` ("ks-flow cloud backup") and `plugins/ks-flow/README.md` describe the behaviour below.

## What Happened

**Slack (12c1e4f)**
- `slack message send|reply --no-unfurl` sets `unfurl_links` and `unfurl_media` to false. Slack's `unfurl_app_links` follows `unfurl_links`, so GitHub/Linear app unfurls are off too.
- A preview is fixed when the message is posted. Slack can't turn one on later, only remove it, and `chat.update` has no unfurl option.
- `--file` combined with `--no-unfurl` is refused before any API call. The text of a message with files goes through `files.uploadV2` / `completeUploadExternal`, which has no unfurl option.
- The rule for messages that should skip previews but have files: tell the user the links will preview, and send on their confirmation. It's in `commands/slack.md` and the template.
- `commands/slack.md` now says to follow the send flags a template prescribes.
- `pr-review-request` now posts in two parts, like `release-announcement`:
  1. Main message: greeting, title, PR URL, project thread.
  2. `Changes:` + bullets as a reply in its thread.
  Each part is shown and confirmed before posting, and both send with `--no-unfurl`. `review_thread` = main message. WORKFLOW.md has one line saying so.

**Restore order (c9b640b)**

The bug: restore only fills in missing files. `ks-start-ticket` wrote a fresh `state.yaml`, then offered the restore (inside `lib/worktree.ts`). On a machine without the ticket's workflow folder, the backed-up `state.yaml` (phases, PRs, `time_spent`, release thread) was skipped, and the next backup uploaded the fresh one over it. The usual reopen was safe: `remove_worktree` copies the workflow folder back to the main checkout first.

Fix:
- `offerCloudRestore` (now exported from `lib/worktree.ts`) runs in `ks-start-ticket` before `loadExistingState`. It is still gated by `ks-flow backup-enabled`. It asks one `Restore?` question.
- On yes, the workflow folder comes back at once: `ks-flow restore --workflow-only --workflow-dir <dir>`. The target is the existing worktree's ticket folder, else the main checkout's (`dirname(outputPath)`).
- Once the worktree exists, `restoreCloudSessions` runs `ks-flow restore --unit <id>` (sessions + time log, no second prompt). It runs on any yes, not only when sessions are missing, because the time log came back with the single restore before the split.
- ks-flow: `RestoreOpts.sessions` (false skips transcripts and the time log) and `RestoreOpts.workflowDir` (overrides `workflowDestination()`). New CLI flags `--workflow-only` and `--workflow-dir <path>`. A missing path is refused (exit 2).

Verified:
- `tsc` passes for ks scripts, and the ks-flow build passes.
- `offerCloudRestore` was run against a fake `ks-flow` on PATH (harness in the session scratchpad, `isTTY` forced). All 7 cases (yes / Enter / no / nothing missing / no TTY / backup off / sessions-only) make the right calls in the right order.
- `restoreUnit` was run against a fake GCS (`mock.module` on `@google-cloud/storage`, local folder, real tar + zstd archives):
  - `--workflow-only` writes only the workflow folder.
  - A pre-written `state.yaml` is kept, which reproduces the bug.
  - The second part restores sessions + time log and leaves the workflow folder alone.
  - The dry-run probe counts what's missing and writes nothing.
- `--workflow-dir` with no path → exit 2.

## Key Decisions Made
- Split the restore in two instead of running everything before the worktree exists. Sessions are restored to the transcript folder of the worktree ks-flow resolves, so they must wait for it. The workflow folder must come first.
- Added `--workflow-dir` rather than relying on `workflowDestination()`. With no `state.yaml` naming the unit, that function guesses from the only `workflow/<user>/` folder, and on a fresh checkout it fails.
- Kept the `--file` + `--no-unfurl` refusal; the agent asks the user instead. Rejected: two messages (text, then files in thread), and a private upload with the permalink in `chat.postMessage` (the file preview is an unfurl, so it would likely vanish too).

## Deviations from Plan
None beyond the two-part restore, which the user confirmed.

## Uncommitted Changes
None after this handoff's commit.

## Known Issues
- Nothing was tested live:
  - Slack: the sandbox blocks `.env`, and CLAUDE.md forbids supplying `SLACK_TOKEN`.
  - GCS: the sandbox blocks the ks-flow `.env`.
- The `ks-flow` on PATH runs the installed copy at `$DATA_DIR/daemon` (`~/.claude/plugins/data/...`). `bootstrap.sh` rebuilds it from source on the next session start. Until then, `ks-start-ticket` passes flags the old copy ignores. `--workflow-dir` is ignored, so restore falls back to its own destination. `--workflow-only` is ignored too, so the first part would also restore sessions before the worktree exists.
- The "Skipped. Later:" hint (`ks-flow restore --unit <id> --workflow`) can't bring back `state.yaml` once the script has written one. Only `--overwrite` would, and that replaces the refreshed file.
- Still open from earlier handoffs:
  - 2026-10-15: `document update --json` live check.
  - 2026-10-14: confirm `claude-ks --name` sets the peer name. This session saw the KAR-13089 session (pid 59676, started 12:33 IST) still `nameSource: derived` with a `custom-title: KAR-13089` transcript, but couldn't tell how it was launched (`ps` is sandboxed).
  - 2026-10-13: worktree/restore tests.

## Resume Point
1. Start a new session so `bootstrap.sh` rebuilds ks-flow's daemon copy. Then run `ks-flow restore --unit <any id> --workflow-dir` and expect `--workflow-dir needs a path`.
2. Live restore test:
   - Pick a ticket with a cloud backup and no local `workflow/<user>/tickets/<id>/`.
   - Run `ks-start-ticket <url>` and answer Y.
   - Expect the restored `state.yaml` to keep `phases[]`, `prs[]` and `time_spent` with a refreshed `ticket:` block, then `Restoring <id>'s sessions and time log…` after the worktree, and the sessions under `--resume`.
3. Next PR review request: check that it posts in two parts with no previews, and that `review_thread.ts` is the main message.
4. Ask the user how the KAR-13089 session was started at 12:33 (plain `claude-ks`, `-c`, or `claude`), to close the 2026-10-14 `--name` question.
