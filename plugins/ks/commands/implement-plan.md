---
description: Implement approved implementation plans phase by phase with verification
argument-hint: [project-directory-path]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Task, AskUserQuestion
model: opus
---

# Implement Plan

You are tasked with implementing an approved technical plan from a project directory. These plans contain phases with specific changes and success criteria.

## Input & Output

**Input:** A project directory path provided via arguments: `$ARGUMENTS`
- State file: `{project-directory-path}/state.yaml` (for project info)
- Implementation plan: `{project-directory-path}/resources/implementation-plan.md`
- Research file: `{project-directory-path}/resources/codebase-research.md`
- User stories: `{project-directory-path}/resources/user-stories.md`
- TAD: `{project-directory-path}/resources/tad.md`

**Output:**
- Implemented code changes in the KarmaSuite codebase
- Updated plan with completed checkboxes

Example invocation:
```
/implement-plan workflow/jaswanth/budget-category-reordering
```

**CRITICAL**: If the project directory path is not provided, ask the user: "I need a project directory path to proceed. Please provide the path (e.g., 'workflow/jaswanth/budget-category-reordering')."

## Getting Started

When given a project directory path:

1. **Read state.yaml** to get project info (name, Linear URL)
2. **Read the implementation plan completely** at `{project-directory-path}/resources/implementation-plan.md`
3. **Read the research document FIRST** from `{project-directory-path}/resources/codebase-research.md`
   - These contain critical details: enum type names, column mappings, helper functions, existing patterns
   - Reading these BEFORE exploring the codebase prevents unnecessary trial-and-error debugging
5. **Read supporting documents**:
   - TAD from `{project-directory-path}/resources/tad.md`
   - User stories from `{project-directory-path}/resources/user-stories.md`
6. **Read files mentioned in the plan** - use Read tool WITHOUT limit/offset parameters for complete context
7. **Think deeply** about how the pieces fit together
8. **Only then explore codebase** - Use Grep/Glob only if research documents don't have what you need
9. **Start implementing** if you understand what needs to be done

## Implementation Philosophy

Plans are carefully designed through the `/ks:create_plan` command, but reality can be messy. Your job is to:
- **Follow the plan's intent** while adapting to what you find in the codebase
- **Implement each phase fully** before moving to the next
- **Verify your work** makes sense in the broader codebase context
- **Update checkboxes** in the plan as you complete sections using the Edit tool

When things don't match the plan exactly, think about why and communicate clearly. The plan is your guide, but your judgment matters too.

### When You Encounter a Mismatch

If you encounter a situation where the plan can't be followed:
- **STOP** and think deeply about why
- Present the issue clearly:
  ```
  Issue in Phase [N]:
  Expected: [what the plan says]
  Found: [actual situation]
  Why this matters: [explanation]

  How should I proceed?
  ```

## Phase Implementation Process

**CRITICAL WORKFLOW**: For each task/todo item, follow this exact cycle:
1. **Implement** the task
2. **Ask user to verify** the implementation
3. **Commit** after user confirms verification
4. **Continue** to next task

### For Each Phase in the Plan:

#### 1. Pre-Implementation

**CRITICAL: Research Documents First**
- **Read the research document FIRST** from `{project-directory-path}/resources/codebase-research.md`
- Research documents contain valuable context: enum type names, column mappings, existing patterns, helper functions
- This prevents trial-and-error debugging (e.g., wrong enum cast names, wrong column names)
- Only explore the codebase directly (Grep, Glob) if the research documents don't have what you need

**Then:**
- Read the phase overview and understand what it accomplishes
- Read ALL files that will be modified (full content, no truncation)
- Create task list using `TaskCreate` for each item in this phase

#### 2. Implementation (Per Task)

For **each individual task** in the phase:

**Step A - Implement:**
- Update the task status to `in_progress` using `TaskUpdate`
- Make the code changes specified for this task
- Follow KarmaSuite conventions:
  - Prisma: Alphabetically ordered attributes, `@map("snake_case")`
  - TypeScript: Use dictionaries over arrays for lookups
  - React: Use `FC<PropsWithChildren<...>>` for components
  - Prefer `packages/react-components` over legacy `components`
  - Use `MathUtils.sum()` for calculations
  - Never import from client into server or vice versa

**Step B - Ask User to Verify:**
After implementing a task, present to the user:
```
Task Complete: [Task description]

Changes made:
- [List of files modified]
- [Summary of changes]

Please verify the implementation. Once verified, I'll commit these changes.
```

**Step C - Commit:**
After user confirms verification:
- Run `prettier --write` and `eslint --fix` on modified files
- Create a commit with the appropriate message format
- Update the task status to `completed` using `TaskUpdate`

**Step D - Continue:**
- Move to the next task in the phase
- Repeat Steps A-D

#### 3. Phase Completion

After all tasks in a phase are committed:
- Run the automated success criteria checks (typecheck, lint, build)
- Present summary to user:
```
Phase [N] Complete

All tasks committed:
- [Commit hash]: [Task 1 description]
- [Commit hash]: [Task 2 description]
...

Automated verification:
- [ ] Typecheck: [PASS/FAIL]
- [ ] Lint: [PASS/FAIL]

Ready to proceed to Phase [N+1]?
```

#### 4. Pause for Human Verification (End of Phase)

Wait for user confirmation before proceeding to the next phase. This allows the user to:
- Test the changes manually
- Review the commits
- Catch any issues before moving on

## Resuming Work

If the implementation plan has existing checkmarks (- [x]):
- Trust that completed work is done
- Pick up from the first unchecked item
- Verify previous work only if something seems off
- Ask the user if unclear: "I see Phases 1-2 are marked complete. Should I continue from Phase 3?"

## If You Get Stuck

When something isn't working as expected:
1. **First**, check the research documents - they often contain the answer (enum names, column names, patterns)
2. **Then**, make sure you've read and understood all the relevant code
3. **Consider** if the codebase has evolved since the plan was written
4. **Check actual error messages** - read API responses, server logs, don't make assumptions
5. **Present the mismatch clearly** and ask for guidance

Use sub-tasks sparingly - mainly for:
- Targeted debugging
- Exploring unfamiliar territory
- Finding similar patterns in the codebase

Example sub-task usage:
```
Task(subagent_type="ks:codebase-pattern-finder", prompt="Find examples of drag-and-drop implementation in the codebase")
```

## Code Quality Requirements

Before completing each phase, ensure:

1. **Lint passes**: No new warnings or errors
2. **Types are correct**: TypeScript compiles without errors
3. **Tests pass**: All existing tests still pass
4. **No regressions**: Related features still work

Format code before committing:
```bash
# Get modified files and format them
git diff --name-only main...HEAD | grep -E '\.(ts|tsx)$' | xargs pnpm exec prettier --write
git diff --name-only main...HEAD | grep -E '\.(ts|tsx)$' | xargs pnpm exec eslint --fix
```

## Commit Guidelines

After completing each phase (and human approval), create a commit:

**Commit Message Format:**
```
type(scope): (KAR-XXXX) description

Examples:
feat(GL): (KAR-1234) add DueDate field to QBO transaction
fix(engines): (KAR-1235) correct allocation calculation for multi-fund
refactor(prisma): (KAR-1236) alphabetize Organization model attributes
```

Get the ticket ID from the Linear URL in state.yaml.

## Error Handling

If any of the following occur, flag to the user for review:
- state.yaml not found or missing required fields (id, url)
- resources/implementation-plan.md not found
- Plan has no phases defined
- Unable to read files mentioned in the plan
- Automated verification fails after multiple attempts
- Significant mismatch between plan and codebase reality

## Important Rules

1. **Read files fully** - Never use limit/offset parameters on Read tool during implementation
2. **Follow the plan** - The plan has been approved, don't deviate without explicit user approval
3. **One phase at a time** - Complete and verify each phase before moving on
4. **Human verification required** - Always pause for manual testing between phases (unless told otherwise)
5. **Communicate clearly** - When stuck, explain what you tried and what went wrong
6. **Don't skip verification** - All automated checks must pass before human verification

## Remember

You're implementing a carefully planned solution, not just checking boxes. Keep the end goal in mind and maintain forward momentum while ensuring quality at each step.

The plan represents significant upfront analysis - trust it, but adapt when the codebase reality demands it. Always communicate when you need to deviate from the plan.
