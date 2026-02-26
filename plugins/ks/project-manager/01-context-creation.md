# Phase 1: Context Creation

This phase creates the user context file. The state.yaml already exists in the project directory.

## Command
`/user-context-generator {project-directory-path}`

## Phase Name (for state.yaml)
`context-creation`

## Execution Steps

1. Update phases array: Add `{number: 1, name: "context-creation", status: "IN_PROGRESS", started_at: {timestamp}, ended_at: null}`
2. Run `/user-context-generator {project-directory-path}`
3. After the command completes, run `/create_handoff {project-directory-path}`
4. **Read and understand the context file**
5. Ask user confirmation #1: "Phase 1 (Context Creation) is complete. Should I mark it as COMPLETED?"
6. Update phases array: Set phase 1 `status: "COMPLETED"` and `ended_at: {timestamp}`
7. Tell the user: "Phase 2 (Codebase Research) uses semantic code analysis. Please start a new session with `claude-ks-serena` to proceed."

## Output Files
- `{project-dir}/resources/user-context.md` - User context document

## Next Phase
Phase 2: Codebase Research — user should launch with `claude-ks-serena`.
