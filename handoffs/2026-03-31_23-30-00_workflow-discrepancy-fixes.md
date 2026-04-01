---
date: 2026-03-31T23:30:00+05:30
git_commit: 2b690b1
branch: main
task: Fix workflow discrepancies and add hooks
---

# Handoff: Workflow Discrepancy Fixes and Hook Additions

> See CLAUDE.md for dev guidance and plugins/ks/commands/project-manager.md for phase documentation.

## What Happened

Resumed from the previous session's workflow validation. Fixed the identified discrepancies between user's mental model and actual implementation across the 10-phase project manager workflow. Also added two new hooks (code-simplifier suggestion, Neon branch protection) and restructured how phase files are organized.

## Commits (8 total)

1. `ce73f8f` — Add `user-context.md` as input to all workflow phases (3-9)
2. `ed8ba6c` — Add TAD and codebase research as inputs to Phase 8 (linear tickets)
3. `e9bd870` — Add per-phase PRs for project workflows in Phase 10
4. `4650896` — Inline phase files into project-manager.md, replace `KS_PHASE_FILES_DIR` with `KS_PLUGIN_DIR`
5. `4a723b6` — Mandate feature flags for project workflows (phases 3, 7, 9)
6. `25a20ea` — Add `linear-tickets.md` as input to phases 9 and 10
7. `4025a4a` — Add code-simplifier suggestion hook on Stop and SubagentStop
8. `2b690b1` — Add Neon branch protection hook and fix code-simplifier hook

## Key Decisions Made

- **user-context.md is now a universal input** — every phase (3-9) reads it for foundational customer problem context.
- **Phase 8 gets full context** — now reads TAD (for technical complexity) and codebase research (for effort estimation) in addition to user stories.
- **Per-phase PRs for project workflows** — Phase 10 creates a PR per implementation phase against the project branch, with a final consolidated PR to main. Ticket workflows keep single-PR-at-the-end.
- **Feature flags are mandatory for project workflows** — enforced in Phase 3 (PRD checkbox), Phase 7 (TAD section), and Phase 9 (plan must include flag setup in Phase 1).
- **Phase files eliminated** — the 5 separate files in `project-manager/` were inlined into `project-manager.md`. Directory removed. `KS_PHASE_FILES_DIR` replaced with `KS_PLUGIN_DIR`.
- **linear-tickets.md added to phases 9 and 10** — both phases now read it alongside user-stories.md for Feature groupings and story points.
- **Code-simplifier hook** — on Stop/SubagentStop, if changed TS/TSX files exist, blocks the stop with a suggestion to run the `ks:code-simplifier` agent. Uses `stop_hook_active` to prevent recursion.
- **Neon branch protection hook** — PreToolUse hook on `mcp__Neon__.*` blocks calls targeting the production branch `br-round-breeze-217777`.

## Uncommitted Changes
None — working tree is clean.

## Known Issues
- The `plugins/ks/servers/` directory is still empty (from previous session). May want to remove it.

## Resume Point
1. Remaining workflow discrepancy: **Phase 5 (prototype) practice vs tooling gap** — tool builds in Claude Code but user uses Claude web. Decide if this needs addressing.
2. Test the new hooks in a real workflow run to verify behavior.
3. Consider whether `plugins/ks/servers/` should be removed.
