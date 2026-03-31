---
name: create_handoff
description: Create a handoff file so another agent can resume work from where you left off
user_invocable: true
---

# Create Handoff

Create a handoff document capturing the current state of work so another agent (or future session) can resume seamlessly.

## Steps

1. **Gather context:**
   - Run `git log --oneline -10` to get the latest commit hash and recent history
   - Run `git branch --show-current` to get the current branch
   - Run `git status` to check for uncommitted changes
   - Run `git diff --stat` if there are uncommitted changes
   - Review any active tasks via TaskList

2. **Determine the filename:**
   - Format: `YYYY-MM-DD_HH-MM-SS_descriptive-task-name.md`
   - Use the current IST timestamp
   - Use a short descriptive slug for the task (e.g., `initial-implementation-complete`)

3. **Write the handoff file** to `handoffs/` with this exact structure:

```markdown
---
date: <ISO 8601 timestamp with IST timezone, e.g., 2026-03-29T17:30:00+05:30>
git_commit: <latest commit hash>
branch: <current branch>
task: <brief task description>
---

# Handoff: <Descriptive Title>

> See docs/product-overview.md for product context, docs/tech-stack.md for dependencies, and CLAUDE.md for dev guidance.

## What Happened
<Narrative summary of work completed in this session. Focus on what was built, key decisions made, and why.>

## Key Decisions Made
<Bullet list of important decisions and their rationale. Only include if decisions were made during the session.>

## Deviations from Plan
<Any changes from the original plan or docs. "None" if everything followed the plan.>

## Uncommitted Changes
<List of uncommitted files, or "None">

## Known Issues
<Any bugs, TODOs, or concerns discovered. "None" if clean.>

## Resume Point
<Exact instructions for the next session — what to do first, what to test, what's blocked.>
```

4. **Important rules:**
   - Be delta-focused: only capture what changed, not the full project state
   - Cross-reference project docs instead of repeating information
   - Make the Resume Point actionable — specific commands or files to start with
   - Keep it concise but complete enough for context restoration
