---
date: 2026-10-08T14:14:27+05:30
git_commit: 4f84cb6
branch: main
task: create_pr native stacks; ks statusline link; session name hook; split statusline (script + mod); /ks-project pane
---

# Handoff: ks Statusline Mod, Session Name Hook and Project Pane

> See docs/product-overview.md for product context, docs/tech-stack.md for dependencies, and CLAUDE.md for dev guidance.

## What Happened

1. **Native stacks in `/ks:create_pr`** (uncommitted from the previous session, committed now).
   - Step 9 links a PR onto its base PR with `gh stack link` when `$2` has an open PR.
   - gh-cli notes that `--base` alone is not a native stack, and gives the code-PR / tests-PR split recipe.
   - Not run live: `gh` can't reach api.github.com from the sandbox.

2. **Shell statusline: Linear link.**
   - `scripts/workflow-unit` is a new shared lookup. It finds the `state.yaml` whose `worktree_dir` is the git root, else (older states) the ticket id in the branch name.
   - `scripts/statusline` prints the ticket as an OSC 8 link.

3. **Session name hook.** `scripts/session-title.sh` runs on SessionStart (startup, resume, clear).
   - It returns `sessionTitle` = `KAR-123`, or a project's workflow folder name.
   - That value is also the peer name `SendMessage` uses, so it is kept short. The first version (`KAR-123 · title`) made peer names unusable.

4. **Mods (Claude Code function hooks) in the ks plugin.** The design went through several iterations:
   - band above the prompt → gradient Raster bar → bordered band;
   - then statusline-as-mod;
   - final: a **split statusline**.

   Final state:
   - `scripts/statusline`, under `claude-ks` (`KS_MOD_STATUSLINE=1`), prints only `@session | context | branch`. Plain `claude` keeps its full output.
   - The mod draws one row in the `PromptHint` site, under the engine's own hint line (`next(e)`): the ticket pill (link), the current phase with a "phase" suffix, the status pill, `≡ more`, and the rate limits.
   - A **`/ks-project` pane** (and `≡ more`) shows the whole `state.yaml`:
     - Linear status pill; phase + status (the same `workflowStatus()` the statusline uses);
     - phases with local times, durations and iterations; the in-progress dot pulses (1-cell Raster, `$.ui.blit` every 80ms);
     - Slack threads; PRs with review threads; Linear parent/related tickets;
     - worktree and workflow folder, each with a copy button.
   - It parses the full YAML with `node` + the `yaml` package in `scripts/node_modules`.
   - One `linkTo` (underlined text + `↗`) and one `pill` helper draw every link and pill.

5. **Feedback sent to Anthropic** (receipts eb7c9f4f…, 271e58a0…, f6562c02…, plus the first one):
   - engine-owned blank rows around the band and hint line;
   - the `PromptHint` tree cut when the task list shows;
   - the hint line cut with the pane open while idle;
   - the gap growing per spawned agent.

## Key Decisions Made

- **A plugin gets exactly one hooks module.** `claude plugin validate` refuses a second `modules` entry. So `hooks/register.tsx` holds every hook.
  - Pure logic lives in `hooks/statusline/` (workflow parse, usage) and `hooks/project/` (info builder, pulse).
  - `$` can only be passed to functions declared at the top of the same file.
- **Mods can't draw the settings statusLine area or the permission dialog.** Hence the split statusline. Approval context would only be `$.ui.notice` lines (proposed, not built).
- **Engine-drawn things a mod can't change:** the band's `[-]`, the blank row above the prompt, hover is an instant style swap (no transitions), and the cursor shape.
- **The user does not want shell scripts ported to mods unprompted.** Saved to memory `feedback_no_port_shell_to_mods`. The statusline split was explicitly requested.
- `plugins/ks/tsconfig.json` is committed: a one-line stub that extends the engine-generated `.claude-plugin/types/` (which carries its own `.gitignore`).

## Deviations from Plan

The band was built, iterated on and then removed entirely in favour of the split statusline plus the pane, at the user's direction.

## Uncommitted Changes

None (committed in this session).

## Known Issues

- **Hint-line clipping (Claude Code side, reported):** with the task list showing, the mod row can be cut. With the pane open while idle, the hint and permission lines are cut.
- **Ticket-pill hover** uses a keyed-Box hover. It is not verified in all terminals, and needs the terminal to report pointer motion.
- **The Linear status** in the pane is the snapshot `ks-start-ticket` recorded. It is not live; fetching it with `linear issue get` was offered.
- **`claude plugin validate`** warns about unquoted `${CLAUDE_PLUGIN_ROOT}` in the existing Stop/Neon hooks. These predate this session and were left alone.
- **`usage.ts` was edited by another pass** (`roundHalfEven`, NaN-safe resets). It was kept as is.
- **Carried over:**
  - `ks-start-project.ts:523` still recreates `state.yaml`.
  - The gh `stackEntry` query is unverified.

## Resume Point

- **Check after edits:**
  - `claude plugin validate plugins/ks`
  - `claude plugin test plugins/ks` (18 tests)
  - `plugins/ks/scripts/node_modules/.bin/tsc -p plugins/ks`
- **Proposed next mod:** an approval-context module, `hooks/approval/`, mapping commands to one `$.ui.notice` line under the permission prompt:
  - git commit: branch, files, message;
  - git push: ahead count, force/origin warning;
  - slack send: channel, unresolved @handles;
  - gh pr: base/head, Closes ref.

  The user asked "mod or generalise?". The recommendation is to generalise. Waiting on a go-ahead.
- **Possible:** a live Linear status in the pane via `linear issue get` on open.
