# Releases

## 2026-03-31 – 2026-04-01

- Neon branch protection hook
- Code-simplifier suggestion hook on Stop and SubagentStop events
- Slack CLI: shared lib, template frontmatter fields, raw template view
- Slack templates: tone field, updated LOOM_URL guidance; conditionally omit demo line when no Loom URL
- Rules: dynamic schema path, enforce template channel, DB views migration guidance
- create-worktree: preserve test-writer agent on cleanup
- Attachment CRUD and `--status` alias for Linear CLI
- Research agent model upgrade from Sonnet to Opus
- Extract shared lib modules from TS scripts
- Rename state.schema.json to project-state.schema.json

### Changes to workflow
- Linear tickets added as input to phases 9 and 10
- Feature flags mandated for project workflows (phases 3, 7, 9)
- Per-phase PRs for project workflows in Phase 10
- TAD and codebase research added as inputs to Phase 8
- user-context.md added as input to all workflow phases 3–9
- Inline phase files into project-manager.md, replace `KS_PHASE_FILES_DIR` with `KS_PLUGIN_DIR`

## 2026-03-16

### Features
- **remove_worktree** now safely preserves workflow data before removing a worktree:
  - Restores `.claude/` to clean state, then checks for uncommitted/untracked changes — aborts if dirty
  - Finds the matching `state.yaml` by `worktree_dir` and copies the workflow folder back to the main repo before removal
  - Aborts if no matching `state.yaml` is found, preventing workflow data loss
  - Must be run from `KS_PROJECT_ROOT_PATH`

### Other
- Architect command improvements (consumer impact analysis, no-duplicated-logic rules)
- `worktree_dir` field added to state schemas
- `KS_` prefix for `.config` vars with dotenv loading in all TS scripts
- Quality-files path fix

## 2026-03-13

### Features
- **Phase 9-10 iteration cycles**: Planning and implementation now support multiple iteration cycles. Each cycle produces a numbered implementation plan (`implementation-plan-01.md`, `-02.md`, etc.) tracked in `state.yaml` — enabling incremental delivery where each plan-implement cycle builds on the previous one. Added phase revisit mechanism with `REVISITING`/`INVALIDATED` states for when earlier decisions need to change.
- **Persistent task lists across sessions**: Task lists are now tied to the current git branch, so tasks persist across Claude Code sessions. Resuming work on a branch picks up where you left off.
- **Eval sets for all agents and commands**: Added `eval-set.json` files for every agent and command. These define structured test scenarios with inputs, expected behaviors, and scoring criteria — enabling automated evaluation and regression catching when updating prompts.

### Other
- Linear CLI: issue attachments command, `--full` includes attachments, fixed `--priority` type coercion
- Quality scripts: stderr output, exit code 2 for failures, typecheck filtering for changed files only
- Simplified Serena instructions across all agents; centralized KarmaSuite conventions in `ks-rules.md`
- Updated all command docs with ticket workflow support, orchestrator pattern, and stronger Phase 9 boundaries

## 2026-02-27

### Features
- **Multi-plugin monorepo restructure**: All plugin content now lives under `plugins/ks/`, enabling future plugins under `plugins/<name>/`
- **`--plugin` flag**: Enable plugins per session instead of managing them globally using `/plugin`
- **Automated Linear project updates** in phases 3, 5, 6, 7 using Linear project update CLI instead of manual prompts
- **Project manager auto-resume**: Now reads the latest handoff file automatically when resuming a project
- **Slack CLI**: Added `slack template list` and `slack template view` commands with template-first messaging workflow
- **Release announcement template** and channel IDs added to Slack templates
- **Research codebase** command now auto-reads Phase 1 user context instead of asking user to re-explain

### Improvements
- Simplified all 10 phase files — separated execution steps from post-completion steps into a consistent pattern
- Quality format/lint scripts now re-check after auto-fix to catch unfixable issues (parse errors, lint violations)
- Enforced Serena MCP as primary tool for all research agents with decision tree and NEVER rules for Grep symbol lookups
- Split README into monorepo-level and plugin-level docs

## 2026-02-18

### Initial Release
- **KS plugin for Claude Code**: Project and task management workflow orchestrator, installable as a plugin (disable anytime — except manually copied rules)
- **Scripts**: `create_worktree`, `remove_worktree`, `ks-start-ticket`, `ks-start-project`
- **Linear CLI**: Interact with Linear from the command line
- **Hooks**: Automated formatting, linting, and type checking
- **`ks-rules.md`**: Optional KarmaSuite coding conventions
- **Docs**: `README.md` (development setup), `WORKFLOW.md` (workflow understanding and usage)
