# Phase 8: Linear Tickets Creation (Optional)

This phase creates Linear tickets from the user stories. This phase is optional - you may skip it if you prefer to create Linear tickets manually or don't need individual tickets for each feature.

## Command
`/prd-to-linear-tickets {project-directory-path}`

## Phase Name (for state.yaml)
`linear-tickets-creation`

## Execution Steps

1. Update phases array: Add `{number: 8, name: "linear-tickets-creation", status: "IN_PROGRESS", started_at: {timestamp}, ended_at: null}`
2. Run `/prd-to-linear-tickets {project-directory-path}`
3. The command will:
   - Read state.yaml for project ID
   - Read resources/user-stories.md for user stories (grouped by Feature)
   - Create a preview at `{project-directory-path}/resources/linear-tickets.md`
   - Ask user to approve before creating tickets in Linear
4. After the command completes, run `/create_handoff {project-directory-path}`
5. **Verify the tickets were created in Linear**
6. Ask user confirmation #1: "Phase 8 (Linear Tickets Creation) is complete. Should I mark it as COMPLETED?"
7. Update phases array: Set phase 8 `status: "COMPLETED"` and `ended_at: {timestamp}`
8. Ask user confirmation #2: "Ready to proceed to Phase 9 (Implementation Plan Creation)?"

## Example Command
```
/prd-to-linear-tickets workflow/jaswanth/basic-ability-to-rearrange-budget-category-rows-43d039de15eb
```

## Output Files
- `{project-dir}/resources/linear-tickets.md` - Linear tickets preview
- Linear tickets created in the project

## Special Instructions
- This phase is **optional** - offer to skip if user prefers manual ticket creation
- The command will show a preview and ask for approval before creating tickets

## Next Phase
Phase 9: Implementation Plan Creation
