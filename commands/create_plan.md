---
description: Create detailed implementation plans from PRDs for KarmaSuite features through interactive research
argument-hint: [project-directory-path]
allowed-tools: Read, Write, Edit, Glob, Grep, Task, AskUserQuestion, ExitPlanMode, Bash(linear:*)
model: opus
plan-mode: true
---

# Implementation Plan Creator

**This command runs in PLAN MODE.** Focus on research, analysis, and planning. When the plan is finalized and the user is satisfied, use `ExitPlanMode` to formally approve the plan.

You are tasked with creating detailed implementation plans for KarmaSuite features through an interactive, iterative process. You should be skeptical, thorough, and work collaboratively with the user to produce high-quality technical specifications.

## CRITICAL: Enter Plan Mode First

**MANDATORY FIRST STEP**: Before doing anything else, you MUST call the `EnterPlanMode` tool to switch into plan mode. Do not read files, do not ask questions, do not proceed with any other action until you have successfully entered plan mode.

```
1. Call EnterPlanMode tool immediately
2. Wait for plan mode to be active
3. Only then proceed with the steps below
```

## Input & Output

**Input:** A project directory path provided via arguments: `$ARGUMENTS`
- State file: `{project-directory-path}/state.yaml` (for project ID and URL)
- Problem statement (optional): `{project-directory-path}/resources/prd.md`
- User stories: `{project-directory-path}/resources/user-stories.md`
- Prototype summary: `{project-directory-path}/resources/prototype.md`
- TAD document: `{project-directory-path}/resources/tad.md`
- Research file: `{project-directory-path}/resources/codebase-research.md`
- Linear tickets (if created): `{project-directory-path}/resources/linear-tickets.md`

**Output:** Implementation plan at `{project-directory-path}/resources/implementation-plan.md`

Example invocation:
```
/create_plan workflow/jaswanth/budget-category-reordering
```

## Initial Response

When this command is invoked:

1. **Check if project directory was provided**:
   - If provided as a parameter, immediately read `state.yaml` and begin the research process
   - If NOT provided, ask: "I need a project directory path to proceed. Please provide the path (e.g., 'workflow/jaswanth/budget-category-reordering')."

2. **Read all input files FULLY**:
   - Read `{project-directory-path}/state.yaml`
   - Read `{project-directory-path}/resources/prd.md` (if exists)
   - Read `{project-directory-path}/resources/user-stories.md`
   - Read `{project-directory-path}/resources/prototype.md`
   - Read `{project-directory-path}/resources/tad.md`
   - Read `{project-directory-path}/resources/linear-tickets.md` (if exists)
   - Read the research document at `{project-directory-path}/resources/codebase-research.md`

## Process Steps

### Step 1: Context Gathering & Initial Analysis

1. **Read all project files immediately and FULLY**:
   - State file to get project info (ID, name, URL)
   - PRD for problem context (if exists)
   - User stories for detailed requirements
   - Prototype summary for implementation decisions already made
   - TAD for technical architecture decisions
   - Linear tickets for work breakdown and priorities (if exists)
   - Research documents for codebase patterns and insights
   - **IMPORTANT**: Use the Read tool WITHOUT limit/offset parameters to read entire files
   - **CRITICAL**: DO NOT spawn sub-tasks before reading these files yourself in the main context

2. **Spawn initial research tasks to gather additional context**:
   Before asking the user any questions, use specialized agents to research in parallel:

   - Use **codebase-locator** agent to find all files related to the feature
   - Use **codebase-analyzer** agent to understand how current implementations work
   - Use **codebase-pattern-finder** agent to find similar features to model after

   **Serena MCP**: When Serena MCP is running, all three codebase agents have access to semantic tools (`find_symbol`, `find_referencing_symbols`, `get_symbols_overview`). Agents use semantic tools first for symbol-based queries and fall back to text-based tools automatically when Serena is unavailable.

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
   - Cross-reference the user stories with actual code
   - Compare TAD decisions with codebase reality
   - Identify any discrepancies or misunderstandings
   - Note assumptions that need verification
   - Determine true scope based on codebase reality

5. **Present informed understanding and focused questions**:
   ```
   Based on the PRD, TAD, and my research of the codebase, I understand we need to [accurate summary].

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

1. **Write the plan** to `{project-directory-path}/resources/implementation-plan.md`

2. **Use this template structure**:

````markdown
# [Feature/Task Name] Implementation Plan

## Overview

[Brief description of what we're implementing and why]

## References

- **Project**: {project name from state.yaml}
- **Linear URL**: {project URL from state.yaml}
- **User Stories**: `{project-directory-path}/resources/user-stories.md`
- **TAD**: `{project-directory-path}/resources/tad.md`
- **Research**: `{project-directory-path}/resources/codebase-research.md`

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
- [ ] Database migration applies cleanly: `cd packages/prisma && pnpm migrate:dev`
- [ ] Lint passes: `cd /Users/jassu/karmasuite/karmasuite && pnpm lint 2>&1 | head -100`
- [ ] Type checking passes: `cd /Users/jassu/karmasuite/karmasuite/apps/www && pnpm tsc --noEmit 2>&1 | head -100`
- [ ] Tests pass: `pnpm test` (if applicable)
- [ ] Build succeeds: `pnpm --filter www run build`

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

Before pushing code:
```bash
# Get modified files and format them
git diff --name-only main...HEAD | grep -E '\.(ts|tsx)$' | xargs pnpm exec prettier --write
git diff --name-only main...HEAD | grep -E '\.(ts|tsx)$' | xargs pnpm exec eslint --fix
```

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

### Step 5: Iterate with User Until Satisfied

Once the implementation plan is written to `{project-directory-path}/resources/implementation-plan.md`:

1. **Ask the user to review the plan**:
   ```
   I've created the implementation plan at:
   `{project-directory-path}/resources/implementation-plan.md`

   Please review it and let me know:
   - Are the phases properly scoped?
   - Are the success criteria specific enough?
   - Any technical details that need adjustment?
   - Missing edge cases or considerations?
   ```

2. **Iterate based on feedback**:
   - Make requested modifications to `resources/implementation-plan.md`
   - Present the updated plan for review
   - Continue iterating until the user is satisfied

3. **When user approves the plan**:
   - Use `ExitPlanMode` to formally finalize the plan
   - Include any `allowedPrompts` for actions needed during implementation
   - **IMPORTANT**: After ExitPlanMode is approved, copy the plan from Claude Code's plan file to the project directory:
     - Source: The plan file path shown in system messages (e.g., `~/.claude/plans/xxx.md`)
     - Destination: `{project-directory-path}/resources/implementation-plan.md`
     - Use the Read tool to read the plan file, then Write tool to save it to the project directory
   - The plan is now ready for the implementation phase (Phase 10)

## Important Guidelines

1. **Plan Mode Rules**:
   - This command runs in plan mode - focus on research and planning
   - Iterate with the user until they are satisfied with the plan
   - Use `ExitPlanMode` only after the user approves the plan
   - **CRITICAL**: Do NOT create to-do tasks (TaskCreate) or start implementing code in this phase
   - **CRITICAL**: Do NOT update Linear ticket statuses to "In Progress" - that happens in Phase 10
   - This phase is ONLY for creating the plan document, not for execution

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

5. **Be Thorough**:
   - Read all context files COMPLETELY before planning
   - Research actual code patterns using parallel sub-tasks
   - Include specific file paths and line numbers
   - Write measurable success criteria with clear automated vs manual distinction

6. **Be Practical**:
   - Focus on incremental, testable changes
   - Consider migration and rollback
   - Think about edge cases
   - Include "what we're NOT doing"

7. **No Open Questions in Final Plan**:
   - If you encounter open questions during planning, STOP
   - Research or ask for clarification immediately
   - Do NOT write the plan with unresolved questions
   - The implementation plan must be complete and actionable
   - Every decision must be made before finalizing the plan

8. **Follow KarmaSuite Conventions**:
   - Prisma: Alphabetically ordered attributes, @map("snake_case")
   - TypeScript: Use dictionaries over arrays for lookups
   - React: Use FC<PropsWithChildren<...>> for components
   - Testing: Vitest with proper database setup
   - Prefer `packages/react-components` over legacy `components`
   - Never import from client into server or vice versa

## KarmaSuite-Specific Patterns

### For Database Changes:
1. Update Prisma schema (alphabetically ordered, @map annotations)
2. Run migration: `cd packages/prisma && pnpm migrate:dev`
3. Update related TypeScript types
4. Add/update tRPC procedures
5. Test with: `cd packages/prisma && pnpm migrate:reset:test`

### For Engine/Business Logic:
1. Locate in `packages/engines/src/`
2. Follow existing patterns (e.g., getEngine.ts for allocations)
3. Use MathUtils.sum() for calculations
4. Write unit tests with Vitest
5. Consider atomic transactions for DB operations

### For UI Components:
1. Prefer `packages/react-components` (Tailwind + Radix)
2. Use shared hooks from `packages/react-hooks`
3. Use icons from `packages/react-icons`
4. Follow TailwindCSS config from `packages/tailwind-config`
5. Handle tRPC errors with onError callbacks

### For GL Integrations:
1. Check `packages/general-ledger-external`
2. Follow patterns for QB/NetSuite/Sage
3. Consider sync implications
4. Test with actual GL data structures

### For API Endpoints:
1. tRPC procedures in `apps/www/src/server/api/routers/`
2. Proper error handling
3. Input validation with Zod
4. Consider permissions/auth

### For Background Jobs:
1. Inngest functions in `apps/www/src/inngest/`
2. Consider retry logic
3. Monitor execution

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

If any of the following occur, flag to the user for review:
- state.yaml not found or missing required fields (id, url)
- resources/user-stories.md not found
- resources/tad.md not found
- resources/prototype.md not found
- Research folder empty
- Unable to identify implementation approach from available information
