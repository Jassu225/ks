# Phase 2: Codebase Research

This phase researches the codebase to understand existing patterns, architecture, and relevant code areas.

## Command
`/research_codebase {project-directory-path}`

## Phase Name (for state.yaml)
`codebase-research`

## Execution Steps

1. Update phases array: Add `{number: 2, name: "codebase-research", status: "IN_PROGRESS", started_at: {timestamp}, ended_at: null}`
2. Run `/research_codebase {project-directory-path}`
3. After the command completes, run `/create_handoff {project-directory-path}`
4. **Read and understand the research document** (`{project-directory-path}/resources/codebase-research.md`)
5. Ask user confirmation #1: "Phase 2 (Codebase Research) is complete. Should I mark it as COMPLETED?"
6. Update phases array: Set phase 2 `status: "COMPLETED"` and `ended_at: {timestamp}`
7. Ask user confirmation #2: "Ready to proceed to Phase 3 (Initial PRD Draft)?"

## Example Command
```
/research_codebase workflow/jaswanth/basic-ability-to-rearrange-budget-category-rows-43d039de15eb
```

## Output Files
- `{project-dir}/resources/codebase-research.md` - Research document

## Next Phase
Phase 3: Initial PRD Draft
