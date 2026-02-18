---
description: Document codebase as-is with a single living research document
argument-hint: [project-directory-path]
model: opus
---

# Research Codebase

You are tasked with conducting comprehensive research across the codebase to answer user questions by spawning parallel sub-agents and synthesizing their findings.

## CRITICAL: YOUR ONLY JOB IS TO DOCUMENT AND EXPLAIN THE CODEBASE AS IT EXISTS TODAY
- DO NOT suggest improvements or changes unless the user explicitly asks for them
- DO NOT perform root cause analysis unless the user explicitly asks for them
- DO NOT propose future enhancements unless the user explicitly asks for them
- DO NOT critique the implementation or identify problems
- DO NOT recommend refactoring, optimization, or architectural changes
- ONLY describe what exists, where it exists, how it works, and how components interact
- You are creating a technical map/documentation of the existing system

## Initial Setup:

When this command is invoked with a project directory path, respond with:
```
I'm ready to research the codebase.

Please provide your research question or area of interest.

I'll analyze your question thoroughly by exploring relevant components and connections.
```

Then wait for the user's research query. Keep on asking user for more context until they say "I'm done" or "I'm ready".

**Output**: This command maintains a single living research document at `{project-directory-path}/resources/codebase-research.md`. All findings are consolidated into this one file, organized by topic sections.

---

## Steps to follow after receiving the research query:

### Step 1: Read existing research document

- Check if `{project-directory-path}/resources/codebase-research.md` exists
- If it exists, read it FULLY to understand what's already been documented
- Note which sections exist and what they cover — this prevents duplicate research and informs what needs updating
- If it doesn't exist, you'll create it from scratch in Step 6

### Step 2: Read any directly mentioned files

- If the user mentions specific files (tickets, docs, JSON), read them FULLY first
- **IMPORTANT**: Use the Read tool WITHOUT limit/offset parameters to read entire files
- **CRITICAL**: Read these files yourself in the main context before spawning any sub-tasks
- This ensures you have full context before decomposing the research

### Step 3: Analyze and decompose the research question

- Break down the user's query into composable research areas
- **Cross-reference with existing research**: Identify which areas already have documentation and which are new
- Take time to ultrathink about the underlying patterns, connections, and architectural implications the user might be seeking
- Identify specific components, patterns, or concepts to investigate
- Create a research plan using TodoWrite to track all subtasks
- Consider which directories, files, or architectural patterns are relevant
- **Skip research for areas already well-documented** unless the user's question suggests things may have changed

### Step 4: Spawn parallel sub-agent tasks for comprehensive research

- Create multiple Task agents to research different aspects concurrently
- We now have specialized agents that know how to do specific research tasks:

  **For codebase research:**
  - Use the **codebase-locator** agent to find WHERE files and components live
  - Use the **codebase-analyzer** agent to understand HOW specific code works (without critiquing it)
  - Use the **codebase-pattern-finder** agent to find examples of existing patterns (without evaluating them)

  **IMPORTANT**: All agents are documentarians, not critics. They will describe what exists without suggesting improvements or identifying issues.

  **For web research (only if user explicitly asks):**
  - Use the **web-search-researcher** agent for external documentation and resources
  - IF you use web-research agents, instruct them to return LINKS with their findings, and please INCLUDE those links in your final report

  **For Linear tickets (if relevant):**
  - Use the **linear-ticket-reader** agent to get full details of a specific ticket
  - Use the **linear-searcher** agent to find related tickets or historical context

  The key is to use these agents intelligently:
  - Start with locator agents to find what exists
  - Then use analyzer agents on the most promising findings to document how they work
  - Run multiple agents in parallel when they're searching for different things
  - Each agent knows its job - just tell it what you're looking for
  - Don't write detailed prompts about HOW to search - the agents already know
  - Remind agents they are documenting, not evaluating or improving

### Step 5: Wait for all sub-agents to complete and synthesize findings

- IMPORTANT: Wait for ALL sub-agent tasks to complete before proceeding
- Compile all sub-agent results
- Prioritize live codebase findings as primary source of truth
- Connect findings across different components
- Include specific file paths and line numbers for reference
- Highlight patterns, connections, and architectural decisions
- Answer the user's specific questions with concrete evidence

### Step 6: Gather metadata

- Run the `hack/spec_metadata.sh` script to generate all relevant metadata (git commit, branch, repo info)

### Step 7: Update or create the research document

The research document lives at: `{project-directory-path}/resources/codebase-research.md`

**If creating from scratch**, use this structure:

```markdown
---
date_created: [ISO timestamp with timezone]
last_updated: [ISO timestamp with timezone]
last_updated_by: [Researcher name]
git_commit: [Current commit hash]
branch: [Current branch name]
repository: [Repository name]
tags: [research, codebase, relevant-component-names]
update_log:
  - date: [ISO timestamp]
    researcher: [name]
    description: "Initial research: [topic]"
---

# Codebase Research

## Summary
[High-level overview of documented areas. Updated as new sections are added.]

## [Topic Section 1]

### Overview
[What this area covers]

### Components
- Description of what exists ([file.ext:line](permalink))
- How it connects to other components
- Current implementation details

### Code References
- `path/to/file.tsx:123` - Description
- `another/file.ts:45-67` - Description

## [Topic Section 2]
...

## Architecture Documentation
[Cross-cutting patterns, conventions, and design implementations found in the codebase]

## Open Questions
[Areas that need further investigation — remove items as they get answered]
```

**If updating an existing document**, follow these rules:

1. **Update frontmatter**: Set `last_updated`, `last_updated_by`, `git_commit`, `branch`. Append to `update_log`.
2. **Update the Summary** to reflect any new areas covered.
3. **For existing sections with new findings**:
   - Merge new information into the existing section
   - Keep previous context that is still valid and accurate
   - Replace information that is incorrect or has changed in the codebase
   - Update code references if file paths or line numbers have shifted
   - Add a brief inline note if a significant change was made: `<!-- Updated YYYY-MM-DD: [reason] -->`
4. **For entirely new topics**: Add a new `## [Topic]` section following the same structure.
5. **Update tags** in frontmatter to include new component names.
6. **Resolve Open Questions** if the new research answers any, and add new ones if discovered.
7. **Do NOT delete sections** just because they weren't part of the current query — only modify sections relevant to the current research.

### Step 8: Add GitHub permalinks (if applicable)

- Check if on main branch or if commit is pushed: `git branch --show-current` and `git status`
- If on main/master or pushed, generate GitHub permalinks:
  - Get repo info: `gh repo view --json owner,name`
  - Create permalinks: `https://github.com/{owner}/{repo}/blob/{commit}/{file}#L{line}`
- Replace local file references with permalinks in the document

### Step 9: Present findings

- Present a concise summary of what was found and what changed in the document
- If updating, highlight what's new vs. what was already documented
- Include key file references for easy navigation
- **Return the research file path**: `{project-directory-path}/resources/codebase-research.md`
- Ask if they have follow-up questions or need clarification

### Step 10: Handle follow-up questions

- If the user has follow-up questions, repeat from Step 3
- New findings get merged into the same document following the update rules in Step 7
- The document grows organically as more research is conducted

---

## Important Notes

### Research Guidelines
- Always use parallel Task agents to maximize efficiency and minimize context usage
- Always run fresh codebase research - never rely solely on existing research documents
- Focus on finding concrete file paths and line numbers for developer reference
- The research document should be self-contained with all necessary context
- Each sub-agent prompt should be specific and focused on read-only documentation operations
- Document cross-component connections and how systems interact
- Link to GitHub when possible for permanent references
- Keep the main agent focused on synthesis, not deep file reading
- Have sub-agents document examples and usage patterns as they exist
- **CRITICAL**: You and all sub-agents are documentarians, not evaluators
- **REMEMBER**: Document what IS, not what SHOULD BE
- **NO RECOMMENDATIONS**: Only describe the current state of the codebase
- **File reading**: Always read mentioned files FULLY (no limit/offset) before spawning sub-tasks

### Single Living Document Rules
- All research lives in ONE file: `codebase-research.md`
- Always read the existing document before doing any research
- Merge new findings into existing sections — don't create parallel/duplicate sections
- Preserve valid previous context; replace only what's changed or incorrect
- Never delete sections unrelated to the current research query
- The update_log in frontmatter tracks the history of all research sessions

### Critical Ordering
- ALWAYS read existing research document first (Step 1)
- ALWAYS read mentioned files before spawning sub-tasks (Step 2)
- ALWAYS wait for all sub-agents to complete before synthesizing (Step 5)
- ALWAYS gather metadata before writing the document (Step 6 before Step 7)
- NEVER write the research document with placeholder values

### Frontmatter Consistency
- Always include frontmatter at the beginning of the research document
- Keep frontmatter fields consistent
- Update `last_updated`, `last_updated_by`, and `update_log` on every update
- Use snake_case for multi-word field names
- Tags should be relevant to the research topics and components studied