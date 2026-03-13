# Phase 8: Linear Tickets Creation (Optional)

This phase creates Linear tickets from the user stories. This phase is optional - you may skip it if you prefer to create Linear tickets manually or don't need individual tickets for each feature.

## Command
`/ks:prd-to-linear-tickets {project-directory-path}`

## Phase Name (for state.yaml)
`linear-tickets-creation`

## Execution Steps

1. Run `/ks:prd-to-linear-tickets {project-directory-path}`
2. The command will:
   - Read state.yaml for project ID
   - Read resources/user-stories.md for user stories (grouped by Feature)
   - Create a preview at `{project-directory-path}/resources/linear-tickets.md`
   - Ask user to approve before creating tickets in Linear
3. Verify the tickets were created in Linear

## Post-Completion Steps

1. Tell the user: "Phase 9 (Implementation Plan Creation) uses semantic code analysis. Please start a new session with: `cd {cwd} && claude-ks-serena \"/ks:project-manager Let's work on ./{project-directory-path}/ project\"`" (where `{cwd}` is the current working directory of this Claude Code session)

## Example Command
```
/ks:prd-to-linear-tickets workflow/jaswanth/basic-ability-to-rearrange-budget-category-rows-43d039de15eb
```

## Output Files
- `{project-dir}/resources/linear-tickets.md` - Linear tickets preview
- Linear tickets created in the project

## Special Instructions
- This phase is **optional** - offer to skip if user prefers manual ticket creation
- The command will show a preview and ask for approval before creating tickets

## Next Phase
Phase 9: Implementation Plan Creation — user should launch with `cd {cwd} && claude-ks-serena "/ks:project-manager Let's work on ./{project-directory-path}/ project"`.
