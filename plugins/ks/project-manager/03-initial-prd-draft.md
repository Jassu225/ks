# Phase 3: Initial PRD Draft

This phase creates the initial problem statement and writes it to the Linear project description.

## Command
`/write-problem-statement {project-directory-path}`

## Phase Name (for state.yaml)
`initial-prd-draft`

## Execution Steps

1. Update phases array: Add `{number: 3, name: "initial-prd-draft", status: "IN_PROGRESS", started_at: {timestamp}, ended_at: null}`
2. Run `/write-problem-statement {project-directory-path}`
3. After the command completes, run `/create_handoff {project-directory-path}`
4. **Verify the PRD was written to Linear project description**
5. Ask user confirmation #1: "Phase 3 (Initial PRD Draft) is complete. Should I mark it as COMPLETED?"
6. Update phases array: Set phase 3 `status: "COMPLETED"` and `ended_at: {timestamp}`
7. **Ask user**: "Please write a project update manually in Linear (e.g., 'Initial draft PRD is complete'). Once done, confirm to proceed to Phase 4."
8. Wait for user confirmation to proceed to Phase 4

## Example Command
```
/write-problem-statement workflow/jaswanth/basic-ability-to-rearrange-budget-category-rows-43d039de15eb
```

## Output Files
- `{project-dir}/resources/prd.md` - Problem statement document
- Linear project description updated

## Special Instructions
- Remind user to write manual project update in Linear before proceeding

## Next Phase
Phase 4: PRD User Stories
