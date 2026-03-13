---
description: Implement approved implementation plans phase by phase with verification
argument-hint: [project-directory-path]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Agent, Task, TaskCreate, TaskList, TaskGet, TaskUpdate, TeamCreate, TeamDelete, SendMessage, AskUserQuestion
---

# Implement Plan

You are the **orchestrator**. You delegate deep analysis and heavy reading to subagents, then coordinate execution using implementation subagents. You MUST verify files touched by multiple subagents or cross-cutting concerns (shared interfaces, type changes that ripple across modules) after subagents report completion. You MAY spot-check individual task outputs that don't overlap with other tasks.

## Input & Output

**Input:** A project directory path provided via arguments: `$ARGUMENTS`
- State file: `{project-directory-path}/state.yaml` (for project info, **workflow type**, and **iteration number**)
- Implementation plan: `{project-directory-path}/resources/implementation-plan-{NN}.md` (latest numbered plan — iteration number = length of Phase 9's `iterations` array in state.yaml, default 1)
- Research file: `{project-directory-path}/resources/codebase-research.md`

**Additional inputs depend on workflow type** (detected from `state.yaml` root key):

**Project workflow** (`project` key in state.yaml — all 10 phases):
- User stories: `{project-directory-path}/resources/user-stories.md`
- TAD: `{project-directory-path}/resources/tad.md`

**Ticket workflow** (`ticket` key in state.yaml — phases 1, 2, 9, 10 only):
- Linear ticket details: fetched via `linear issue get {ticket.identifier}` (the ticket identifier comes from `state.yaml`)
- User context: `{project-directory-path}/resources/user-context.md`
- Note: `user-stories.md`, `tad.md`, `prd.md`, `prototype.md`, and `linear-tickets.md` do NOT exist in ticket workflows — phases 3-8 are skipped

**Output:**
- Implemented code changes in the KarmaSuite codebase
- Updated plan (`implementation-plan-{NN}.md`) with completed checkboxes

Example invocation:
```
/ks:implement-plan workflow/jaswanth/budget-category-reordering
```

**CRITICAL**: If the project directory path is not provided, ask the user: "I need a project directory path to proceed. Please provide the path (e.g., 'workflow/jaswanth/budget-category-reordering')."

## Getting Started

When given a project directory path:

1. **Read state.yaml** to get project info (name, Linear URL, ticket ID for commits), **detect workflow type** (check if root key is `project` or `ticket`), and **determine iteration number** (length of Phase 9's `iterations` array, default 1). The plan file is `{project-directory-path}/resources/implementation-plan-{NN}.md` (zero-padded iteration number).
2. **Spawn the analysis subagent** — delegate ALL plan reading and analysis:

```
Agent(
  subagent_type: "general-purpose",
  name: "plan-analyzer",
  description: "Ultrathink analysis of implementation plan",
  prompt: "You are analyzing an approved implementation plan. Your job is to deeply understand it and produce a structured task list.

PROJECT DIRECTORY: {project-directory-path}

## Step 1: Read Everything

Read ALL of these documents completely (no limit/offset):
1. {project-directory-path}/resources/implementation-plan-{NN}.md (the current iteration's plan — NN = length of Phase 9's iterations array in state.yaml, default 01)
2. {project-directory-path}/resources/codebase-research.md (READ THIS BEFORE exploring codebase — it has enum names, column mappings, helper functions, existing patterns)

**Additional reads depend on workflow type** (detected from state.yaml root key):

**Project workflow** (state.yaml has `project` key):
3. {project-directory-path}/resources/tad.md
4. {project-directory-path}/resources/user-stories.md

**Ticket workflow** (state.yaml has `ticket` key):
3. Fetch Linear ticket details via: linear issue get {ticket.identifier} (identifier from state.yaml)
4. {project-directory-path}/resources/user-context.md (if exists)
- Do NOT read tad.md, user-stories.md, prd.md, prototype.md, or linear-tickets.md — they do not exist in ticket workflows

Then for both workflow types:
5. Every file mentioned in the implementation plan

Only use Grep/Glob to explore the codebase if the documents above don't have what you need.

## Step 2: Ultrathink

Engage MAXIMUM reasoning effort to deeply analyze the entire plan:
- How do all the phases connect end-to-end?
- What are the dependencies between tasks within each phase?
- Which tasks within a phase touch DIFFERENT files and can safely run in parallel?
- Which tasks modify the SAME files or depend on each other's output and must run sequentially?
- Are there any gaps, ambiguities, or potential conflicts in the plan?

## Step 3: Identify Clarifying Questions

List ANY ambiguities, missing context, or decisions that need user input. If there are none, say so explicitly.

## Step 4: Produce the Task List

Return a structured task list in this EXACT format:

### CLARIFYING QUESTIONS (if any)
- [Question 1]
- [Question 2]
- (or 'None')

### TASK LIST

For each task:
TASK: Phase {N}: {imperative subject}
FILES: {comma-separated list of files to read and modify}
CHANGES: {detailed description of exact changes to make}
CONVENTIONS: {relevant KarmaSuite conventions for this task}
PARALLEL_GROUP: {phase number}.{group letter} (tasks with the same group can run in parallel; tasks sharing files get different groups within the same phase)
BLOCKED_BY: {list of task subjects this depends on, or 'None'}

KarmaSuite Conventions: See the 'KarmaSuite Conventions' section in plugins/ks/rules/ks-rules.md for the full list.

IMPORTANT: Be thorough. Every checkbox item in the plan must become a task. Group tasks within a phase by which files they touch — same files = different parallel group (sequential), different files = same parallel group (parallel)."
)
```

3. **Review the analysis results:**
   - If the subagent returned clarifying questions, present them to the user using `AskUserQuestion` and wait for answers
   - Once all questions are resolved, proceed to task creation
4. **Create the task list and begin execution** (see Task List & Subagent Workflow below)

## Implementation Philosophy

Plans are carefully designed through the `/ks:create_plan` command, but reality can be messy. As the orchestrator, your job is to:
- **Coordinate subagents** to implement each phase fully before moving to the next
- **Review subagent results** for issues or deviations before proceeding
- **Update checkboxes** in the plan as you complete sections using the Edit tool
- **Handle verification and commits** — only you commit, only after user approval

When a subagent reports a mismatch with the plan, present it clearly to the user:
```
Issue in Phase [N] (reported by subagent):
Expected: [what the plan says]
Found: [actual situation]
Why this matters: [explanation]

How should I proceed?
```

## Task List & Subagent Workflow

After the Ultrathink analysis, create a comprehensive task list and execute it using subagents.

### Step 1: Create the Full Task List from Analysis

Using the analysis subagent's structured output, create tasks with `TaskCreate`:

- For each TASK entry from the analysis, create a task with:
  - `subject`: The task subject (already in imperative form from the analysis, e.g. "Phase 1: Add DueDate column to Prisma schema")
  - `description`: Combine FILES, CHANGES, and CONVENTIONS from the analysis into a detailed description. Also include a reference to `{project-directory-path}/resources/codebase-research.md`
  - `activeForm`: Present continuous form of the subject (e.g. "Adding DueDate column to Prisma schema")
- Set up **dependencies** using `TaskUpdate` with `addBlockedBy`, derived from the PARALLEL_GROUP and BLOCKED_BY fields:
  - Tasks in Phase N+1 are blocked by all tasks in Phase N
  - Tasks within the same phase that have different PARALLEL_GROUP letters are blocked by each other (they touch the same files)
  - Tasks within the same phase with the same PARALLEL_GROUP letter have NO blockedBy (they can run in parallel)

### Step 2: Execute Phases Sequentially with Parallel Subagents

**CRITICAL**: Phases execute sequentially. Within each phase, non-colliding tasks run in parallel.

For each phase:

#### 2a. Identify Parallel Groups

From the task list, identify which tasks in the current phase can run in parallel (they touch different files and have no data dependencies). Group them into batches:
- **Maximum 5 subagents** running simultaneously
- If a phase has more than 5 parallelizable tasks, split into batches of up to 5
- Tasks that modify the same file or depend on another task's output must run sequentially (use `addBlockedBy`)

#### 2b. Spawn Subagents

For each parallel batch, spawn subagents using the `Agent` tool:

```
Agent(
  subagent_type: "general-purpose",
  name: "impl-phase{N}-task{M}",
  description: "Implement [task subject]",
  prompt: "You are implementing a task from an approved implementation plan.

PROJECT DIRECTORY: {project-directory-path}

YOUR TASK:
[Full task description including files, changes, conventions]

IMPORTANT INSTRUCTIONS:
1. Read the research document FIRST: {project-directory-path}/resources/codebase-research.md
2. Read ALL files you will modify completely (no limit/offset)
3. Make the specified changes following KarmaSuite conventions
4. Do NOT commit — the lead agent handles commits after verification
5. Do NOT ask questions — if something is unclear, document the issue in your response
6. Report back: list of files modified and summary of changes made

KarmaSuite Conventions: Read the 'KarmaSuite Conventions' section in plugins/ks/rules/ks-rules.md for the full list of conventions and domain-specific patterns."
)
```

- Launch all subagents in the batch **in a single message** (parallel tool calls)
- All subagents work in the **main working directory** (the project already runs in a worktree)

#### 2c. Collect Results

After all subagents in a batch complete:
- Review each subagent's response for issues or deviations
- If a subagent reports a problem, address it before proceeding
- Mark completed tasks using `TaskUpdate` with `status: "completed"`
- If there are more batches in this phase, run the next batch

#### 2d. Phase Verification (Per-Phase)

After ALL tasks in a phase are complete:

1. **Run automated verification:**
   - Formatting, linting, and type checking are handled automatically by hooks — no manual commands needed
   - Run existing tests (hooks do not run tests — this must be explicit)

2. **Present phase summary to user:**
```
Phase [N] Complete

Tasks completed:
- [Task 1]: [files modified, summary]
- [Task 2]: [files modified, summary]
...

Automated verification:
- Formatting/Linting/Typecheck: handled by hooks (runs automatically on stop)
- [ ] Tests: [PASS/FAIL]

Please verify the implementation. Once verified, I'll commit and proceed to Phase [N+1].
```

3. **Wait for user confirmation** — do NOT proceed until the user approves
4. **Commit** all changes for this phase with the appropriate message format
5. **Update plan checkboxes** for the completed phase using the Edit tool
6. **Proceed to next phase** — repeat from Step 2a

## Resuming Work

If the implementation plan has existing checkmarks (- [x]):
- Trust that completed work is done
- Pick up from the first unchecked item
- Verify previous work only if something seems off
- Ask the user if unclear: "I see Phases 1-2 are marked complete. Should I continue from Phase 3?"

## If You Get Stuck

When a subagent reports an issue or something isn't working:
1. **Spawn a research subagent** for deep investigation, or read specific files directly for quick verification
2. **Consider** if the codebase has evolved since the plan was written
3. **Present the issue clearly** to the user and ask for guidance

Use research subagents for:
- Targeted debugging when an implementation subagent reports an issue
- Exploring unfamiliar territory not covered in research docs
- Finding similar patterns in the codebase

Example research subagent usage:
```
Agent(subagent_type: "ks:codebase-pattern-finder", prompt: "Find examples of drag-and-drop implementation in the codebase")
```

## Code Quality Requirements

Before completing each phase, ensure:

1. **Format/Lint/Typecheck**: Handled automatically by hooks on every agent stop — no manual verification needed
2. **Tests pass**: All existing tests still pass (explicit check required)
3. **No regressions**: Related features still work

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
- Implementation plan file not found (expected `resources/implementation-plan-{NN}.md` based on iteration)
- Plan has no phases defined
- Unable to read files mentioned in the plan
- Automated verification fails after multiple attempts
- Significant mismatch between plan and codebase reality

## Important Rules

1. **You are the orchestrator** - Delegate deep reading and analysis to subagents. You MUST verify files touched by multiple subagents or cross-cutting concerns (shared interfaces, type changes that ripple across modules, files modified by more than one task). You MAY spot-check individual task outputs that don't overlap with other tasks. Do NOT do deep analysis or read entire research docs yourself.
2. **Ultrathink via subagent** - The analysis subagent does the deep thinking. You receive its structured output and act on it.
3. **Follow the plan** - The plan has been approved, don't deviate without explicit user approval
4. **One phase at a time** - Complete and verify each phase before moving on. Phases are sequential.
5. **Parallel within phases** - Non-colliding tasks within a phase run in parallel via subagents (max 5)
6. **Human verification per phase** - Pause for manual testing after each phase completes (unless told otherwise)
7. **Subagents don't commit** - Only the orchestrator (you) commits, after user verifies the phase
8. **Communicate clearly** - When stuck, explain what you tried and what went wrong
9. **Don't skip verification** - All automated checks must pass before human verification

## Post-Implementation

After ALL phases are complete and committed:

1. **Create a PR** using `/ks:create_pr`
2. **Run automated code review** by spawning a sub-agent:
   ```
   Agent(subagent_type: "general-purpose", prompt: "Run /code-review:code-review to review all changes in the current PR. Report back with any issues found.")
   ```
   Address any high-confidence issues before finalizing.
3. **Congratulate the user**: "Project implementation complete! All phases have been successfully executed."

## Remember

You are the orchestrator — you coordinate, verify, and commit. Subagents do the heavy reading, deep analysis, and implementation. You MUST verify files touched by multiple subagents or cross-cutting concerns (shared interfaces, type changes, files modified by more than one task) to catch conflicting edits. You MAY spot-check individual non-overlapping task outputs. Keep the end goal in mind and maintain forward momentum while ensuring quality at each step.

The plan represents significant upfront analysis — trust it, but adapt when subagents report that codebase reality demands it. Always communicate when you need to deviate from the plan.
