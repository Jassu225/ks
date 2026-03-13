# Phase 10: Implementation

This phase implements the approved plan from Phase 9 using the `/ks:implement-plan` command, which orchestrates parallel subagents to execute the plan efficiently.

This phase supports **iteration** — it runs once per Phase 9 iteration, always picking up the latest numbered plan file. See the Phase 9-10 Iteration section in `project-manager.md` for the full mechanism.

## Command
`/ks:implement-plan {project-directory-path}`

## Phase Name (for state.yaml)
`implementation`

## What the Command Does

The main agent acts as an **orchestrator** — it does not read the plan or codebase itself. It spawns an analysis subagent to Ultrathink → asks clarifying questions → creates a task list → executes tasks using up to 5 parallel subagents per phase, with human verification between phases.

The command handles the full workflow: plan analysis, parallel subagent execution, per-phase verification, and post-implementation steps (PR creation via `/ks:create_pr`, automated code review, and user congratulation).

## Execution Steps

1. **Determine the iteration number** from `state.yaml`. The iteration number is the length of Phase 9's `iterations` array. If no `iterations` array exists, this is iteration 1.
2. **Find the plan file**: Use the iteration number to locate `{project-directory-path}/resources/implementation-plan-{NN}.md` (e.g., `implementation-plan-01.md` for iteration 1).
3. Run `/ks:implement-plan {project-directory-path}` — the command reads the plan file path from the convention above.

## Output Files
- Code changes committed to the repository
- `{project-dir}/resources/implementation-plan-{NN}.md` - Updated with checkboxes marked complete

## Post-Command Bookkeeping

After `/ks:implement-plan` completes (all phases committed and PR created), the **project-manager** handles the remaining bookkeeping:

1. Mark phase 10 as `COMPLETED` in `state.yaml`
2. Run `/ks:create_handoff` to generate the final handoff document

## Next Phase

After completion, the user may:
- **Start a new iteration**: Go back to Phase 9 to create another plan (iteration bumps automatically)
- **Finish**: This was the final phase — project is done
