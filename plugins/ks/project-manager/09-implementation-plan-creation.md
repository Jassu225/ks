# Phase 9: Implementation Plan Creation

This phase creates the detailed implementation plan. It runs in **plan mode** - the `/ks:create_plan` command will research the codebase, create a detailed implementation plan, and iterate with the user until satisfied.

This phase supports **iteration** — it can run multiple times, each producing a new numbered plan file. See the Phase 9-10 Iteration section in `project-manager.md` for the full mechanism.

## Command
`/ks:create_plan {project-directory-path}`

## Phase Name (for state.yaml)
`implementation-plan-creation`

## Critical Restrictions — ABSOLUTE BOUNDARY

**Phase 9 is STRICTLY a planning-only phase. You MUST NOT edit, create, or modify any source code files. ZERO implementation happens here.**

**FORBIDDEN actions in Phase 9:**
- Editing ANY source code, configuration, schema, or test files
- Creating new source files of any kind
- Running database migrations
- Installing or updating dependencies
- Creating to-do tasks for implementation
- Starting implementation of any kind — not even "small" or "preparatory" changes
- Updating Linear ticket statuses to "In Progress"

**PERMITTED actions in Phase 9:**
- Reading files (for research and understanding)
- Running research agents (codebase-locator, codebase-analyzer, codebase-pattern-finder)
- Writing ONLY the implementation plan document to `resources/implementation-plan-{NN}.md`
- Discussing the plan with the user
- Using `ExitPlanMode` to finalize the approved plan

**If you find yourself about to edit a file that is not the implementation plan, STOP. You are violating the Phase 9 boundary.** All implementation — without exception — happens in Phase 10.

## Execution Steps

1. **Determine the iteration number** from `state.yaml`. The iteration number is the length of the `iterations` array. If no `iterations` array exists, this is iteration 1.
2. **If iteration 2+**, read the previous plan (`implementation-plan-{NN-1}.md`) so the `/ks:create_plan` command has context on what was already planned and implemented.
3. Run `/ks:create_plan {project-directory-path}` (runs in plan mode)
4. The command will:
   - Research codebase patterns and analyze requirements
   - **If iteration 2+**: Reference the previous plan to understand what was already done, what needs changing, and what's new
   - Write the plan to Claude Code's plan file (temporary location)
   - Iterate with user until they are satisfied
   - Use `ExitPlanMode` to formally finalize the approved plan
   - **Copy the approved plan** from Claude Code plans directory to `{project-directory-path}/resources/implementation-plan-{NN}.md` (zero-padded iteration number)

## Post-Completion Steps

1. Tell the user: "Phase 10 (Implementation) uses semantic code analysis and automated PR review. Please start a new session with: `cd {cwd} && claude-ks-serena --plugin code-review@claude-plugins-official \"/ks:project-manager Let's work on ./{project-directory-path}/ project\"`" (where `{cwd}` is the current working directory of this Claude Code session)

## Example Command
```
/ks:create_plan workflow/jaswanth/basic-ability-to-rearrange-budget-category-rows-43d039de15eb
```

## Output Files
- `{project-dir}/resources/implementation-plan-{NN}.md` - Approved implementation plan (e.g., `implementation-plan-01.md`)

## Special Instructions
- This phase runs in plan mode - expect iteration with the user
- Do NOT start implementation - only create the plan
- Plan must be approved before moving to Phase 10
- **Iteration 2+**: Always read the previous plan first to provide context for the new plan. The new plan should reference what was already implemented and focus on what's new or changed.
- Previous plan files are never overwritten or deleted

## Next Phase
Phase 10: Implementation — user should launch with `cd {cwd} && claude-ks-serena --plugin code-review@claude-plugins-official "/ks:project-manager Let's work on ./{project-directory-path}/ project"`.
