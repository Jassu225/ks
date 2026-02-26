# Phase 9: Implementation Plan Creation

This phase creates the detailed implementation plan. It runs in **plan mode** - the `/create_plan` command will research the codebase, create a detailed implementation plan, and iterate with the user until satisfied.

## Command
`/create_plan {project-directory-path}`

## Phase Name (for state.yaml)
`implementation-plan-creation`

## Critical Restrictions

**This phase is ONLY for creating the implementation plan. Do NOT:**
- Create to-do tasks for implementation
- Start implementing any code
- Update Linear ticket statuses to "In Progress"

The actual implementation happens in Phase 10, not here.

## Execution Steps

1. Run `/create_plan {project-directory-path}` (runs in plan mode)
2. The command will:
   - Research codebase patterns and analyze requirements
   - Write the plan to Claude Code's plan file (temporary location)
   - Iterate with user until they are satisfied
   - Use `ExitPlanMode` to formally finalize the approved plan
   - **Copy the approved plan** from Claude Code plans directory to `{project-directory-path}/resources/implementation-plan.md`

## Post-Completion Steps

1. Tell the user: "Phase 10 (Implementation) uses semantic code analysis and automated PR review. Please start a new session with `claude-ks-serena --plugin code-review@claude-plugins-official` to proceed."

## Example Command
```
/create_plan workflow/jaswanth/basic-ability-to-rearrange-budget-category-rows-43d039de15eb
```

## Output Files
- `{project-dir}/resources/implementation-plan.md` - Approved implementation plan

## Special Instructions
- This phase runs in plan mode - expect iteration with the user
- Do NOT start implementation - only create the plan
- Plan must be approved before moving to Phase 10

## Next Phase
Phase 10: Implementation — user should launch with `claude-ks-serena --plugin code-review@claude-plugins-official`.
