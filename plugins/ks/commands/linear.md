---
description: Interact with Linear (linear.app) — read tickets, projects, create/update issues, post comments, and more. Triggers - linear, linear.app, Linear ticket, read ticket, check project, create issue.
argument-hint: <action> [args...]
allowed-tools: Bash(linear:*), Read
---

# Linear CLI

Use the `linear` CLI (already in `$PATH`) to interact with Linear. All commands support `--json` / `-j` for machine-readable output.

> **Run unsandboxed.** The `linear` CLI needs network access to `api.linear.app`, reads `LINEAR_API_KEY` from `plugins/ks/scripts/.env`, and uses `tsx` which opens a Unix IPC pipe in `/tmp`. All three are blocked in the default Claude Code sandbox (you'll see `EPERM` on the pipe or an empty-key error). Invoke `linear ...` with `dangerouslyDisableSandbox: true`, or have the user whitelist `Bash(linear:*)` outside the sandbox.

## Quick Reference

### Issues

```bash
# Get a single issue (full details with comments)
linear issue get KAR-123 --full

# List issues with filters
linear issue list --project <project-id>
linear issue list --team KAR
linear issue list --assignee me
linear issue list --state "In Progress"
linear issue list --limit 20

# Create an issue
linear issue create --title "Fix bug" --team KAR --description "Details..." \
  --project <project-id> --assignee me --priority 2 --estimate 3

# Update an issue
linear issue update KAR-123 --state "In Progress"
linear issue update KAR-123 --assignee me --priority 1
linear issue update KAR-123 --title "New title" --description "New desc"
linear issue update KAR-123 --estimate 5
```

### Projects

```bash
# Get project from a Linear URL
linear project from-url "https://linear.app/karmasuite/project/..."

# Get project by ID or slug
linear project get <id-or-slug>

# List projects
linear project list --team KAR --limit 10

# Edit project properties (accepts ID, slug, or URL)
linear project edit <id-or-slug-or-url> --description "Short summary"
linear project edit <id-or-slug-or-url> --content "Full markdown description"
linear project edit <id-or-slug-or-url> --name "New Name" --lead me --priority 2
linear project edit <id-or-slug-or-url> --start-date 2026-03-01 --target-date 2026-06-01

# List project updates (status posts)
linear project updates <id-or-slug-or-url> --limit 5

# Create a project status update
linear project update <id-or-slug-or-url> --body "Update text" --health onTrack

# Create a project update with attachments (appended as links in the body)
linear project update <id-or-slug-or-url> --body "Sprint progress" --health onTrack \
  --attachments "Design Doc|https://..." "PR #45|https://github.com/..."
```

Health options: `onTrack`, `atRisk`, `offTrack`

Note on project updates:
- The `--body` field supports markdown. Use Linear ticket links (e.g., `[KAR-123](https://linear.app/karmasuite/issue/KAR-123)`) so Linear auto-links them in the update.
- Use `--attachments` to append linked resources to the update body. Format: `"Title|URL"` (one or more).
- Always show the user the update body and ask for confirmation before posting.

Note on project text fields:
- `--description` = short summary shown under the project title
- `--content` = full project description in markdown (the "Description" section in the UI)

### Attachments

```bash
# List attachments on an issue
linear attachment list KAR-123

# Create an attachment on an issue
linear attachment create KAR-123 --title "Design Doc" --url "https://..." \
  --subtitle "Optional subtitle"

# Update an attachment
linear attachment update <attachment-id> --title "New Title" --subtitle "Updated"

# Delete an attachment
linear attachment delete <attachment-id>
```

### Comments

```bash
# List comments on an issue
linear comment list KAR-123

# Add a comment (markdown supported)
linear comment create KAR-123 "Comment body here"
```

### Documents

```bash
# List documents (optionally by project)
linear document list --project <project-id>

# Get a specific document
linear document get <document-id>

# Create a document
linear document create --title "Doc Title" --content "Markdown content" --project <project-id>

# Update a document
linear document update <document-id> --title "New Title" --content "Updated content"

# Delete (trash) a document
linear document delete <document-id>
```

### Teams, Users, Labels, Cycles, Initiatives

```bash
# Teams
linear team list
linear team get KAR

# Users
linear user me
linear user list --team KAR

# Labels
linear label list --team KAR

# Cycles
linear cycle list --team KAR

# Initiatives / Roadmaps
linear initiative list
```

## Workflow

When the user asks to interact with Linear:

1. **Reading a ticket/issue**: Use `linear issue get KAR-XXX --full` to get complete details including comments
2. **Reading a project**: Use `linear project from-url <url>` or `linear project get <id>`, then `linear issue list --project <id>` for its issues
3. **Finding issues**: Use appropriate filters — `--assignee me`, `--state`, `--team`, `--project`
4. **Creating issues**: Always require `--title` and `--team`. Ask the user for missing details before creating
5. **Updating issues**: Use `linear issue update KAR-XXX` with the fields to change
6. **Editing projects**: Use `linear project edit <id>` with `--description` (summary) or `--content` (full description)
7. **Commenting**: Use `linear comment create KAR-XXX "body"` — supports markdown
8. **Managing documents**: Create with `linear document create`, update with `linear document update`, delete with `linear document delete`
9. **Attachments**: Use `linear attachment create KAR-XXX --title "..." --url "..."` to link resources to issues. Use `--attachments` on `linear project update` to embed links in project status updates

## Notes

- Issue identifiers use the `KAR-XXX` format
- Project IDs are UUIDs — get them from `project from-url` or `project list`
- Use `--assignee me` to filter to the current user's issues
- Use `--json` when you need to parse output programmatically or extract IDs
- Priority values: 1 = Urgent, 2 = High, 3 = Medium, 4 = Low
- All project commands accept ID, slug, or full Linear URL
