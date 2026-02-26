# Phase 4: PRD User Stories

This phase creates detailed user stories based on the PRD.

## Command
`/prd {project-directory-path}`

## Phase Name (for state.yaml)
`prd-user-stories`

## Execution Steps

1. Update phases array: Add `{number: 4, name: "prd-user-stories", status: "IN_PROGRESS", started_at: {timestamp}, ended_at: null}`
2. Run `/prd {project-directory-path}`
3. After the command completes, run `/create_handoff {project-directory-path}`
4. **Read and understand the user stories document** (`{project-directory-path}/resources/user-stories.md`)
5. Ask user confirmation #1: "Phase 4 (PRD User Stories) is complete. Should I mark it as COMPLETED?"
6. Update phases array: Set phase 4 `status: "COMPLETED"` and `ended_at: {timestamp}`
7. **Ask user**: "Please write a project update manually in Linear (e.g., 'PRD user stories complete'). Once done, confirm to proceed to Phase 5."
8. Wait for user confirmation to proceed to Phase 5

## Example Command
```
/prd workflow/jaswanth/basic-ability-to-rearrange-budget-category-rows-43d039de15eb
```

## Output Files
- `{project-dir}/resources/user-stories.md` - User stories document

## Special Instructions
- Remind user to write manual project update in Linear before proceeding

## Next Phase
Phase 5: Prototype Creation
