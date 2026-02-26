# Phase 5: Prototype Creation

This phase creates a prototype based on the user stories and requirements.

## Command
`/build-prototype {project-directory-path}`

## Phase Name (for state.yaml)
`prototype-creation`

## Execution Steps

1. Update phases array: Add `{number: 5, name: "prototype-creation", status: "IN_PROGRESS", started_at: {timestamp}, ended_at: null}`
2. Run `/build-prototype {project-directory-path}`
3. After the command completes, run `/create_handoff {project-directory-path}`
4. **Verify the prototype was created**
5. Ask user confirmation #1: "Phase 5 (Prototype Creation) is complete. Should I mark it as COMPLETED?"
6. Update phases array: Set phase 5 `status: "COMPLETED"` and `ended_at: {timestamp}`
7. **Ask user**: "Please review the prototype and write a project update manually in Linear (e.g., 'Prototype created'). Once done, confirm to proceed to Phase 6."
8. Wait for user confirmation to proceed to Phase 6

## Example Command
```
/build-prototype workflow/jaswanth/basic-ability-to-rearrange-budget-category-rows-43d039de15eb
```

## Output Files
- `{project-dir}/resources/prototype.md` - Prototype summary

## Special Instructions
- Remind user to review the prototype and write manual project update in Linear before proceeding

## Next Phase
Phase 6: Product Requirements
