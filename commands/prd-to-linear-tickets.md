---
description: Convert PRD user stories into Linear tickets
argument-hint: [project-directory-path]
allowed-tools: Read, Write, mcp__linear-server__get_project, mcp__linear-server__create_issue, AskUserQuestion
---

# Convert PRD User Stories to Linear Tickets

You are tasked with converting Features from resources/user-stories.md into Linear tickets in the Karmasuite team. Each Feature becomes one ticket, with all its user stories consolidated in the description.

## Input & Output

**Input:** A project directory path provided via arguments: `$ARGUMENTS`
- State file: `{project-directory-path}/state.yaml` (for project ID and URL)
- User stories: `{project-directory-path}/resources/user-stories.md`

**Output:**
- Linear tickets preview at `{project-directory-path}/resources/linear-tickets.md`
- Linear tickets created in the project

Example invocation:
```
/prd-to-linear-tickets workflow/jaswanth/budget-category-reordering
```

**CRITICAL**: If the project directory path is not provided, ask the user: "I need a project directory path to proceed. Please provide the path (e.g., 'workflow/jaswanth/budget-category-reordering')."

## Story Point Scale

| Points | Effort |
|--------|--------|
| 1 | Half a day (minimum) |
| 2 | 1 day |
| 3 | 1.5 days |
| 4 | 2 days |
| 5 | 2.5 days |

**Rules:**
- **Minimum points: 1** (even for small features)
- 1 story point = half a day of work
- Estimate points for the entire feature (sum of effort for all user stories in that feature)
- If a feature estimates to more than 5 points, consider whether it should be split

## Process

1. **Read project state**:
   - Read `{project-directory-path}/state.yaml` to get:
     - Project ID (for Linear lookup)
     - Project URL (for reference)

2. **Read and parse user stories**:
   - Read `{project-directory-path}/resources/user-stories.md`
   - Parse the markdown to extract Features and their user stories
   - User stories are grouped under Feature headings (e.g., `## Feature 1: Drag-and-Drop Reordering`)
   - Each user story has: ID (e.g., US-001), title, description, and acceptance criteria

3. **Group user stories by Feature**:
   - Identify all Features in the document
   - Group user stories under their parent Feature
   - Each Feature will become one Linear ticket

4. **Fetch project context**:
   - Use `mcp__linear-server__get_project` with the project ID from state.yaml
   - If the project ID is invalid or not found, use `AskUserQuestion` to ask the user for the correct project ID, then retry

5. **Create markdown preview**:
   - Create a markdown file at `{project-directory-path}/resources/linear-tickets.md`
   - For each Feature: title, consolidated user stories, and estimated story points
   - Ask user to review and approve before proceeding to create Linear tickets

6. **Create Linear tickets**:
   - Team: **Karmasuite** (ID: `8743465b-ed49-4fc6-a266-a4183b8e9f50`)
   - Project: Use the project ID from state.yaml
   - Priority: **3** (Medium)
   - Story Points: Assign based on the story point scale above (for the entire feature)
   - No labels
   - No ticket relationships

## Ticket Structure

For each Feature, use this format:

**Title**: `[Feature Name]`
- Example: "Drag-and-Drop Budget Category Reordering"

**Description**:
```markdown
## Overview
[Brief description of what this feature accomplishes]

## User Stories

### US-001: [User Story Title]
[Concise description - 1-2 sentences max]

**Acceptance Criteria:**
- [ ] [Criterion 1]
- [ ] [Criterion 2]

### US-002: [User Story Title]
[Concise description - 1-2 sentences max]

**Acceptance Criteria:**
- [ ] [Criterion 1]
- [ ] [Criterion 2]

[... additional user stories in this feature ...]

## Context
- **Project**: [Project name from Linear]
- **User Stories**: [List of US IDs, e.g., US-001, US-002, US-003]
```

**Guidelines for concise descriptions:**
- Keep each user story description to 1-2 sentences
- Focus on the "what" not the "how"
- Acceptance criteria should be actionable checkboxes
- Avoid duplicating information across user stories

## Execution Steps

1. Validate project directory path is provided
   - If not provided, ask user for the path
2. Read `{project-directory-path}/state.yaml` to get project ID
3. Fetch project details from Linear using project ID
   - If project not found, ask user for correct project ID
4. Read `{project-directory-path}/resources/user-stories.md`
5. Parse markdown and identify Features (## Feature X: Name)
6. Group user stories under their parent Feature
7. Estimate story points for each Feature (sum of effort for all user stories)
8. Create markdown preview file at `{project-directory-path}/resources/linear-tickets.md` containing:
   - One ticket per Feature with consolidated user stories and estimated points
9. Ask user to review and approve the markdown preview before proceeding
10. Once approved, for each Feature:
    - Formulate title from the Feature name
    - Create description with:
      - Overview: Brief description of the feature
      - User Stories: Concise list of all user stories with their acceptance criteria
      - Context: Reference the project name and list of user story IDs
    - Assign story points based on feature estimate
    - Create the ticket using `mcp__linear-server__create_issue`
11. Report back to the user with a summary of created tickets (Feature names, IDs, and points)

## Important Notes

- **One ticket per Feature** - All user stories in a feature are consolidated into one ticket
- Keep user story descriptions concise (1-2 sentences) in the ticket
- Include all user story IDs in the Context section for traceability
- Convert all acceptance criteria items to checkbox format (- [ ])
- If resources/user-stories.md doesn't exist or has no features, inform the user and stop
- If project ID is invalid, prompt the user for the correct ID using AskUserQuestion
- Always assign story points (minimum 1 point per ticket)
- Always create and get approval on the markdown preview before creating Linear tickets
- The goal is to create actionable, well-scoped tickets that developers can pick up and implement

## Error Handling

If any of the following occur, flag to the user for review:
- state.yaml not found or missing required fields (id, url)
- resources/user-stories.md not found
- Feature property not found in any user story in resources/user-stories.md
- No user stories found under Features
- Linear project not found with the given ID

Begin execution now with the provided arguments.
