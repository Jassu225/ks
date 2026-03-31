# Workflow Comparison: User's Mental Model vs Actual Implementation

Date: 2026-03-31

Comparison of Jaswanth's description of the 10-phase project manager workflow against the actual implementation in the codebase.

---

## Phase 1: Context Creation — Mostly Accurate

**User's description:** 4 steps — Customer Problem, Current Workflow, Solution, Key Assumptions + Preview and Confirm.

**Actual (`/ks:user-context-generator`):** 5 steps — adds a **Step 5: Final Impact Statement** before the preview. This step was missed in the description.

**Minor:** Output file is `user-context.md`, not `context.md`.

---

## Phase 2: Codebase Research — Accurate

**User's description:** Takes context doc as input, outputs `codebase_research.md`. Uses `/research_codebase` skill.

**Actual (`/ks:research_codebase`):** Correct. Uses `user-context.md` to determine what to research. Spawns parallel sub-agents (codebase-locator, codebase-analyzer, codebase-pattern-finder, optional web-search-researcher).

**Minor:** File is `codebase-research.md` (hyphens, not underscores).

---

## Phase 3: Initial PRD — Minor Input Discrepancy

**User's description:** Takes both context doc and codebase-research doc as input. Uses `/write_problem_statement` and `/linear`.

**Actual (`/ks:write-problem-statement`):** Reads `state.yaml` and `codebase-research.md`. Does **not** directly read `user-context.md` — instead asks iterative clarifying questions until exit criteria are met. The user provides that context live, not via file.

Also: The command itself handles the Linear update (posts to project description), so a separate `/ks:linear` call is not needed — the project-manager orchestrates that.

---

## Phase 4: User Stories — Minor Input Discrepancy

**User's description:** Uses context, research doc, initial PRD to create user stories. "Basically what UI flows to build without any technical information."

**Actual (`/ks:create-user-stories`):** Reads `state.yaml`, `prd.md` (optional), and `codebase-research.md`. Does **not** read `user-context.md` directly.

**Content discrepancy:** The actual command generates user stories with acceptance criteria, functional requirements (FR-1, FR-2...), technical considerations, success metrics, and open questions. It's more than just UI flows — it includes technical detail aimed at junior devs and AI agents.

---

## Phase 5: Prototype — Significant Discrepancy

**User's description:** "I go to Claude web and create a prototype." Notes Claude web running out of context as a problem.

**Actual (`/ks:build-prototype`):** The command builds the prototype **within Claude Code itself**, modifying actual code in the KarmaSuite codebase. It has a mandatory clarifying questions phase, spawns implementation agents, modifies existing pages/components, and outputs both code changes AND `prototype.md`.

**Analysis:** The user describes their actual practice (using Claude web) rather than what the tool does. The tool is designed to build working code prototypes in-place. The note about Claude web running out of context confirms this is a workaround, not the intended flow.

---

## Phase 6: Product Requirements — Input Discrepancy

**User's description:** Uses context doc, research doc, and prototype doc. Uses `/add-product-requirements`.

**Actual (`/ks:add-product-requirements`):** Reads `state.yaml`, `prd.md` (existing from Phase 3), `prototype.md`, and `codebase-research.md`. The existing PRD is a key input not mentioned. Does **not** read `user-context.md` directly.

---

## Phase 7: TAD — Input Discrepancy

**User's description:** Uses context doc, user stories doc, prototype doc, and research doc. Uses `/write-tad`. Creates TAD doc in Linear after iteration.

**Actual (`/ks:write-tad`):** Reads `state.yaml`, `prd.md` (optional), `user-stories.md`, `prototype.md`, `codebase-research.md`, AND fetches Linear project details. Missing from user's description: **PRD** and **Linear project details** as inputs.

---

## Phase 8: Linear Tickets — Input Discrepancy

**User's description:** Uses context doc, user stories doc, TAD doc, and research doc. Uses `/prd-to-linear-tickets`. Creates tickets in Linear using linear CLI.

**Actual (`/ks:prd-to-linear-tickets`):** Reads `state.yaml` and `user-stories.md` **only**. Does **not** read context, TAD, or research docs. Tickets are grouped by Feature from user stories, not derived from TAD.

Also: This phase is marked as **optional** in the implementation — users can skip if they prefer manual ticket creation.

---

## Phase 9: Implementation Plan — Minor Discrepancy

**User's description:** Uses context doc, PRD, user stories, prototype, TAD, linear tickets, and codebase research. Uses `/create_plan`. Generates `implementation-plan.md`.

**Actual (`/ks:create_plan`):** For **project workflow**: reads PRD, user stories, prototype, TAD, and codebase research. Does **not** read `user-context.md` or `linear-tickets.md` directly. For **ticket workflow**: reads Linear ticket, user context, and research only.

**Minor:** Output is `implementation-plan-{NN}.md` (numbered, e.g., `-01`, `-02`), supporting multiple iterations. User said just "implementation-plan.md".

---

## Phase 10: Implementation — Partially Accurate

**User's description:** Uses all docs, agent writes code. Uses `/implement-plan`. Notes: "Need to make improvements here as it doesn't specify detailed implementation steps on when to commit, raise a PR and create handoff."

**Actual (`/ks:implement-plan`):** The command **does** specify these steps:
- Commits after user approval per phase
- Creates PR via `/ks:create_pr` after all phases complete
- Runs automated code review via subagent
- Project manager creates handoff after phase completion

**Analysis:** The spec covers commit/PR/handoff. The user's concern may be about actual runtime behavior not matching the spec, or the orchestration not being granular enough.

---

## Missing From User's Brief

| Missing Item | Details |
|---|---|
| **Ticket workflow** | Only the project workflow was described. Actual implementation supports a ticket workflow (phases 1, 2, 9, 10 only) for quick-turnaround Linear tickets. |
| **Linear project updates** | Phases 3, 5, 6, 7 post status updates to Linear. Not mentioned. |
| **Session boundaries** | Implementation recommends starting new Serena sessions after phases 1, 2 (ticket), and 8 for semantic code analysis. |
| **Handoff documents** | Created after each phase completion at `resources/handoffs/`. Not mentioned. |
| **Phase revisit mechanism** | Phases can be revisited, which invalidates downstream phases. Alluded to in Phase 5 ("might affect step 4") but not described formally. |
| **Iteration support (phases 9-10)** | These phases support multiple iterations tracked via `iterations` array in state.yaml. |
| **Architect command** | `/ks:architect` exists for plan and code review as a senior architect — not mentioned in the workflow. |
| **Deploy command** | `/ks:deploy` exists for production deployment. Not mentioned. |

---

## Recurring Patterns in Discrepancies

1. ~~**`user-context.md` listed as input too broadly**~~ — **FIXED**: All phases 3-9 now read `user-context.md` as an input, matching the user's expectation that every phase has access to the original customer problem context.

2. **Phase 5 practice vs tooling gap** — The prototype phase is the biggest gap between what the user does (Claude web) and what the tool provides (in-CLI prototype builder).

3. ~~**Phase 8 inputs are overstated**~~ — **FIXED**: Now reads `user-context.md`, `tad.md`, and `codebase-research.md` in addition to `user-stories.md`. TAD informs technical complexity for story point estimation, and research informs implementation effort. Tickets include a Technical Context section with relevant TAD details.

4. ~~**Phase 10 spec is more complete than perceived**~~ — **FIXED**: Project workflows now create a PR per phase against the project branch, with a final consolidated PR to main. Ticket workflows retain the single-PR-at-the-end flow.
