---
description: Create detailed implementation plans from PRDs for KarmaSuite features through interactive research
argument-hint: [project-directory-path]
allowed-tools: Read, Write, Edit, Glob, Grep, Task, AskUserQuestion, ExitPlanMode, Bash(linear:*)
plan-mode: true
---

# Implementation Plan Creator

**This command runs in PLAN MODE.** You MUST call `EnterPlanMode` immediately before doing anything else. Do not read files, do not research — enter plan mode first. Focus on research, analysis, and planning. When the plan is finalized and the user is satisfied, use `ExitPlanMode` to formally approve the plan.

You are tasked with creating detailed implementation plans for KarmaSuite features through an interactive, iterative process. You should be skeptical, thorough, and work collaboratively with the user to produce high-quality technical specifications.

## Input & Output

**Input:** A project directory path provided via arguments: `$ARGUMENTS`
- State file: `{project-directory-path}/state.yaml` (for project ID/URL and **workflow type**)
- Research file: `{project-directory-path}/resources/codebase-research.md`

**Additional inputs depend on workflow type** (detected from `state.yaml` root key):

**Project workflow** (`project` key in state.yaml — all 10 phases):
- User context: `{project-directory-path}/resources/user-context.md`
- Problem statement (optional): `{project-directory-path}/resources/prd.md`
- User stories: `{project-directory-path}/resources/user-stories.md`
- Prototype summary: `{project-directory-path}/resources/prototype.md`
- TAD document: `{project-directory-path}/resources/tad.md`
- Linear tickets: `{project-directory-path}/resources/linear-tickets.md`

**Ticket workflow** (`ticket` key in state.yaml — phases 1, 2, 9, 10 only):
- Linear ticket details: fetched via `linear issue get {ticket.identifier}` (the ticket identifier comes from `state.yaml`)
- User context: `{project-directory-path}/resources/user-context.md`
- Note: `user-stories.md`, `prototype.md`, `tad.md`, `prd.md`, and `linear-tickets.md` do NOT exist in ticket workflows — phases 3-8 are skipped

**Output:** Implementation plan at `{project-directory-path}/resources/implementation-plan-{NN}.md` (zero-padded iteration number, e.g., `implementation-plan-01.md`)

Example invocation:
```
/ks:create_plan workflow/jaswanth/budget-category-reordering
```

## Initial Response

When this command is invoked:

1. **Check if project directory was provided**:
   - If provided as a parameter, immediately read `state.yaml` and begin the research process
   - If NOT provided, ask: "I need a project directory path to proceed. Please provide the path (e.g., 'workflow/jaswanth/budget-category-reordering')."

2. **Read state.yaml and detect workflow type**:
   - Read `{project-directory-path}/state.yaml`
   - **Detect workflow type**: Check if the root key is `project` or `ticket`
     - `ticket` key → **Ticket Workflow** (phases 3-8 were skipped)
     - `project` key → **Project Workflow** (all phases available)
   - **Determine iteration number**: Count the entries in Phase 9's `iterations` array in state.yaml. If no array exists, this is iteration 1. The output file will be `implementation-plan-{NN}.md` (zero-padded).

3. **Check for previous plan iterations**:
   - Look for existing plan files: `{project-directory-path}/resources/implementation-plan-*.md`
   - **If previous plans exist** (iteration 2+):
     - Read the latest previous plan fully — it provides essential context on what was already planned and implemented
     - Note which sections were completed (checked boxes) vs incomplete
     - The new plan should reference what was already done and focus on what's new or changed

4. **Read input files based on workflow type**:

   **For project workflows — read all project files:**
   - Read `{project-directory-path}/resources/user-context.md`
   - Read `{project-directory-path}/resources/prd.md` (if exists)
   - Read `{project-directory-path}/resources/user-stories.md`
   - Read `{project-directory-path}/resources/prototype.md`
   - Read `{project-directory-path}/resources/tad.md`
   - Read `{project-directory-path}/resources/linear-tickets.md`
   - Read `{project-directory-path}/resources/codebase-research.md`

   **For ticket workflows — fetch ticket details from Linear:**
   - Run `linear issue get {ticket.identifier}` to fetch full ticket details (description, comments, labels, assignee, priority)
   - Read `{project-directory-path}/resources/user-context.md` (if exists)
   - Read `{project-directory-path}/resources/codebase-research.md`
   - Do NOT attempt to read `user-stories.md`, `prototype.md`, `tad.md`, `prd.md`, or `linear-tickets.md` — these files do not exist in ticket workflows

## Process Steps

### Step 1: Context Gathering & Initial Analysis

1. **Read all context files immediately and FULLY** (based on workflow type detected in step 2):

   **For project workflows:**
   - State file to get project info (ID, name, URL)
   - User context for original customer problem, workflow, solution, and assumptions
   - PRD for problem context (if exists)
   - User stories for detailed requirements
   - Prototype summary for implementation decisions already made
   - TAD for technical architecture decisions
   - Linear tickets for work breakdown and priorities (if exists)
   - Research documents for codebase patterns and insights

   **For ticket workflows:**
   - State file to get ticket info (identifier, name, URL)
   - Linear ticket details via `linear issue get {ticket.identifier}` (description, comments, labels, priority)
   - User context: `{project-directory-path}/resources/user-context.md` (if exists)
   - Research documents for codebase patterns and insights
   - Do NOT attempt to read `user-stories.md`, `prototype.md`, `tad.md`, `prd.md`, or `linear-tickets.md`

   **For iteration 2+ (both workflow types):**
   - Previous plan file(s): `{project-directory-path}/resources/implementation-plan-*.md`
   - Read the latest previous plan fully to understand what was already planned and implemented
   - Note completed items (checked boxes) — these represent work already done
   - The new plan should build on this context, not repeat completed work

   - **IMPORTANT**: Use the Read tool WITHOUT limit/offset parameters to read entire files
   - **CRITICAL**: DO NOT spawn sub-tasks before reading these files yourself in the main context

2. **Spawn initial research tasks to gather additional context**:
   Before asking the user any questions, use specialized agents to research in parallel:

   - Use **codebase-locator** agent to find all files related to the feature
   - Use **codebase-analyzer** agent to understand how current implementations work
   - Use **codebase-pattern-finder** agent to find similar features to model after

   **Serena MCP**: When Serena is available, codebase agents must use Serena tools for symbol-based queries.

   These agents will:
   - Find relevant source files, configs, and tests
   - Identify the specific directories to focus on
   - Trace data flow and key functions
   - Return detailed explanations with file:line references

3. **Read all files identified by research tasks**:
   - After research tasks complete, read ALL files they identified as relevant
   - Read them FULLY into the main context
   - This ensures you have complete understanding before proceeding

4. **Analyze and verify understanding**:
   - **Project workflows**: Cross-reference user stories and TAD decisions with actual code
   - **Ticket workflows**: Cross-reference the Linear ticket description and acceptance criteria with actual code
   - Identify any discrepancies or misunderstandings
   - Note assumptions that need verification
   - Determine true scope based on codebase reality

5. **Present informed understanding and focused questions**:
   ```
   Based on the [PRD, TAD / Linear ticket details] and my research of the codebase, I understand we need to [accurate summary].

   I've found that:
   - [Current implementation detail with file:line reference]
   - [Relevant pattern or constraint discovered]
   - [Potential complexity or edge case identified]

   Questions that my research couldn't answer:
   - [Specific technical question that requires human judgment]
   - [Business logic clarification]
   - [Design preference that affects implementation]
   ```

   Only ask questions that you genuinely cannot answer through code investigation.

### Step 2: Research & Discovery

After getting initial clarifications:

1. **If the user corrects any misunderstanding**:
   - DO NOT just accept the correction
   - Spawn new research tasks to verify the correct information
   - Read the specific files/directories they mention
   - Only proceed once you've verified the facts yourself

2. **Spawn parallel sub-tasks for comprehensive research**:
   - Create multiple Task agents to research different aspects concurrently
   - Use the right agent for each type of research:

   **For deeper investigation:**
   - **codebase-locator** - To find more specific files (e.g., "find all files that handle [specific component]")
   - **codebase-analyzer** - To understand implementation details (e.g., "analyze how [system] works")
   - **codebase-pattern-finder** - To find similar features we can model after

   Each agent knows how to:
   - Find the right files and code patterns
   - Identify conventions and patterns to follow
   - Look for integration points and dependencies
   - Return specific file:line references
   - Find tests and examples

3. **Wait for ALL sub-tasks to complete** before proceeding

4. **Present findings and design options**:
   ```
   Based on my research, here's what I found:

   **Current State:**
   - [Key discovery about existing code]
   - [Pattern or convention to follow]

   **Design Options:**
   1. [Option A] - [pros/cons]
   2. [Option B] - [pros/cons]

   **Open Questions:**
   - [Technical uncertainty]
   - [Design decision needed]

   Which approach aligns best with your vision?
   ```

### Step 3: Plan Structure Development

Once aligned on approach:

1. **Create initial plan outline**:
   ```
   Here's my proposed plan structure:

   ## Overview
   [1-2 sentence summary]

   ## Implementation Phases:
   1. [Phase name] - [what it accomplishes]
   2. [Phase name] - [what it accomplishes]
   3. [Phase name] - [what it accomplishes]

   Does this phasing make sense? Should I adjust the order or granularity?
   ```

2. **Get feedback on structure** before writing details

### Step 4: Detailed Plan Writing

After structure approval:

1. **Write the plan** to Claude Code's plan file (plan mode writes to its own location by default)

2. **Use this template structure**:

````markdown
# [Feature/Task Name] Implementation Plan

## Overview

[Brief description of what we're implementing and why]

## References

**For project workflows:**
- **Project**: {project name from state.yaml}
- **Linear URL**: {project URL from state.yaml}
- **User Context**: `{project-directory-path}/resources/user-context.md`
- **User Stories**: `{project-directory-path}/resources/user-stories.md`
- **TAD**: `{project-directory-path}/resources/tad.md`
- **Research**: `{project-directory-path}/resources/codebase-research.md`

**For ticket workflows:**
- **Ticket**: {ticket.identifier} — {ticket name from state.yaml}
- **Linear URL**: {ticket URL from state.yaml}
- **User Context**: `{project-directory-path}/resources/user-context.md`
- **Research**: `{project-directory-path}/resources/codebase-research.md`

## Prototype Code Assessment

**For project workflows only** (skip for ticket workflows):

The prototype from Phase 5 is committed in the working tree. For each area the prototype touched, state one of:
- **Keep as-is** — production-ready, no changes needed
- **Refactor** — right approach, needs cleanup (specify what)
- **Rewrite** — prototype took shortcuts, implement differently (specify why)

## Current State Analysis

[What exists now, what's missing, key constraints discovered]

### Key Discoveries:
- [Important finding with file:line reference]
- [Pattern to follow]
- [Constraint to work within]

## Desired End State

[A specification of the desired end state after this plan is complete, and how to verify it]

## What We're NOT Doing

[Explicitly list out-of-scope items to prevent scope creep]

## Implementation Approach

[High-level strategy and reasoning]

## Phase 1: [Descriptive Name]

### Overview
[What this phase accomplishes]

### Changes Required:

#### Database Changes (if applicable)
**File**: `packages/prisma/prisma/schema.prisma`
**Changes**: [Summary of schema changes]

```prisma
// Specific schema modifications
// Remember: alphabetically order attributes, use @map("snake_case")
```

**Migration**:
```bash
cd packages/prisma && pnpm migrate:dev
```

#### API Changes (if applicable)
**File**: `apps/www/src/server/api/routers/[router].ts`
**Changes**: [Summary of tRPC procedure changes]

```typescript
// Specific code to add/modify
```

#### UI Changes (if applicable)
**File**: `apps/www/src/pages/[page].tsx` or `packages/react-components/...`
**Changes**: [Summary of UI changes]

```typescript
// Specific code to add/modify
```

#### Business Logic (if applicable)
**File**: `packages/engines/src/...`
**Changes**: [Summary of engine changes]

```typescript
// Specific code to add/modify
```

### Success Criteria:

#### Automated Verification:
- [ ] Database migration applies cleanly (if applicable)
- [ ] Tests pass (if applicable)
- [ ] Build succeeds

#### Manual Verification:
- [ ] Feature works as expected in UI at http://localhost:3000
- [ ] No console errors in browser
- [ ] Edge cases handled properly
- [ ] No regressions in related features

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: [Descriptive Name]

[Similar structure with both automated and manual success criteria...]

---

## Testing Strategy

### Unit Tests:
- Location: Co-located with implementation (e.g., `packages/engines/src/__tests__/`)
- Framework: Vitest
- Run: `cd [package] && pnpm test` or `TZ=UTC vitest run path/to/test.test.ts`

### Test Cases:
- [What to test]
- [Key edge cases]

### Integration Tests:
- [End-to-end scenarios]

### Manual Testing Steps:
1. [Specific step to verify feature]
2. [Another verification step]
3. [Edge case to test manually]

## KarmaSuite-Specific Considerations

### Components to Use:
- Components from `packages/react-components`
- Follow Tailwind patterns from `packages/tailwind-config`

### Conventions:
- Use MathUtils.sum() for calculations
- Use dictionaries (objects) vs arrays for lookups
- Specify types with `.reduce<TYPE>()` for type safety
- Handle tRPC errors with `onError` callback

## Database Migration Notes

[If applicable, how to handle existing data]
- Test database: `cd packages/prisma && pnpm migrate:reset:test`
- Dev database: `cd packages/prisma && pnpm migrate:dev`

## External Integration Impacts

[If this affects QuickBooks, NetSuite, or Sage Intacct integrations]

## Code Quality Requirements

Formatting, linting, and type checking are handled automatically by hooks on every agent stop — no manual commands needed. Tests must still be run explicitly during phase verification.

## Commit Message Format

All commits must follow Conventional Commits:
```
type(scope): (KAR-XXXX) description

Examples:
feat(GL): (KAR-1234) add DueDate field to QBO transaction
fix(engines): (KAR-1235) correct allocation calculation for multi-fund
refactor(prisma): (KAR-1236) alphabetize Organization model attributes
```

## Open Questions

[Any remaining questions - ideally this section should be empty before implementation]
````

### Step 5: Finalize the Plan

When the plan is complete:
1. Use `ExitPlanMode` to formally finalize the plan
2. Include any `allowedPrompts` for actions needed during implementation
3. **IMPORTANT**: After ExitPlanMode is approved, copy the plan from Claude Code's plan file to the project directory:
   - Source: The plan file path shown in system messages (e.g., `~/.claude/plans/xxx.md`)
   - Destination: `{project-directory-path}/resources/implementation-plan-{NN}.md` (zero-padded iteration number)
   - Use the Read tool to read the plan file, then Write tool to save it to the project directory
4. The plan is now ready for the implementation phase (Phase 10)

## Important Guidelines

1. **Plan Mode Rules — ABSOLUTE BOUNDARY, NO EXCEPTIONS**:
   - This command runs in plan mode — research and planning ONLY
   - Use `ExitPlanMode` when the plan is complete
   - **YOU MUST NOT EDIT, CREATE, OR MODIFY ANY SOURCE CODE FILES.** Not even "small" changes, not "preparatory" work, not "just this one file." ZERO implementation happens in this phase.
   - **FORBIDDEN**: Editing source code, config files, schema files, test files, or any file that is not the implementation plan itself
   - **FORBIDDEN**: Running database migrations, installing dependencies, or making any changes to the codebase
   - **FORBIDDEN**: Creating to-do tasks (TaskCreate) or starting implementation of any kind
   - **FORBIDDEN**: Updating Linear ticket statuses to "In Progress" — that happens in Phase 10
   - **PERMITTED**: Reading files, running research agents, writing the implementation plan document, discussing with the user
   - If you find yourself about to edit a non-plan file, STOP IMMEDIATELY. You are violating the Phase 9 boundary. All implementation happens in Phase 10.

2. **Be Skeptical**:
   - Question vague requirements
   - Identify potential issues early
   - Ask "why" and "what about"
   - Don't assume - verify with code

3. **Be Interactive**:
   - Don't write the full plan in one shot
   - Get buy-in at each major step
   - Allow course corrections
   - Work collaboratively

4. **Be Thorough**:
   - Read all context files COMPLETELY before planning
   - Research actual code patterns using parallel sub-tasks
   - Include specific file paths and line numbers
   - Write measurable success criteria with clear automated vs manual distinction

5. **Be Practical**:
   - Focus on incremental, testable changes
   - Consider migration and rollback
   - Think about edge cases
   - Include "what we're NOT doing"

6. **No Open Questions in Final Plan**:
   - If you encounter open questions during planning, STOP
   - Research or ask for clarification immediately
   - Do NOT write the plan with unresolved questions
   - The implementation plan must be complete and actionable
   - Every decision must be made before finalizing the plan

7. **Follow KarmaSuite Conventions** (see the "KarmaSuite Conventions" section in `plugins/ks/rules/ks-rules.md` for the full list of conventions and domain-specific patterns)

8. **Feature Flag First (project workflows only)**:
   - Project workflows land code via per-phase PRs, so all new functionality must be gated behind a feature flag
   - **Phase 1 of the implementation plan must include feature flag setup** — create the flag and gate the entry points before any functional code is added
   - The feature flag strategy should come from the TAD (`tad.md`). If the TAD doesn't specify one, research existing feature flag patterns in the codebase and include the strategy in the plan.
   - The final phase should include enabling the flag or documenting the flag name for manual enablement after review

## Success Criteria Guidelines

**Always separate into two categories:**

1. **Automated Verification** (execution agents can run):
   - Commands: `pnpm lint`, `pnpm test`, `pnpm build`
   - Migrations: `cd packages/prisma && pnpm migrate:dev`
   - Type checking, compilation

2. **Manual Verification** (requires human testing):
   - UI/UX functionality
   - Performance under real conditions
   - Edge cases hard to automate
   - User acceptance criteria

## Error Handling

**Always flag to the user:**
- state.yaml not found or missing required fields
- resources/codebase-research.md not found or empty
- Unable to identify implementation approach from available information

**Project workflow only** — also flag if:
- resources/user-stories.md not found
- resources/tad.md not found
- resources/prototype.md not found

**Ticket workflow only** — also flag if:
- `linear issue get {ticket.identifier}` fails or returns no data
- ticket.identifier missing from state.yaml
