# Phase 1: Context Creation

This phase creates the user context file. The state.yaml already exists in the project directory.

## Command
`/ks:user-context-generator {project-directory-path}`

## Phase Name (for state.yaml)
`context-creation`

## Execution Steps

1. Run `/ks:user-context-generator {project-directory-path}`
2. Read and understand the generated context file

## Post-Completion Steps

1. Tell the user: "Phase 2 (Codebase Research) uses semantic code analysis. Please start a new session with `claude-ks-serena` to proceed."

## Output Files
- `{project-dir}/resources/user-context.md` - User context document

## Next Phase
Phase 2: Codebase Research — user should launch with `claude-ks-serena`.
