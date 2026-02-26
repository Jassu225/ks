# Phase 5: Prototype Creation

This phase creates a prototype based on the user stories and requirements.

## Command
`/build-prototype {project-directory-path}`

## Phase Name (for state.yaml)
`prototype-creation`

## Execution Steps

1. Run `/build-prototype {project-directory-path}`
2. Verify the prototype was created

## Post-Completion Steps

1. Post a project update in Linear using the project ID from `state.yaml`:
   `linear project update <project-id> --body "Prototype created. Please review @jon" --health onTrack`
   Show the update body to the user and ask for confirmation before posting.
2. Wait for user confirmation to proceed to Phase 6

## Example Command
```
/build-prototype workflow/jaswanth/basic-ability-to-rearrange-budget-category-rows-43d039de15eb
```

## Output Files
- `{project-dir}/resources/prototype.md` - Prototype summary

## Special Instructions
- Post project update in Linear using `linear project update` before proceeding

## Next Phase
Phase 6: Product Requirements
