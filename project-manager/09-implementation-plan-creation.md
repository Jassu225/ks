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

1. Update phases array: Add `{number: 9, name: "implementation-plan-creation", status: "IN_PROGRESS", started_at: {timestamp}, ended_at: null}`
2. Run `/create_plan {project-directory-path}` (runs in plan mode)
3. The command will:
   - Research codebase patterns and analyze requirements
   - Write the plan to Claude Code's plan file (temporary location)
   - Iterate with user until they are satisfied
   - Use `ExitPlanMode` to formally finalize the approved plan
   - **Copy the approved plan** from Claude Code plans directory to `{project-directory-path}/resources/implementation-plan.md`
4. After user approves the plan, run `/create_handoff {project-directory-path}`
5. Ask user confirmation #1: "Phase 9 (Implementation Plan Creation) is complete. Should I mark it as COMPLETED?"
6. Update phases array: Set phase 9 `status: "COMPLETED"` and `ended_at: {timestamp}`
7. Ask user confirmation #2: "Ready to proceed to Phase 10 (Implementation)?"

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
Phase 10: Implementation
