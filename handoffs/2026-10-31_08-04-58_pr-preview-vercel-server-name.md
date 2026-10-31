---
date: 2026-10-31T08:04:58+05:30
git_commit: 4797eff
branch: main
task: Restore /ks-project PR preview pills; add quit-chrome and mem-info helpers
---

# Handoff: PR preview pills (Vercel server name) + machine helpers

> See CLAUDE.md for dev guidance, plugins/ks/README.md ("Project pane") for the pane, plugins/ks/RELEASES.md (2026-10-30) for the user-facing summary.

## What Happened
- **`/ks-project` pane lost its Vercel pills** (only the GitHub link showed) in the karmasuite ticket sessions (KAR-13197 / PR 6848, KAR-13293 / PR 6846). Two causes, both fixed in `plugins/ks/hooks/register.tsx`:
  1. **Latch.** Any failed `$.mcp.call` other than an auth refusal set `vercelMissing = true` for the rest of the session and cleared the pills. Removed: a failed call now keeps the last previews and retries at the 2-minute idle interval.
  2. **Root cause.** `~/.claude.json` has a project-scope MCP server `vercel` (`https://mcp.vercel.com`) for `/Users/jassu/karmasuite/karmasuite`, and it also reaches the worktrees. Since the vercel plugin's server has the same URL, those sessions keep only `vercel` (tools `mcp__vercel__*`). The pane asked only for `plugin:vercel:vercel` and got `no connected MCP tool "list_deployments" on a server named "plugin:vercel:vercel"`. New `callVercel` tries `VERCEL_SERVERS = ['plugin:vercel:vercel', 'vercel']` and remembers the one that answered (`vercelServer`).
- **Diagnostics added.** A failed preview poll logs `ks: PR previews unavailable, retrying every 2 min: <reason>` to the transcript, once per new reason (`previewFault`). An unreadable `list_deployments` answer now throws instead of silently showing nothing. This log line is what found the root cause.
- **Tests** (`hooks/live/live.test.ts`), 29 pass:
  - The "missing server" test now expects 2 calls per poll (one per name).
  - New: a failed call keeps the last preview.
  - New: a server answering only as `vercel` shows `▲ PREVIEW` and `open preview`.
- **Machine helpers** in `plugins/ks/scripts/`:
  - `quit-chrome`: uses `osascript` quit, then waits for `pgrep` to confirm.
  - `mem-info [N]`: pressure, Activity Monitor–style breakdown, swap, top processes.
  - Both are documented in `scripts/README.md` ("Machine helpers") and CLAUDE.md.
  - The user's `~/.claude/settings.json` (not in the repo) has them in `sandbox.excludedCommands`, `quit-chrome` in `permissions.ask`, and `pgrep` in excludedCommands and `permissions.allow`.
- This commit also carries earlier uncommitted work from before this session (RELEASES 2026-10-22):
  - `commands/project-manager.md` and `rules/ks-rules.md`: agents start the next session via `claude-ks-rc-restart`.
  - `commands/linear.md` rule 6: cycle moves always go through `bulk-update`.

## Key Decisions Made
- **No permanent "vercel missing" state.** Nothing distinguishes a missing server from one that is reconnecting, so the pane always retries at 2 min.
- **Fall back to the second server name in code** rather than deleting the project's `vercel` MCP entry, which is the user's config and works for the model too.
- **Failure reasons go to the transcript, once per new reason, not to the debug log.** These sessions run without `--debug`, so a debug-only line would never be seen.

## Deviations from Plan
None.

## Uncommitted Changes
None after this session's commit.

## Known Issues
- Not yet confirmed live: after the fix, the user hasn't confirmed the pills are back in the KAR-13293 / KAR-13197 sessions. A `--plugin-dir` session reloads the module at the end of its next turn.
- Mid-edit hot reloads briefly threw `ReferenceError: vercelMissing is not defined` in a live session. That was transient from a half-applied edit; the file has no reference left.
- Chrome relaunched after `quit-chrome` earlier (PID 32460). The user didn't ask to quit it again.

## Resume Point
1. In a karmasuite ticket session with a PR, send any message, then open `/ks-project`. Expect `▲ PREVIEW` / `▲ DEPLOYING` with `open preview` and `build logs`.
2. If no pill appears, grep that session's transcript (`~/.claude/projects/-Users-jassu-karmasuite-karmasuite-worktree-jaswanth-<slug>/<session>.jsonl`) for `PR previews unavailable` to get the reason.
3. Re-check tests with `claude plugin test plugins/ks` and `claude plugin validate plugins/ks`.
