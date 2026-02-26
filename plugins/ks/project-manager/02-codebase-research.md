# Phase 2: Codebase Research

This phase researches the codebase to understand existing patterns, architecture, and relevant code areas.

## Command
`/research_codebase {project-directory-path}`

## Phase Name (for state.yaml)
`codebase-research`

## Execution Steps

1. Run `/research_codebase {project-directory-path}`
2. Read and understand the research document (`{project-directory-path}/resources/codebase-research.md`)

## Post-Completion Steps

1. **Ticket workflow only**: Tell the user: "Phase 9 (Implementation Plan Creation) uses semantic code analysis. Please start a new session with `claude-ks-serena` to proceed."
2. **Project workflow**: Ask user confirmation: "Ready to proceed to Phase 3 (Initial PRD Draft)?"

## Example Command
```
/research_codebase workflow/jaswanth/basic-ability-to-rearrange-budget-category-rows-43d039de15eb
```

## Output Files
- `{project-dir}/resources/codebase-research.md` - Research document

## Next Phase

**Project workflow**: Phase 3: Initial PRD Draft

**Ticket workflow**: Phase 9: Implementation Plan Creation — user should launch with `claude-ks-serena`.
