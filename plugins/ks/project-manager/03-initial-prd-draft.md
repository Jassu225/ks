# Phase 3: Initial PRD Draft

This phase creates the initial problem statement and writes it to the Linear project description.

## Command
`/ks:write-problem-statement {project-directory-path}`

## Phase Name (for state.yaml)
`initial-prd-draft`

## Execution Steps

1. Run `/ks:write-problem-statement {project-directory-path}`
2. Verify the PRD was written to Linear project description

## Post-Completion Steps

1. Post a project update in Linear using the project ID from `state.yaml`:
   `linear project update <project-id> --body "Initial draft PRD is complete. Please review @jon" --health onTrack`
   Show the update body to the user and ask for confirmation before posting.
2. Wait for user confirmation to proceed to Phase 4

## Example Command
```
/write-problem-statement workflow/jaswanth/basic-ability-to-rearrange-budget-category-rows-43d039de15eb
```

## Output Files
- `{project-dir}/resources/prd.md` - Problem statement document
- Linear project description updated

## Special Instructions
- Post project update in Linear using `linear project update` before proceeding

## Next Phase
Phase 4: PRD User Stories
