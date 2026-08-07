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
| 4 | PRD User Stories | `/ks:create-user-stories` | — |
| 5 | Prototype Build & Summary | `/ks:build-prototype` | — |
| 6 | Complete PRD | `/ks:add-product-requirements` | — |
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
5. Confirm completion and update `state.yaml` to `COMPLETED`
6. Generate a handoff document via `/ks:create_handoff`
7. Ask if you're ready for the next phase

Phases can be skipped — they are marked as `SKIPPED` in `state.yaml`.

## Phase States

Each phase tracks its status: `NOT_STARTED` | `IN_PROGRESS` | `COMPLETED` | `SKIPPED` | `REVISITING` | `INVALIDATED`

Timestamps depend on whether the phase iterates:

- **Non-iterating phases (1–8)** — `started_at` / `ended_at` on the phase itself.
- **Iterating phases (9 Implementation Plan, 10 Implementation)** — an `iterations[]` array of `{started_at, ended_at}` instead; the current iteration number is the array length, and `ended_at: null` means that iteration is still in progress. The phase-level `started_at`/`ended_at` are unused there.

Both shapes are enforced by `scripts/project-state.schema.json` / `scripts/ticket-state.schema.json`, where only `number`, `name`, and `status` are required.

## PR Tracking

Every PR raised for a workflow is recorded in `state.yaml` under a top-level `prs[]` array **at PR-creation time** (`/ks:create_pr` writes the entry: `url`, `branch`, `created_at`, `review_thread: null`). When the PR is sent for review in Slack (`pr-review-request` template), the same entry's `review_thread` is updated with the Slack thread reference (`channel_id`, `channel_name`, `ts`, `url`). The entry shape is enforced by the state schemas (`scripts/ticket-state.schema.json`, `scripts/project-state.schema.json`) — no other keys are allowed. The legacy `slack.pr_review_threads[]` key has been removed from the schemas; do not write it. When **reading older state files**, that key may still be present — each entry holds a review thread with `channel_id`, `channel_name`, `ts`, `url`, and the PR link in `pr_url` (PR-level metadata like branch/created_at was not recorded). Treat it as a read-only fallback and migrate to `prs[]` on the next write.

## Workflow Directory Layout

```
workflow/{username}/{project-slug}/
├── state.yaml              # Phase tracking
└── resources/
    ├── user-context.md     # Phase 1
    ├── codebase-research.md # Phase 2
    ├── prd.md              # Phase 3 (initial) → Phase 6 (completed with product requirements)
    ├── user-stories.md     # Phase 4
    ├── prototype.md        # Phase 5
    ├── tad.md              # Phase 7
    ├── linear-tickets.md   # Phase 8
    ├── implementation-plan-01.md # Phase 9 (iteration 1, and -02, -03, etc.)
    └── handoffs/           # Between-phase documentation
```

## Session Management

Start a new session for each phase. Use handoff documents to transfer context between sessions.

| Phases | Launch Command |
|--------|---------------|
| 1, 3, 4, 5, 6, 7, 8 | `claude-ks` |
| 2, 9 | `claude-ks-serena` |
| 10 | `claude-ks-serena --plugin code-review@claude-plugins-official` |

Phases 2, 9, and 10 require Serena for semantic code analysis. Phase 10 also includes the code review plugin for automated PR review at the end.

## Key Boundaries

- **Phase 9 is planning only** — no code changes happen until Phase 10
- **Codebase research (Phase 2)** produces an incrementally updatable document — re-run `/ks:research_codebase` to refresh it with new findings at any point
- **Handoffs** are generated between phases to document decisions and context
