---
description: Create a Technical Architecture Document (TAD) and attach it to a Linear project
argument-hint: [project-directory-path]
allowed-tools: Read, Write, Edit, mcp__linear-server__get_user, mcp__linear-server__get_project, mcp__linear-server__list_projects, mcp__linear-server__create_document
model: opus
---

# TAD Creator

Create a Technical Architecture Document (TAD) based on project requirements and attach it to a Linear project.

## Input & Output

**Input:** A project directory path provided via arguments: `$ARGUMENTS`
- State file: `{project-directory-path}/state.yaml` (for project ID and URL)
- Problem statement (optional): `{project-directory-path}/resources/prd.md`
- User stories: `{project-directory-path}/resources/user-stories.md`
- Prototype summary: `{project-directory-path}/resources/prototype.md`
- Research file: `{project-directory-path}/resources/codebase-research.md`

**Output:**
- TAD document at `{project-directory-path}/resources/tad.md`
- Linear document attached to project

Example invocation:
```
/write-tad workflow/jaswanth/budget-category-reordering
```

## Process

Follow these steps to create a comprehensive TAD:

### 1. Read Project State

Read `{project-directory-path}/state.yaml` to get:
- Project ID (for Linear lookup)
- Project URL (for reference)

### 2. Get Current User

Use `mcp__linear-server__get_user` with query "me" to get the current user's displayName for the Author field.

### 3. Fetch Project Details

Use `mcp__linear-server__get_project` with the project ID from state.yaml to retrieve the project description from the Linear overview page.

**Important**: If `get_project` fails:
- Use `mcp__linear-server__list_projects` with a search query to find the project
- Extract the project ID from the results
- Use the project ID for subsequent steps

### 4. Read Input Files

- Read the problem statement from `{project-directory-path}/resources/prd.md` (if exists)
- Read the user stories from `{project-directory-path}/resources/user-stories.md`
- Read the prototype summary from `{project-directory-path}/resources/prototype.md`
- Read the research document at `{project-directory-path}/resources/codebase-research.md`
- The Linear project description from step 3 contains the main requirements from the overview page

### 5. Analyze Requirements

Carefully analyze the project description, user stories, prototype, and research documents to extract:
- Main needs and requirements
- Product goals and user stories
- Context for why a TAD is needed
- Technical considerations and constraints
- Integration points with existing systems

### 6. Generate TAD Content

Create a TAD document using this exact format:

```markdown
# Technical Approach

Author: {@username}

Approver: {@kuldeep and @Jon}

Approved?: No

# Summary

{write a few sentences summarizing the main needs from the PRD. reference specific bulletpoints if possible. provide some context about why a TAD is needed.}

# Technical Requirements (optional)

{if there are additional requirements for this project that aren't immediately product-facing, list them out here}

# Proposed Solution(s)

{repeat the below sections as needed, if you have multiple ideas}

## Strategy

{walk me through what this solution will do and how you see it addressing the requirements. call out the assumptions you're making and which requirements it satisfies well or not at all}

## Changes to Data Models

{actually list out the Prisma schema in a blockquote and let us review the proposed changes here, not in a PR}

## Changes to RPCs

{at a high level, can we leverage existing RPCs with a few tweaks or do we need new ones? no more detail than the API signature **unless** the behavior inside the RPC is the thing approach you need feedback on}

### Changes to React Components

{Are there existing components that can be leveraged? Are there new re-usable atoms/molecules that we should introduce as part of this work? It's okay if that means execution will take longer. Think about balancing (over)-abstracting an existing component vs forking/creating a new component.}

## Changes to architecture

{are we using new tech or infra? do we need to organize things in a new package? are we introducing a new library? will we need a new pattern of a usage of a thing? lay it out here}

## Supporting the feature flag

{do we need a feature flag for this new/improved feature? are we concerned about it being particularly complex to support? how will we add it to the Front End and Back End?}
```

**Important**:
- Replace `{@username}` with @{displayName} from the user info in step 2 (e.g., @jaswanth)
- Fill in all the bracketed sections with thoughtful, detailed content based on your analysis
- Provide specific technical details, especially in the data models and RPC sections
- Consider the KarmaSuite codebase architecture (Next.js, Prisma, tRPC, etc.)

### 7. Save and Iterate with User

1. Save the generated TAD to `{project-directory-path}/resources/tad.md`
2. Present the draft to the user
3. Ask for feedback and make requested changes
4. Update `resources/tad.md` with each iteration
5. Continue until user explicitly approves the document

### 8. Create Linear Document

When user explicitly approves, use `mcp__linear-server__create_document` to create and attach the TAD to the Linear project:
- **title**: "Technical Approach Document (TAD)"
- **content**: The approved TAD markdown from `resources/tad.md`
- **project**: Use the project ID from state.yaml (the UUID format, e.g., "e132d028-b252-4104-a325-992a39a1d963")
- **icon**: `:page_facing_up:`

### 9. Confirm Success

Display a success message with:
- The created document URL (from the response's `url` field)
- Confirmation that it was attached to the project
- The project name for reference

## Error Handling

If any of the following occur, flag to the user for review:
- state.yaml not found or missing required fields (id, url)
- resources/user-stories.md not found
- resources/prototype.md not found
- Research folder empty
- Linear project already has a TAD document attached

## Notes

- Always set Approver to "@kuldeep and @Jon"
- Always set Approved? to "No"
- Be thorough in analyzing the project requirements
- Consider existing KarmaSuite patterns and architecture
- Provide concrete technical details, not just placeholders
- Do NOT push to Linear until user explicitly approves
