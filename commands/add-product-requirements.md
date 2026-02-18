---
description: Add prioritized product requirements to Linear project from prototype
argument-hint: [project-directory-path]
allowed-tools: Read, Write, Edit, WebFetch, mcp__linear-server__*
model: opus
---

# Add Product Requirements to Linear Project

This command reads the prototype summary and research documents, generates a prioritized Product Requirements document, iterates with the user until satisfied, then appends it to the Linear project description.

## Input & Output

**Input:** A project directory path provided via arguments: `$ARGUMENTS`
- State file: `{project-directory-path}/state.yaml` (for project ID and URL)
- Prototype summary: `{project-directory-path}/resources/prototype.md`
- Research file: `{project-directory-path}/resources/codebase-research.md`

**Output:**
- Product requirements document at `{project-directory-path}/resources/product_requirements.md`
- Updated Linear project description (appended, not replaced)

Example invocation:
```
/add-product-requirements workflow/jaswanth/budget-category-reordering
```

## Process

1. **Read Project State**
   - Read `{project-directory-path}/state.yaml` to get project ID and URL

2. **Read Documents**
   - Read the research document at `{project-directory-path}/resources/codebase-research.md`
   - Read the prototype summary from `{project-directory-path}/resources/prototype.md`
   - Fetch the current Linear project description using the URL from state.yaml

3. **Extract and Map Priorities**
   - **High priority** → P0
   - **Medium priority** → P0
   - **Low priority** → P1
   - **Non-goals section** (if present) → P2

4. **Generate Product Requirements Document**
   - Create `{project-directory-path}/resources/product_requirements.md`
   - Automatically group requirements by **module/area**
   - Use **bold formatting** for module names
   - Create nested bullet structure: Module → Page/Feature → Specific UI components
   - **CRITICAL**: Only mention user-facing modules and sections
   - **NO technical implementation details** (no APIs, database fields, code changes, etc.)
   - Include "(if needed)" for P1 and P2 sections only when appropriate
   - Use "None identified" if no items exist for a priority level

5. **Iterate with User**
   - Present the draft to the user
   - Ask for feedback and make requested changes
   - Update `resources/product_requirements.md` with each iteration
   - Continue until user explicitly approves the document

6. **Update Linear Project**
   - When user explicitly approves, fetch the current project description:
     - Use `mcp__linear-server__get_project` with `id`: project ID from state.yaml
     - Extract the current `description` field (contains the problem statement from Phase 3)
   - Combine the existing description with the new Product Requirements section:
     - Keep all existing content intact
     - Add a blank line after existing content
     - Append the full content of `resources/product_requirements.md`
   - Update the Linear project:
     - Use `mcp__linear-server__update_project` with:
       - `id`: project ID from state.yaml
       - `description`: the combined content (existing + product requirements)

## Error Handling

If any of the following occur, flag to the user for review:
- state.yaml not found or missing required fields (id, url)
- resources/prototype.md not found
- Prototype doesn't have clear feature details
- Linear project already has a "Product requirements" section
- Unable to parse the prototype structure

## Example Output Format

```markdown
## Product requirements

### P0

* **Fund Repository**
  * **Fund details → Budget page**
    * **Budget tab**: Enable budget category re-ordering via drag-and-drop on rows.
    * **Account Mapping tab**: Enable budget category re-ordering via drag-and-drop on rows.
    * **Funds Available tab/page**:
      * Show budget category rows in the saved custom order (read-only).
      * **"Spent" deep dive drawer (opened from the "Spent" column header)**: Budget category selector shows budget categories in the saved custom order.
        * **By Transaction tab (Expense Actuals grid)**: The **Budget Category selector** inside the transactions grid follows the saved custom order.
    * **Budget page CSV export**: Export budget category rows in the saved custom order.
  * **Fund details → Budget Summary card ("Budget" tile)**
    * **Available view**: Show budget category rows in the saved custom order.
    * **Account Mapping view**: Show budget category rows in the saved custom order.
* **Funds Remaining**
  * **Funds Remaining → By Fund page**
    * **Tables (by selected fund(s))**: Show budget category rows in the saved custom order.
    * **Exports (download all tables)**: Export budget category rows in the saved custom order.
    * **"Spent" deep dive drawer (opened from the "Spent" column header)**:
      * Budget category selector shows budget categories in the saved custom order.
      * **By Transaction tab (Expense Actuals grid)**: The **Budget Category selector** inside the transactions grid follows the saved custom order.
  * **Funds Remaining → Total Spent drawer (opened from "Total Spent")**
    * **Expense Actuals grid within the drawer → Budget Category selector**: Show budget category options in the saved custom order.
* **Fund Coder**
  * **Fund Coder grid → Proposed Budget Category selector**: Show budget category options in the saved custom order.
* **Expense Actuals**
  * **Expense Actuals → Main grid**
    * **Budget Category column (selector)**: Show budget category options in the saved custom order.
  * **Expense Actuals → Upload flow (upload grid)**
    * **Budget Category selector**: Show budget category options in the saved custom order.
  * **Expense Actuals → "Quick Actions" drawer**
    * **Expense Actuals grid within the drawer → Budget Category selector**: Show budget category options in the saved custom order.
* **Funding Gap/Excess**
  * **Fund Allocation deep-dive drawer → Budget category table**: Show rows in the saved custom order.
  * **Increase Grant Budget action → Planned budget categories table**: Show rows in the saved custom order.
* **Fund Forecasting → Grants/Contracts**
  * **Fund table → Fund name cell deep-dive modal (opens on clicking a fund name)**
    * **Budget categories table inside the modal**: Show budget category rows in the saved custom order.
  * **Grant Reconciliation modal → Planned vs Actual reconciliation table**: Show rows in the saved custom order.

### P1 (if needed)

* **Fund Repository → Fund details → Budget page (Budget + Account Mapping tabs)**
  * Add lightweight in-product guidance so users discover drag-and-drop reordering.

### P2 (if needed)

* None identified.
```

## Important Notes

- **User-facing only**: Focus on **what** the user sees and does, not **how** it's implemented
- **No technical details**: Never mention APIs, database fields, code changes, components, or implementation specifics
- **Hierarchical structure**: Module → Page → Component (user-facing names only)
- **Preserve existing content**: When updating Linear, APPEND to existing description, never replace
- **Iterate until satisfied**: Do not push to Linear until user explicitly approves
- **Exact formatting**: Preserve the indentation and bullet structure as shown in the example
