# KarmaSuite Plugin Rules

## Linear Operations

Always use the `/ks:linear` command for any Linear-related operations:
- Reading tickets/issues (e.g., KAR-XXX)
- Listing project issues or checking project status
- Creating or updating issues
- Posting comments on tickets
- Fetching project updates
- Looking up teams, users, labels, cycles, or initiatives

The `linear` CLI is available in `$PATH`. Do not use the Linear API directly or web-scrape linear.app — use the CLI.

## Pull Requests

Use the `/ks:create_pr` command to create PRs. PRs must reference a Linear ticket (KAR-XXX) in the "Closes" section.

## Codebase Research

Use the `/ks:research_codebase` command for documenting and understanding existing code. Research agents are documentarians — they describe what exists, not what should change.

## Planning

Use the `/ks:create_plan` command for implementation planning. Plans should be approved before writing code.
