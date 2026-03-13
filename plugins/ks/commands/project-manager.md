---
description: Orchestrate end-to-end project management workflow from PRD creation to implementation.
allowed-tools: Bash, Glob, Grep, Read, Edit, Write, NotebookEdit, WebFetch, WebSearch, Skill, Task
---

# Project Manager Agent

Orchestrates a 10-phase software project lifecycle. Phases with separate phase files have detailed instructions; phases without one (3-7) are simple command-and-verify steps described inline below.

## Initial Interaction

When invoked:
1. Check if a project directory was provided as an argument
2. If not provided, ask: "Please provide the project directory path (e.g., `workflow/{username}/{project-slug}`)"
3. Read `state.yaml` from the provided project directory
4. Check for handoff files in `{project-directory-path}/resources/handoffs/`. If any exist, read the **latest** one (sorted by filename timestamp) to understand prior session context, debugging trail, and resume point.
5. **Detect workflow type**: Check if root key is `project` or `ticket`
   - If `ticket` key exists → **Ticket Workflow** (phases 1, 2, 9, 10 only)
   - If `project` key exists → **Project Workflow** (all 10 phases)
6. Parse the `phases` array to determine status (phases not in array are NOT_STARTED)
7. Determine status:
   - **Ticket workflow**: "I see this is a ticket workflow: {ticket.identifier} - {ticket.name}. This uses an abbreviated workflow (Phases 1, 2, 9, 10). Ready to begin?"
   - **Project workflow (fresh)**: "I see this is a fresh project: {project-name}. Ready to begin Phase 1 (Context Creation)?"
   - **Resuming**: Show phase status summary (including any SKIPPED, INVALIDATED, or previously revisited phases) and ask which phase to continue from. If any phases are `INVALIDATED`, highlight them and ask whether to process them first or continue from the next `NOT_STARTED` phase.

---

## Phases

**Phase files location:** Read the `$KS_PHASE_FILES_DIR` environment variable (run `echo $KS_PHASE_FILES_DIR` via Bash). Phases with a phase file have detailed instructions in that directory. Phases 3-7 have no separate files — their instructions are inline below.

| # | Name | state.yaml name | Command | Output Files | Linear Update | Phase File | Ticket |
|---|------|-----------------|---------|--------------|:---:|---|:------:|
| 1 | Context Creation | `context-creation` | `/ks:user-context-generator` | `user-context.md` | — | `01-context-creation.md` | ✓ |
| 2 | Codebase Research | `codebase-research` | `/ks:research_codebase` | `codebase-research.md` | — | `02-codebase-research.md` | ✓ |
| 3 | Initial PRD Draft | `initial-prd-draft` | `/ks:write-problem-statement` | `prd.md`, Linear project desc | ✓ | — | — |
| 4 | PRD User Stories | `prd-user-stories` | `/ks:create-user-stories` | `user-stories.md` | — | — | — |
| 5 | Prototype Build & Summary | `prototype-creation` | `/ks:build-prototype` | code changes, `prototype.md` | ✓ | — | — |
| 6 | Complete PRD | `complete-prd` | `/ks:add-product-requirements` | `prd.md` (updated), Linear project desc | ✓ | — | — |
| 7 | TAD Creation | `tad-creation` | `/ks:write-tad` | `tad.md`, Linear project desc | ✓ | — | — |
| 8 | Linear Tickets Creation | `linear-tickets-creation` | `/ks:prd-to-linear-tickets` | `linear-tickets.md`, Linear tickets | — | `08-linear-tickets-creation.md` | — |
| 9 | Implementation Plan | `implementation-plan-creation` | `/ks:create_plan` | `implementation-plan-NN.md` | — | `09-implementation-plan-creation.md` | ✓ |
| 10 | Implementation | `implementation` | `/ks:implement-plan` | code changes | — | `10-implementation.md` | ✓ |

> **Ticket workflows** skip phases 3-8 (requirements already defined in Linear ticket).

### Phases 3-7: Inline Instructions

Phases 3-7 are simple command-and-verify steps with no separate phase files. Follow the standard Phase Execution Pattern below.

**Execution:** Run the phase's command (from the table above) with `{project-directory-path}` as argument. Verify the output files listed in the table were created.

**Linear project update (phases 3, 5, 6, 7):** After the command completes, post a project update using the project ID from `state.yaml`:
```
linear project update <project-id> --body "<update message>" --health onTrack
```
Show the update body to the user and ask for confirmation before posting. Use these messages:
- **Phase 3:** "Initial draft PRD is complete. Please review"
- **Phase 5:** "Prototype built and summary created. Please review"
- **Phase 6:** "Completed PRD with product requirements. Please review"
- **Phase 7:** "Created draft TAD. Please review"

---

## Phase Execution Pattern

For each phase:

1. **If phase has a phase file**, read it for detailed instructions. If not (phases 3-7), use the inline instructions above.
2. **Offer to skip:** "Ready to start Phase X? Or skip?"
3. **If skipping:** Update state.yaml with `status: "SKIPPED"`, proceed to next phase
4. **If proceeding:**
   - **Phases 1-8:** Update state.yaml: `status: "IN_PROGRESS"`, `started_at: {timestamp}`
   - **Phases 9-10:** Update state.yaml: `status: "IN_PROGRESS"`, append new entry to `iterations` array with `started_at: {timestamp}`, `ended_at: null` (or update existing entry if resuming current iteration)
   - Run the phase's command and verify output files
   - For phases with a phase file: perform the **Execution Steps** and **Post-Completion Steps** from that file
   - For phases 3-7: run the command, verify outputs, post Linear update if applicable (see inline instructions above)
   - **Confirm:** "Phase X complete. Mark as COMPLETED?"
   - **Phases 1-8:** Update state.yaml: `status: "COMPLETED"`, `ended_at: {timestamp}`
   - **Phases 9-10:** Update state.yaml: `status: "COMPLETED"`, set `ended_at: {timestamp}` on the latest `iterations` entry
   - Run `/ks:create_handoff {project-directory-path}`

> **Phases 9 and 10 support iteration** — see Phase 9-10 Iteration below.
---

## Phase Revisit

When a later phase reveals problems in an earlier phase (e.g., prototyping shows the PRD is wrong), the user can request a phase revisit.

### Triggering a Revisit

1. **User requests revisit:** "I need to go back to Phase 3" or "The PRD needs rework based on prototype feedback"
2. **Confirm scope:** "Revisiting Phase 3 will mark Phases 4-5 as INVALIDATED (they'll need re-evaluation). Proceed?"
3. **Record reason:** Ask the user why the revisit is needed (this gets stored in state.yaml)

### Revisit Execution

1. Update state.yaml for the revisited phase:
   - Set `status: "REVISITING"`
   - Add entry to the phase's `revisits` array with `reason` and `started_at`
2. Mark all downstream completed/skipped phases (between the revisited phase and the current phase) as `status: "INVALIDATED"`
3. Execute the phase using the normal **Phase Execution Pattern** (read phase file, run command, etc.)
4. On completion:
   - Update the phase's `revisits` entry with `ended_at`
   - Set `status: "COMPLETED"` (same as normal completion)
   - Run `/ks:create_handoff {project-directory-path}`

### Handling Invalidated Phases

After completing a revisit, work forward through each `INVALIDATED` phase in order. For each one, ask:

- **"Redo Phase X?"** → Execute the phase normally (status goes `IN_PROGRESS` → `COMPLETED`)
- **"Re-approve Phase X as-is?"** → User confirms the existing output is still valid. Set `status: "COMPLETED"` (no new timestamps, no re-execution)
- **"Skip Phase X?"** → Set `status: "SKIPPED"`

### Resuming with Invalidated Phases

When resuming a workflow that has `INVALIDATED` phases, include them in the status summary:

```
Phase 1: COMPLETED
Phase 2: COMPLETED
Phase 3: COMPLETED (revisited 2026-02-01)
Phase 4: INVALIDATED ← needs re-evaluation
Phase 5: INVALIDATED ← needs re-evaluation
Phase 6: NOT_STARTED
```

Ask the user whether to start processing invalidated phases or continue from the first `NOT_STARTED` phase.

---

## Phase 9-10 Iteration

Phases 9 (Implementation Plan) and 10 (Implementation) can cycle multiple times. This is different from the revisit mechanism — iteration is incremental (building on previous work), not corrective (invalidating downstream outputs).

### When to Iterate

After Phase 10 completes (or partially completes), the user may need a new plan because:
- Implementation revealed issues that require re-planning
- Scope changed based on feedback during implementation
- The work was intentionally split into multiple plan-implement cycles

### How Iteration Works

1. **User requests a new plan** after Phase 10: "I need another implementation plan" or "Let's create a new plan based on feedback"
2. **Add new iteration:** Append a new entry to the `iterations` array on both Phase 9 and Phase 10 in state.yaml (with `started_at`, `ended_at: null`)
3. **Phase 9 re-executes:** Status goes back to `IN_PROGRESS`. The `/ks:create_plan` command will automatically detect the iteration and reference previous plans (see phase file for details)
4. **New numbered plan file:** Each iteration produces `implementation-plan-NN.md` (e.g., `implementation-plan-01.md`, `implementation-plan-02.md`)
5. **Phase 10 re-executes:** Picks up the latest numbered plan file
6. **Normal completion:** Both phases follow the standard completion flow (confirm, mark COMPLETED, create handoff). The latest iteration entry gets its `ended_at` timestamp.

### File Naming

- Iteration 1: `implementation-plan-01.md`
- Iteration 2: `implementation-plan-02.md`
- Iteration N: `implementation-plan-{NN}.md` (zero-padded)

Previous plans are preserved — never overwrite or delete earlier iteration files.

### State.yaml Tracking

The current iteration number is the length of the `iterations` array. Timestamps live inside each iteration entry, not at the phase level.

```yaml
- number: 9
  name: "implementation-plan-creation"
  status: "COMPLETED"
  iterations:
    - started_at: "2026-01-28T09:00:00Z"
      ended_at: "2026-01-28T10:00:00Z"
    - started_at: "2026-02-01T09:00:00Z"
      ended_at: "2026-02-01T10:00:00Z"
- number: 10
  name: "implementation"
  status: "COMPLETED"
  iterations:
    - started_at: "2026-01-28T10:30:00Z"
      ended_at: "2026-01-28T14:00:00Z"
    - started_at: "2026-02-01T10:30:00Z"
      ended_at: "2026-02-01T12:00:00Z"
```

For phases 1-8, timestamps remain at the phase level (`started_at`, `ended_at`) as before.

### Interaction with Revisit

If a revisit from phases 1-8 cascades and invalidates Phase 9, the next execution of Phase 9 bumps the iteration counter and creates a new numbered plan. The revisit triggers re-execution; the iteration mechanism handles file naming.

---

## State Management

**Phase states:** `NOT_STARTED` | `IN_PROGRESS` | `COMPLETED` | `SKIPPED` | `REVISITING` | `INVALIDATED`

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
  - number: 3
    name: "initial-prd-draft"
    status: "COMPLETED"
    started_at: "2026-01-28T09:00:00Z"
    ended_at: "2026-01-28T10:00:00Z"
    revisits:
      - reason: "Prototype revealed incorrect assumptions about user flow"
        started_at: "2026-02-01T09:00:00Z"
        ended_at: "2026-02-01T10:30:00Z"
```

Phases 9 and 10 use an `iterations` array instead of top-level `started_at`/`ended_at` — see Phase 9-10 Iteration above. The current iteration number is the length of the array.

Phases not in the array are `NOT_STARTED`.

---

## Project Directory Structure

```
workflow/{username}/{project-slug}/
├── state.yaml
└── resources/
    ├── user-context.md
    ├── codebase-research.md
    ├── prd.md              # Phase 3 (initial) → Phase 6 (completed with product requirements)
    ├── user-stories.md
    ├── prototype.md
    ├── tad.md
    ├── linear-tickets.md
    ├── implementation-plan-01.md  # Iteration 1 (and -02, -03, etc.)
    └── handoffs/
        └── YYYY-MM-DD_HH-MM-SS_description.md
```

---

## Critical Rules

- **MANDATORY: Before marking any phase as COMPLETED, verify all steps were performed — re-read the phase file (for phases that have one) or check the inline instructions (for phases 3-7).**
- **MANDATORY: After marking a phase as COMPLETED, you MUST run `/ks:create_handoff {project-directory-path}`. Never skip this step. Every completed phase must have a handoff document.**
- **Detect workflow type first** — ticket vs project determines which phases to run
- **Phases 3, 5, 6, 7 (project workflow):** Use the Linear CLI (`linear project update`) to post project updates after each phase
- **Phase 9:** Planning only — do NOT create todos or start implementation
---

## Communication Style

- Confirm before significant actions
- Provide progress updates after each phase