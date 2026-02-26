---
description: Create handoff document for transferring work to another session. Captures ONLY information not already in project files.
argument-hint: [project-directory-path]
model: claude-sonnet-4-5-20250929
---

# Create Handoff

Create a **minimal** handoff document that captures ONLY:
1. Information NOT already stored in project files
2. Deviations or corrections to existing project files

## Critical Rule

**DO NOT duplicate information from these files:**
- `state.yaml` — project metadata, phase status, ticket IDs
- `resources/implementation-plan.md` — task status, technical approach
- `resources/codebase-research.md` — codebase findings, patterns, architecture
- `resources/tad.md` — technical decisions
- `resources/user-stories.md` / `resources/prd.md` — requirements
- `resources/linear-tickets.md` — ticket details

**If information exists in a project file, reference the file instead of copying content.**

## Process

### 1. Determine Filepath
- Path: `{project-directory-path}/resources/handoffs/YYYY-MM-DD_HH-MM-SS_description.md`
- Use current date/time in 24-hour format
- Description: brief kebab-case summary (e.g., `phase-3-complete`, `drilldown-bug-fix`)

### 2. Gather Context
Run `hack/spec_metadata.sh` to get git commit, branch, and repository info.

### 3. Write Handoff

Use this exact template:

```markdown
---
date: [ISO timestamp with timezone]
git_commit: [commit hash]
branch: [branch name]
phase: [current phase number]
task: [brief task description]
---

# Handoff: [Brief description]

> Captures ONLY deltas from project files. See state.yaml for status, resources/implementation-plan.md for tasks.

## What Happened
[1-3 sentences: what you worked on, outcome, anything unexpected]

## Deviations from Project Files
[Corrections or conflicts with existing docs — if none, write "None"]

- `resources/implementation-plan.md`: [what differs and why]
- `resources/codebase-research.md`: [what's incorrect or incomplete]
- `resources/tad.md`: [assumptions that proved wrong]

## Debugging Trail
[Only include if non-obvious problem-solving occurred — otherwise omit entire section]

1. Tried: [approach]
2. Failed: [error/symptom]
3. Root cause: [finding]
4. Fix: [solution with file:line references]

## Uncommitted Changes
[Files with uncommitted work — if none, write "None"]

- `path/to/file.ts:45-67` - [brief description]

## Resume Point
[Exact next action to take]
```

## What to Include vs Exclude

### ✅ INCLUDE (not stored elsewhere)
- Session-specific debugging context
- Corrections to research docs or implementation plan
- User decisions made during session
- Uncommitted file paths
- Non-obvious gotchas discovered
- Exact resume point

### ❌ EXCLUDE (stored in project files)
- Project ID, slug, Linear URL → `state.yaml`
- Phase progress / status → `state.yaml`
- Ticket summaries → `resources/linear-tickets.md`
- Implementation plan status → `resources/implementation-plan.md`
- Technical findings → `resources/codebase-research.md`
- "Important context files" lists → self-evident from project structure
- Pre-existing unrelated errors → not relevant

## Anti-Patterns

**DON'T write:**
```markdown
## Artifacts
- `workflow/jaswanth/project/user-context.md`
- `workflow/jaswanth/project/state.yaml`
- `workflow/jaswanth/project/resources/codebase-research.md`
```
This just lists project files that already exist.

**DON'T write:**
```markdown
## 10-Phase Workflow Progress
1. ✅ Context Creation (COMPLETED)
2. ✅ Workflow State Setup (COMPLETED)
...
```
This duplicates `state.yaml`.

**DON'T write:**
```markdown
## Linear Tickets
| Ticket | Title | Status |
| KAR-11009 | EGL Issue Groups Query | Done |
...
```
This duplicates `resources/linear-tickets.md`.

## Keep It Concise

If your handoff is getting long, you're likely duplicating project file content. Reference files instead of copying.

## Response Template

After writing the handoff, respond:

```
Handoff created at `{filepath}`
```