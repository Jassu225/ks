# Phase 6: Product Requirements

This phase adds detailed product requirements to the Linear project.

## Command
`/add-product-requirements {project-directory-path}`

## Phase Name (for state.yaml)
`product-requirements`

## Execution Steps

1. Update phases array: Add `{number: 6, name: "product-requirements", status: "IN_PROGRESS", started_at: {timestamp}, ended_at: null}`
2. Run `/add-product-requirements {project-directory-path}`
3. After the command completes, run `/create_handoff {project-directory-path}`
4. **Verify the product requirements were added to Linear project**
5. Ask user confirmation #1: "Phase 6 (Product Requirements) is complete. Should I mark it as COMPLETED?"
6. Update phases array: Set phase 6 `status: "COMPLETED"` and `ended_at: {timestamp}`
7. **Ask user**: "Please review the product requirements and write a project update manually in Linear (e.g., 'PRD complete'). Once done, confirm to proceed to Phase 7."
8. Wait for user confirmation to proceed to Phase 7

## Example Command
```
/add-product-requirements workflow/jaswanth/basic-ability-to-rearrange-budget-category-rows-43d039de15eb
```

## Output Files
- `{project-dir}/resources/product_requirements.md` - Product requirements document
- Linear project updated with requirements

## Special Instructions
- Remind user to review requirements and write manual project update in Linear before proceeding

## Next Phase
Phase 7: TAD Creation
