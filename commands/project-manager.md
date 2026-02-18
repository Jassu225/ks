---
description: Orchestrate end-to-end project management workflow from PRD creation to implementation.
allowed-tools: Bash, Glob, Grep, Read, Edit, Write, NotebookEdit, WebFetch, WebSearch, Skill, TodoWrite, Task
---

# Project Manager Agent

Orchestrates a 10-phase software project lifecycle. Read the corresponding phase file before executing each phase.

## Initial Interaction

When invoked:
1. Check if a project directory was provided as an argument
2. If not provided, ask: "Please provide the project directory path (e.g., `workflow/{username}/{project-slug}`)"
3. Read `state.yaml` from the provided project directory
4. **Detect workflow type**: Check if root key is `project` or `ticket`
   - If `ticket` key exists → **Ticket Workflow** (phases 1, 2, 9, 10 only)
   - If `project` key exists → **Project Workflow** (all 10 phases)
5. Parse the `phases` array to determine status (phases not in array are NOT_STARTED)
6. Determine status:
   - **Ticket workflow**: "I see this is a ticket workflow: {ticket.identifier} - {ticket.name}. This uses an abbreviated workflow (Phases 1, 2, 9, 10). Ready to begin?"
   - **Project workflow (fresh)**: "I see this is a fresh project: {project-name}. Ready to begin Phase 1 (Context Creation)?"
   - **Resuming**: Show phase status summary (including any SKIPPED phases) and ask which phase to continue from

---

## Phases

**Phase files location:** `~/.claude/plugins/ks/project-manager/`

| # | Name | state.yaml name | Command | Phase File | Ticket |
|---|------|-----------------|---------|------------|:------:|
| 1 | Context Creation | `context-creation` | `/user-context-generator` | `01-context-creation.md` | ✓ |
| 2 | Codebase Research | `codebase-research` | `/research_codebase` | `02-codebase-research.md` | ✓ |
| 3 | Initial PRD Draft | `initial-prd-draft` | `/write-problem-statement` | `03-initial-prd-draft.md` | — |
| 4 | PRD User Stories | `prd-user-stories` | `/prd` | `04-prd-user-stories.md` | — |
| 5 | Prototype Creation | `prototype-creation` | `/build-prototype` | `05-prototype-creation.md` | — |
| 6 | Product Requirements | `product-requirements` | `/add-product-requirements` | `06-product-requirements.md` | — |
| 7 | TAD Creation | `tad-creation` | `/write-tad` | `07-tad-creation.md` | — |
| 8 | Linear Tickets Creation | `linear-tickets-creation` | `/prd-to-linear-tickets` | `08-linear-tickets-creation.md` | — |
| 9 | Implementation Plan | `implementation-plan-creation` | `/create_plan` | `09-implementation-plan-creation.md` | ✓ |
| 10 | Implementation | `implementation` | `/implement-plan` | `10-implementation.md` | ✓ |

> **Ticket workflows** skip phases 3-8 (requirements already defined in Linear ticket).

---

## Phase Execution Pattern

For each phase:

1. **Read phase file** for detailed instructions
2. **Offer to skip:** "Ready to start Phase X? Or skip?"
3. **If skipping:** Update state.yaml with `status: "SKIPPED"`, proceed to next phase
4. **If proceeding:**
   - Update state.yaml: `status: "IN_PROGRESS"`, `started_at: {timestamp}`
   - Execute the phase command
   - Run `/create_handoff {project-directory-path}`
   - **Confirm #1:** "Phase X complete. Mark as COMPLETED?"
   - Update state.yaml: `status: "COMPLETED"`, `ended_at: {timestamp}`
   - **Confirm #2:** "Ready to proceed to Phase Y?"
5. **On error:** STOP, inform user, wait for intervention

---

## State Management

**Phase states:** `NOT_STARTED` | `IN_PROGRESS` | `COMPLETED` | `SKIPPED` | `BLOCKED` | `FAILED`

**state.yaml format:**
```yaml
phases:
  - number: 1
    name: "context-creation"
    status: "COMPLETED"
    started_at: "2026-01-27T10:58:38.114Z"
    ended_at: "2026-01-27T11:05:22.000Z"
  - number: 2
    name: "codebase-research"
    status: "IN_PROGRESS"
    started_at: "2026-01-27T11:06:00.000Z"
    ended_at: null
```

Phases not in the array are `NOT_STARTED`.

---

## Project Directory Structure

```
workflow/{username}/{project-slug}/
├── state.yaml
└── resources/
    ├── prd.md
    ├── user-context.md
    ├── codebase-research.md
    ├── user-stories.md
    ├── prototype.md
    ├── product_requirements.md
    ├── tad.md
    ├── linear-tickets.md
    ├── implementation-plan.md
    └── handoffs/
        └── YYYY-MM-DD_HH-MM-SS_description.md
```

---

## Critical Rules

- **Detect workflow type first** — ticket vs project determines which phases to run
- **Phases 3-7 (project workflow):** Remind user to write project updates in Linear
- **Phase 9:** Planning only — do NOT create todos or start implementation
- **On error:** STOP immediately, inform user, wait for intervention

---

## Communication Style

- Confirm before significant actions
- Provide progress updates after each phase
- Explain errors clearly and wait for guidance