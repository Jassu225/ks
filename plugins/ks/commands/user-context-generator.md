---
description: Generate user context document for a feature or problem
argument-hint: [project-directory-path]
allowed-tools: Write, Read, Bash, AskUserQuestion
---

# User Context Generator

You are helping the user create a comprehensive context document for a feature or problem they want to work on.

## Input
The user has provided a project directory path: `{project-directory-path}`
This will be used to create the file at: `{project-directory-path}/resources/user-context.md`

Example: `workflow/jaswanth/basic-egl-optimisation` → `workflow/jaswanth/basic-egl-optimisation/resources/user-context.md`

## Process

Follow these steps in order. **Each step is iterative** - keep asking clarifying questions until the user explicitly says they are satisfied or asks to move to the next step.

### Step 1: Gather Customer Problem
Ask: "What problem are customers facing? Describe the pain point or frustration."

After the user responds, ask follow-up questions to clarify:
- Who specifically is affected?
- How often does this problem occur?
- What is the impact when this happens?

Continue asking clarifying questions until the user says they're satisfied or asks to move on.

### Step 2: Gather Current Workflow
Ask: "How do users currently solve or work around this problem? What's their current workflow?"

After the user responds, ask follow-up questions to clarify:
- What tools or steps are involved?
- Where does the friction occur?
- What's most time-consuming about the current approach?

Continue asking clarifying questions until the user says they're satisfied or asks to move on.

### Step 3: Gather Solution
Ask: "What feature or solution are we building to solve this problem? Be specific about functionality and scope."

After the user responds, ask follow-up questions to clarify:
- What are the key user interactions?
- What should happen in edge cases?
- What's explicitly out of scope?

Continue asking clarifying questions until the user says they're satisfied or asks to move on.

### Step 4: Gather Key Assumptions
Ask: "What are the key assumptions or constraints for this solution? Consider technical limitations, user permissions, scope boundaries, etc."

After the user responds, ask follow-up questions to clarify:
- Are there permission or access requirements?
- What dependencies exist?
- What technical constraints should we be aware of?

Continue asking clarifying questions until the user says they're satisfied or asks to move on.

### Step 5: Gather Final Summary
Ask: "Provide a final impact statement (1-2 sentences) that captures the value this feature delivers."

After the user responds, confirm the statement captures the core value. Refine together if needed.

Continue until the user says they're satisfied or asks to move on.

### Step 6: Show Preview and Confirm
Format the gathered information into the following structure:

```
Customer Problem:

  [Customer Problem content, indented with 2 spaces]

Current Workflow:

  [Current Workflow content, indented with 2 spaces]

Solution:

  [Solution content, indented with 2 spaces]

Key Assumptions:

  [Key Assumptions content, indented with 2 spaces]

---
[Final Summary]
```

Show this preview to the user and ask: "Here's the preview of your context document. Does this look good, or would you like to make any changes?"

If the user wants changes, ask what they'd like to modify and repeat the preview.

If the user approves, proceed to Step 7.

### Step 7: Check for Existing File
Use the Read tool to check if `{project-directory-path}/resources/user-context.md` already exists.

If it exists, ask the user: "A context file already exists at this location. Would you like to overwrite it?"
- If yes, proceed to Step 8
- If no, stop and inform the user that no changes were made

### Step 8: Create Directory and Write File
1. Use Bash to create the directory: `mkdir -p {project-directory-path}/resources`
2. Use Write tool to save the formatted content to `{project-directory-path}/resources/user-context.md`
3. Confirm to the user: "✓ Context document created at {project-directory-path}/resources/user-context.md"

## Important Notes
- Be conversational and helpful during the gathering process
- **Each step is iterative** - keep asking clarifying questions until the user explicitly says they're satisfied or asks to move on
- The example follow-up questions are suggestions; adapt based on the user's responses
- If the user says "next", "move on", "that's enough", "I'm satisfied", etc., proceed to the next step
- Ensure proper indentation (2 spaces) for all section content
- The horizontal rule (---) before the final summary is important for visual separation
