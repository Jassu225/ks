---
date: 2026-06-19T01:23:11+05:30
git_commit: 6798e81
branch: feat/ks-flow-plugin
task: Drop the code-review@claude-plugins-official plugin in favor of the built-in /code-review (Phase 9→10 launch + all command/doc references), and diagnose "no notifications" as a macOS Focus suppression (not a ks-flow bug). README Focus note pending commit.
---

# Handoff: code-review → built-in + notification Focus diagnosis

> Continues `2026-06-18_21-07-02_ks-flow-notification-reliability-and-kst-plugin-load.md`. Plugin docs: `plugins/ks-flow/README.md`; ks workflow: `plugins/ks/commands/project-manager.md`, `CLAUDE.md`.

## What Happened

Short follow-up session after the big notification-reliability pass. Two threads:

### 1. code-review plugin → built-in `/code-review` (committed: d074984, 6798e81)
User asked whether the code-review plugin was removed from "phase 9". Findings: it was never *in* Phase 9 (plan mode) — the only loader was the **Phase 9 post-completion line** that launches the **Phase 10** session with `--plugin code-review@claude-plugins-official` (`project-manager.md:73`). Per user direction:
- **`d074984`** — removed `--plugin code-review@claude-plugins-official` from the Phase 9→10 launch command. Phase 10 sessions no longer auto-load the plugin.
- User then said keep the Phase 10 review steps because "code review is built in anyway" → **`6798e81`** repointed every `/code-review:code-review` (plugin-namespaced) reference to the built-in **`/code-review`**: `implement-plan.md` (both Phase 10 sub-agents, lines ~333/343), `create_pr.md`, `ks-rules.md`, and `CLAUDE.md` (setup section reworded to "Code Review — built in", command table, and the integrations section moved out of "External Plugin Integrations"). Verified no `code-review:code-review` refs remain. `architect.md`'s "Code Review" is the architect's own `code` mode — left alone (unrelated to the plugin).

### 2. "No notifications in some time" → macOS Focus, NOT ks-flow (no code change)
Debugged live against the karmasuite daemon (pid 35356, up since 15:00). Everything ks-flow was healthy: `events.jsonl` appending (Stops + PermissionRequests after 19:36, e.g. Stop 19:42:11 kar-12243), offset==size (all consumed), daemon alive, units kar-12243 / kar-12352 matched (worktreeDir set) + `unitCompleted:false`, terminal-notifier present at `/opt/homebrew/bin`, settings `enabled`. A manual `terminal-notifier … -group ks-flow-test` returned exit 0; user saw nothing — but a re-fire printed **`* Removing previously sent notification…`**, proving it *had* posted to Notification Center. ⇒ **a Focus/DND mode was silencing the banner.** Opened the Notifications + Focus settings panes for the user; once Focus was adjusted, notices fired ("now firing").

Also confirmed in passing: kar-12352 correctly did NOT nudge — its last Stop (19:32:40) was followed by transcript activity at 19:36:50 (> 30s resume margin) → resume-gate dropped it; no later Stop re-armed it. Correct behavior. And `board-settings.json` has a vestigial `notify.sender: "com.apple.Terminal"` — **not read anywhere** (only in comments); harmless leftover from the reverted -sender experiment.

## Key Decisions Made
- **Built-in `/code-review` over the external plugin** — user's call ("built in anyway"). Single, namespace-free command across all docs/commands.
- **Kept the Phase 10 review steps** (didn't delete them) — they now invoke the built-in, which resolves without any plugin enabled.
- **Don't debug the daemon for "silent notifications" until a manual terminal-notifier banner is confirmed visible** — Focus/DND is the usual cause. Saved as auto-memory `project_ksflow_notifications_focus_gotcha`.

## Deviations from Plan
- None.

## Uncommitted Changes
`plugins/ks-flow/README.md` — added the **"Silent but everything looks fine? Check Focus first."** troubleshooting note to the Notifications section. About to commit as the final step of this request.

## Known Issues
- Vestigial `notify.sender` key in `board-settings.json` (unused). Could be pruned from `boardsettings.ts` defaults + the file for tidiness; not urgent.
- Focus-suppression is environmental (user machine), not fixable in code — documented in README + memory.

## Resume Point
1. **Commit + push the README Focus note** to both remotes (jassu + origin): `git add plugins/ks-flow/README.md && git commit && git push jassu feat/ks-flow-plugin && git push origin feat/ks-flow-plugin` — verify tips match.
2. Notifications are confirmed working end-to-end (user: "now firing"). Daemon live (pid 35356). No outstanding ks-flow bugs.
3. Optional cleanup if desired: drop the unused `notify.sender` from `board-settings.json` + `src/lib/boardsettings.ts`.
4. This whole feature branch (`feat/ks-flow-plugin`) is a long-lived series of ks-flow + ks commits — when ready, it's a candidate for a PR to `main` (use `/ks:create_pr`).
