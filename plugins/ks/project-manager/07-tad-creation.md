# Phase 7: TAD Creation

This phase creates the Technical Architecture Document (TAD) and attaches it to the Linear project.

## Command
`/write-tad {project-directory-path}`

## Phase Name (for state.yaml)
`tad-creation`

## Execution Steps

1. Run `/write-tad {project-directory-path}`
2. Verify the TAD was created and attached to Linear project

## Post-Completion Steps

1. Post a project update in Linear using the project ID from `state.yaml`:
   `linear project update <project-id> --body "Created draft TAD. Please review @jon" --health onTrack`
   Show the update body to the user and ask for confirmation before posting.
2. Wait for user confirmation to proceed to Phase 8

## Example Command
```
/write-tad workflow/jaswanth/basic-ability-to-rearrange-budget-category-rows-43d039de15eb
```

## Output Files
- `{project-dir}/resources/tad.md` - Technical Architecture Document
- Linear project updated with TAD attachment

## Special Instructions
- Post project update in Linear using `linear project update` before proceeding

## Next Phase
Phase 8: Linear Tickets Creation
