# Releases

## 2026-10-31

- **Quality hooks run only in your project**: the format, lint and typecheck Stop hooks now run only in the repo set as `KS_PROJECT_ROOT_PATH` in `plugins/ks/.config` (by `./init`) and its worktrees. Everywhere else they exit without checking. Before, they ran in every repo a `claude-ks` session worked in, and in this plugin repo they failed on every stop with `Command "eslint" not found`, since it has no JS toolchain for them. The code-simplifier suggestion follows the same gate.
- **ks-flow: Done is a board column**: finished tickets now move to a **Done** column, the last column of their lane, as ordinary cards. They used to drop into two tables below the board ("Completed worktrees · not removed" and, behind **show completed**, "Completed · worktree removed"). Those tables showed no Inbox state, so a question from a Done ticket's session reached you only in the Inbox and as a notice. Done cards now show the **NEEDS YOU** sash, thread rows, backup/restore, reminders and Remove like any other card. **show removed** (formerly **show completed**) adds Done work whose worktree is gone, dimmed and Restore-only. The daemon keeps reading Done tickets from Linear while their worktree exists, so reopening one moves its card back to its phase column. Before, a Done ticket stopped being polled.
- **ks-flow shows the Plannotator Inbox on each card**: when an agent asks in the Inbox instead of the terminal, its card now says so. Before, a session waiting there looked idle in its tmux pane and on the board, and KAR-13197's two blocking questions went unseen for hours.
  - A diagonal **NEEDS YOU** sash goes across the card's top-right corner, red when the agent stopped until you answer. Clicking it opens the thread.
  - Each card gets one row per Inbox thread (`⛔ Stopped on you · 2 open questions · holds up: …`, `Inbox ↗`). A thread with only new messages gets a quiet `✉ 1 new message` row and no sash.
  - The card shows `⏳ waiting: Inbox`, and a macOS notice goes out when a new question arrives.
  - How it works: the daemon reads the Inbox's files read-only on its 15s clock (`src/lib/inbox.ts`), following the Inbox's own rules for when a question is open or answered. It never reads the Inbox token. The daemon now has tests (`cd plugins/ks-flow/src && npm test`).
- **Inbox threads join cards by session id only, with a guard on sends**: a card shows only questions and messages its own Claude sessions wrote. A message's sent-from folder (`base_path`) is ignored, and another session replying into the card's thread doesn't add its question to the card. A new `PreToolUse` hook (`scripts/inbox-guard.mjs`) refuses an Inbox `send_message` or `submit_guide` whose `project_path` is outside the session's own git checkout. It's a guard rail, not a lock: it only runs in sessions that load ks-flow, and the Inbox's stdio server and HTTP API accept any session id.

## 2026-10-30

- **PR previews come back after a dropped connection**: the `/ks-project` pane's Vercel pills (`▲ DEPLOYING`, `▲ PREVIEW`) no longer vanish for the rest of a session after one failed Vercel call. Any error other than an auth refusal (the MCP server still connecting at startup, reconnecting after sleep) was read as "vercel plugin not installed": the pane stopped asking and dropped the pills, leaving only the GitHub link until the session restarted. Now a failed call keeps the last preview shown and asks again at the 2-minute idle interval.
- **PR previews when the project has its own Vercel server**: the karmasuite project registers Vercel's MCP server itself, as `vercel` (same URL as the vercel plugin's). The session then keeps only that one, and the pane, which asked only for `plugin:vercel:vercel`, got "no connected MCP tool" on every call and showed no previews. The pane now tries both names and keeps using the one that answers. When previews can't be fetched, the session shows one line with the reason (`ks: PR previews unavailable, retrying every 2 min: …`), once for each new reason. An unreadable answer from Vercel now counts as a failure too; before, the pane showed nothing and gave no reason.
- **`quit-chrome` and `mem-info`**: two macOS helpers in `scripts/` for things the Bash sandbox blocks. `quit-chrome` quits Chrome cleanly and checks that it exited. `mem-info [N]` shows memory pressure, a usage breakdown as Activity Monitor counts it, swap, and the top processes by memory. An agent can run them only when they're in `excludedCommands` (see `scripts/README.md`, "Machine helpers").

## 2026-10-22

- **Agents start the next session themselves**: when you ask for a new session, or a phase boundary calls for one (`/ks:project-manager` after phases 1, 2 in a ticket workflow, 8 and 9), the agent offers to switch over. It runs `claude-ks-rc-restart --dry-run`, then the restart. The fresh session opens in the same tmux pane with the project-manager prompt and Remote Control on. Before, the agent said it couldn't start a session and handed you the `claude-ks` command: the phase-boundary text told it to, and the `ks-rules.md` section only covered Remote Control requests. The manual command remains the fallback when the dry run fails.
- **Linear — cycle moves always go through `bulk-update`**: `/ks:linear` rule 6 no longer reads as permission to loop `update --cycle` when the order matters. Move the issues with one `bulk-update`, then set their order per issue (`--position first`, then each `--after` the one before). If you haven't said where they go, the agent asks. Before, a session moved 4 tickets with 4 `update --cycle next --position last` calls and put them at the bottom, where you wanted them at the top.

## 2026-10-20

- **Relaunch a session with Remote Control**: `scripts/claude-ks-rc <dir>` starts `claude-ks --remote-control` in a directory: in a given tmux pane, a new tmux window, or this terminal. `scripts/claude-ks-rc-restart [<ticket>]` lets an agent swap its session for one with Remote Control on. It gets the ticket's live session (pid, tmux pane) from ks-flow, checks the pid with `ps`, kills the session from inside the tmux server, and starts a fresh session in the same pane. Its first message is the project-manager prompt, which picks up from the latest handoff. Both need `excludedCommands` entries to run from a sandboxed agent.
- **ks-flow knows each card's live session**: the daemon matches Claude's `~/.claude/sessions/<pid>.json` to cards by cwd and stores `liveSessions` / `activeSession` (pid, session id, tmux pane) on the work unit. A pid counts only while alive with its recorded start time. `ks-flow session <unit> --json` reads it back.

## 2026-10-19

- **Slack CLI — `--no-unfurl`** on `message send` and `message reply` posts without link or media previews (`unfurl_links`/`unfurl_media: false`). Fixed at send: Slack can't turn a preview on later. Refused with `--file`, whose upload API takes no unfurl flags.
- **PR review requests post without previews**: the `pr-review-request` template now sends with `--no-unfurl` unless you ask for previews. A message with files can't skip previews, so the agent says so and sends with previews on your confirmation.
- **PR review requests post in two parts**, like release announcements: the main message (title, PR link, project thread) in #engineering, then the `Changes:` bullets as a reply in its thread. Each part is shown for confirmation before posting; `review_thread` records the main message.
- **`ks-start-ticket` restores before it writes**: with ks-flow's cloud backup on, the restore offer now runs before `state.yaml` is read or written. Restore only fills in missing files, so the fresh `state.yaml` the script wrote first used to shadow the backed-up one on a machine without the ticket's folder: its phases, PRs and `time_spent` were dropped, and the next backup uploaded the fresh file over them. One `Restore?` question still covers both; the workflow folder comes back first (new `ks-flow restore --workflow-only --workflow-dir`), the sessions and time log once the worktree exists.
- **Linear — agents reach for the bulk commands**: `/ks:linear`'s workflow rules now say to use one `issue bulk-update` call when several issues get the same `--cycle`, `--state`, `--assignee` or `--priority`: `--dry-run` first, at most 50 issues, one team for `--cycle`/`--state`. Use per-issue `update` only when the manual order has to change, since `bulk-update` sends no `sortOrder`. To read many issues, use `issue batch-get`. Before, the rules pointed only to `issue update`, so a 46-ticket cycle move ran one ticket at a time. `issue update --help` now points to `bulk-update` too.

## 2026-10-15

- **Linear CLI — `project edit --content-file` / `--description-file`** (`-` = stdin), so a project description with quotes or backticks no longer goes inline. `/ks:add-product-requirements` now publishes `prd.md` this way.
- **Relative paths resolve from your directory**: the `linear`, `slack` and `grain` wrappers `cd` into `scripts/`, so a relative `--content-file`, `-f` or `-o` used to resolve there (ENOENT, or `grain` output landing in `scripts/`). They now pass `KS_ORIGINAL_DIR` and each CLI changes back to it on startup.
- **`document update --json`** returns the updated title (and now the `url`); it used to report the document as read before the update.

## 2026-10-14

- **Session name at launch**: `claude-ks` now starts a workflow checkout's session with `--name KAR-123` (or the project's workflow folder), from `scripts/session-title.sh --print`. The `SessionStart` hook's `sessionTitle` only reached the transcript: the peer name `ListAgents` prints and `SendMessage` takes is fixed at startup, so a new session answered to its derived `<folder>-<xx>` name until resumed. Skipped when you pass `--name`, `--resume` or `--continue` (a resumed session keeps its saved name). Only the name changes; the session ID is untouched.

## 2026-10-08

- **statusline — Linear link**: in a ks workflow checkout the statusline shows the ticket id (or `project`) as a clickable link to Linear, read from the `state.yaml` whose `worktree_dir` is the checkout.
- **Session name**: a `SessionStart` hook names the session after the checkout's ticket (`KAR-123`), or the project's workflow folder, so it can be messaged by that name (`SendMessage`). The workflow lookup moved to `scripts/workflow-unit`, shared with the statusline.
- **Project pane**: `/ks-project` (or the statusline's `≡ more`) opens a pane with the checkout's whole workflow state: ticket and Linear details, phases with times, every Slack thread, PRs with their review threads, and the worktree and workflow folder.
- **Split statusline**: in `claude-ks` sessions `scripts/statusline` draws the static half (session name, context, branch) and the ks plugin draws the interactive half in the prompt's hint line (`hooks/register.tsx`): the checkout's ticket as a clickable pill, its current phase and a status pill, `≡ more`, and the rate limits. `scripts/statusline` stops after its half when `KS_MOD_STATUSLINE` is set and keeps its full output in plain `claude` sessions.

## 2026-10-01

- **Linear CLI — cycles and manual order**:
  - `issue list --cycle current|next|previous|<number>|<id>` filters by cycle.
  - `issue list --sort manual|created|updated`. `manual` is the user's drag-and-drop order (`Issue.sortOrder`).
  - `issue create|update --cycle` moves an issue into a cycle. `update` also accepts `none`.
  - `issue create|update --position first|last`, `--after <id>` and `--before <id>` set the issue's manual order.
  - `issue get` shows the issue's cycle.
- **Linear CLI — relations**:
  - `issue relate <id> <others...> --type related|blocks|blocked-by|duplicate` links issues.
  - `issue unrelate <id> <others...>` removes the links.
  - `issue create --related <ids...>` links the new issue when it is created.
  - `issue get` always lists relations.
- **Linear CLI — `--description-file <path|->`** on `issue create|update` keeps markdown with backticks off the command line. Inline backticks make the command miss the sandbox exclusion.
- **gh-cli — stacked pull requests**:
  - New `gh stack` reference covering setup, create, view, rebase/sync, restructure, merge, exit codes and CI metadata.
  - GraphQL `stackEntry` query for a PR's stack membership.
  - Warning that `gh pr merge` cannot merge stacked PRs.
  - Notes that `--base <branch>` alone is not a native stack, and how to split a PR into a code PR and a stacked tests PR.
- **create_pr — native stacks**: when the target branch has an open PR, the new PR is linked onto it with `gh stack link`. If the extension is missing, the user is asked before it is installed.
- **prd-to-linear-tickets**: creates tickets with `--description-file` and `--estimate`, and links dependent Features with `issue relate --type blocks`.

## 2026-04-01

- **Statusline script**: Custom statusline showing context window usage, git branch, and rate limit info (5h/7d windows with color-coded usage and reset countdowns). Wraps to two lines when branch name exceeds 32 characters.
- **Statusline**: Use muted red (`167`) instead of bright red (`196`) for high-usage color — easier on dark terminals
- **Hooks**: Removed code-simplifier suggestion hook from Stop and SubagentStop events (command still available manually)

## 2026-03-31 – 2026-04-01

- Neon branch protection hook
- Code-simplifier suggestion hook on Stop and SubagentStop events
- Slack CLI: shared lib, template frontmatter fields, raw template view
- Slack templates: tone field, updated LOOM_URL guidance; conditionally omit demo line when no Loom URL
- Rules: dynamic schema path, enforce template channel, DB views migration guidance
- create-worktree: preserve test-writer agent on cleanup
- Attachment CRUD and `--status` alias for Linear CLI
- Research agent model upgrade from Sonnet to Opus
- Extract shared lib modules from TS scripts
- Rename state.schema.json to project-state.schema.json

### Changes to workflow
- Linear tickets added as input to phases 9 and 10
- Feature flags mandated for project workflows (phases 3, 7, 9)
- Per-phase PRs for project workflows in Phase 10
- TAD and codebase research added as inputs to Phase 8
- user-context.md added as input to all workflow phases 3–9
- Inline phase files into project-manager.md, replace `KS_PHASE_FILES_DIR` with `KS_PLUGIN_DIR`

## 2026-03-16

### Features
- **remove_worktree** now safely preserves workflow data before removing a worktree:
  - Restores `.claude/` to clean state, then checks for uncommitted/untracked changes — aborts if dirty
  - Finds the matching `state.yaml` by `worktree_dir` and copies the workflow folder back to the main repo before removal
  - Aborts if no matching `state.yaml` is found, preventing workflow data loss
  - Must be run from `KS_PROJECT_ROOT_PATH`

### Other
- Architect command improvements (consumer impact analysis, no-duplicated-logic rules)
- `worktree_dir` field added to state schemas
- `KS_` prefix for `.config` vars with dotenv loading in all TS scripts
- Quality-files path fix

## 2026-03-13

### Features
- **Phase 9-10 iteration cycles**: Planning and implementation now support multiple iteration cycles. Each cycle produces a numbered implementation plan (`implementation-plan-01.md`, `-02.md`, etc.) tracked in `state.yaml` — enabling incremental delivery where each plan-implement cycle builds on the previous one. Added phase revisit mechanism with `REVISITING`/`INVALIDATED` states for when earlier decisions need to change.
- **Persistent task lists across sessions**: Task lists are now tied to the current git branch, so tasks persist across Claude Code sessions. Resuming work on a branch picks up where you left off.
- **Eval sets for all agents and commands**: Added `eval-set.json` files for every agent and command. These define structured test scenarios with inputs, expected behaviors, and scoring criteria — enabling automated evaluation and regression catching when updating prompts.

### Other
- Linear CLI: issue attachments command, `--full` includes attachments, fixed `--priority` type coercion
- Quality scripts: stderr output, exit code 2 for failures, typecheck filtering for changed files only
- Simplified Serena instructions across all agents; centralized KarmaSuite conventions in `ks-rules.md`
- Updated all command docs with ticket workflow support, orchestrator pattern, and stronger Phase 9 boundaries

## 2026-02-27

### Features
- **Multi-plugin monorepo restructure**: All plugin content now lives under `plugins/ks/`, enabling future plugins under `plugins/<name>/`
- **`--plugin` flag**: Enable plugins per session instead of managing them globally using `/plugin`
- **Automated Linear project updates** in phases 3, 5, 6, 7 using Linear project update CLI instead of manual prompts
- **Project manager auto-resume**: Now reads the latest handoff file automatically when resuming a project
- **Slack CLI**: Added `slack template list` and `slack template view` commands with template-first messaging workflow
- **Release announcement template** and channel IDs added to Slack templates
- **Research codebase** command now auto-reads Phase 1 user context instead of asking user to re-explain

### Improvements
- Simplified all 10 phase files — separated execution steps from post-completion steps into a consistent pattern
- Quality format/lint scripts now re-check after auto-fix to catch unfixable issues (parse errors, lint violations)
- Enforced Serena MCP as primary tool for all research agents with decision tree and NEVER rules for Grep symbol lookups
- Split README into monorepo-level and plugin-level docs

## 2026-02-18

### Initial Release
- **KS plugin for Claude Code**: Project and task management workflow orchestrator, installable as a plugin (disable anytime — except manually copied rules)
- **Scripts**: `create_worktree`, `remove_worktree`, `ks-start-ticket`, `ks-start-project`
- **Linear CLI**: Interact with Linear from the command line
- **Hooks**: Automated formatting, linting, and type checking
- **`ks-rules.md`**: Optional KarmaSuite coding conventions
- **Docs**: `README.md` (development setup), `WORKFLOW.md` (workflow understanding and usage)
