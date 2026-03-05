# Phase 6: Product Requirements

This phase adds detailed product requirements to the Linear project.

## Command
`/ks:add-product-requirements {project-directory-path}`

## Phase Name (for state.yaml)
`product-requirements`

## Execution Steps

1. Run `/ks:add-product-requirements {project-directory-path}`
2. Verify the product requirements were added to Linear project

## Post-Completion Steps

1. Post a project update in Linear using the project ID from `state.yaml`:
   `linear project update <project-id> --body "Added Product requirements section. Please review @jon" --health onTrack`
   Show the update body to the user and ask for confirmation before posting.
2. Wait for user confirmation to proceed to Phase 7

## Example Command
```
/add-product-requirements workflow/jaswanth/basic-ability-to-rearrange-budget-category-rows-43d039de15eb
```

## Output Files
- `{project-dir}/resources/product_requirements.md` - Product requirements document
- Linear project updated with requirements

## Special Instructions
- Post project update in Linear using `linear project update` before proceeding

## Next Phase
Phase 7: TAD Creation
