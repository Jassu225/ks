# Workflow Guide

This document explains how the KS project manager workflow operates.

## Getting Started

There are two workflow types, each with its own entry point:

### Project Workflow (full 10 phases)

For new features that need requirements, design, and implementation from scratch.

```bash
ks-start-project <linear-project-url>
```

This will:
1. Fetch the Linear project and its issues
2. Prompt you to select PRD, Prototype, TAD, and Implementation Plan tickets
3. Generate `state.yaml` at `workflow/{username}/{project-slug}/`
4. Create a git worktree for the project
5. Launch Claude with the KS plugin

### Ticket Workflow (phases 1, 2, 9, 10 only)

For specific Linear tickets where requirements are already defined.

```bash
ks-start-ticket <linear-issue-url>
```

This will:
1. Fetch the Linear issue details
2. Generate `state.yaml` at `workflow/{username}/tickets/{identifier}/`
3. Create a git worktree for the ticket
4. Launch Claude with the KS plugin

## Running the Project Manager

Once inside the worktree, start the workflow with:

```
/ks:project-manager workflow/{username}/{project-slug}
```

The project manager reads `state.yaml` and detects the workflow type:
- `project` key → Project Workflow (all 10 phases)
- `ticket` key → Ticket Workflow (phases 1, 2, 9, 10)

## The 10 Phases

| # | Phase | Command | Ticket |
|---|-------|---------|:------:|
| 1 | Context Creation | `/ks:user-context-generator` | yes |
| 2 | Codebase Research | `/ks:research_codebase` | yes |
| 3 | Initial PRD Draft | `/ks:write-problem-statement` | — |
| 4 | PRD User Stories | `/ks:prd` | — |
| 5 | Prototype Creation | `/ks:build-prototype` | — |
| 6 | Product Requirements | `/ks:add-product-requirements` | — |
| 7 | TAD Creation | `/ks:write-tad` | — |
| 8 | Linear Tickets Creation | `/ks:prd-to-linear-tickets` | — |
| 9 | Implementation Plan | `/ks:create_plan` | yes |
| 10 | Implementation | `/ks:implement-plan` | yes |

Ticket workflows skip phases 3–8 since requirements are already defined in the Linear ticket.

## Phase Execution

For each phase, the project manager will:

1. Read the phase file for detailed instructions
2. Ask if you want to proceed or skip
3. Update `state.yaml` to `IN_PROGRESS`
4. Execute the phase command
5. Generate a handoff document via `/ks:create_handoff`
6. Confirm completion and update `state.yaml` to `COMPLETED`
7. Ask if you're ready for the next phase

Phases can be skipped — they are marked as `SKIPPED` in `state.yaml`.

## Phase States

Each phase tracks its status: `NOT_STARTED` | `IN_PROGRESS` | `COMPLETED` | `SKIPPED` | `BLOCKED` | `FAILED`

## Workflow Directory Layout

```
workflow/{username}/{project-slug}/
├── state.yaml              # Phase tracking
└── resources/
    ├── user-context.md     # Phase 1
    ├── codebase-research.md # Phase 2
    ├── prd.md              # Phase 3
    ├── user-stories.md     # Phase 4
    ├── prototype.md        # Phase 5
    ├── product-requirements.md # Phase 6
    ├── tad.md              # Phase 7
    ├── linear-tickets.md   # Phase 8
    ├── implementation-plan.md # Phase 9
    └── handoffs/           # Between-phase documentation
```

## Key Boundaries

- **Phase 9 is planning only** — no code changes happen until Phase 10
- **Codebase research (Phase 2)** produces a living document updated throughout the workflow
- **Handoffs** are generated between phases to document decisions and context
- **On error**, the project manager stops and waits for your input
