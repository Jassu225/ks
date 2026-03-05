# Phase 10: Implementation

This phase implements the approved plan from Phase 9. The `/ks:implement-plan` command will execute each plan phase, run verification, and pause for human testing.

## Command
`/ks:implement-plan {project-directory-path}`

## Phase Name (for state.yaml)
`implementation`

## Execution Steps

1. Run `/ks:implement-plan {project-directory-path}`
2. The command will:
   - Read the implementation plan at `{project-directory-path}/resources/implementation-plan.md`
   - Execute each phase in the plan sequentially
   - Run automated verification (lint, type check, tests) after each phase
   - Pause for human manual verification between phases
   - Update plan checkboxes as work is completed
   - Create commits after each verified phase
3. After all plan phases are complete, create a PR using `/ks:create_pr`
4. **Code review**: After the PR is created, spawn a sub-agent to run the automated code review:
   ```
   Task(subagent_type: "general-purpose", prompt: "Run /code-review:code-review to review all changes in the current PR. Report back with any issues found.")
   ```
   Address any high-confidence issues the sub-agent reports before finalizing.

## Post-Completion Steps

1. Congratulate the user: "Project implementation complete! All phases have been successfully executed."

## Example Command
```
/ks:implement-plan workflow/jaswanth/basic-ability-to-rearrange-budget-category-rows-43d039de15eb
```

## Output Files
- Code changes committed to the repository
- `{project-dir}/resources/implementation-plan.md` - Updated with checkboxes marked complete

## Special Instructions
- This is the final phase - implementation of actual code
- Automated verification runs after each plan phase
- Human verification required between phases
- Commits created after each verified phase

## Next Phase
None - this is the final phase. Congratulate the user on completing the project!
