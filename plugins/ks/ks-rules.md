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

## Code Quality

Do not run ESLint, Prettier, or TypeScript type checking manually — hooks handle formatting, linting, and type checking automatically on every Stop and SubagentStop event.

## Code Review

After creating a PR via `/ks:create_pr`, run `/code-review:code-review` for automated code review. The review checks for bugs, logic errors, and CLAUDE.md compliance. Only issues with 80+ confidence are posted as PR comments.

## Slack

Always use the `/ks:slack` command for any Slack-related operations. The `slack` CLI is available in `$PATH`. When a message should mention or address someone (e.g., "ask John…", "tell Sarah…"), resolve the person's name to a Slack user ID first using `slack user info <name> --json`. If the lookup fails, fall back to `slack user list --json` and find the closest match. Use `<@USER_ID>` in the message text for proper mentions. Always show the user the full message and target channel, and get explicit confirmation before sending.

## Semantic Code Analysis (Serena)

When Serena is running, **all agents must prefer Serena tools over text-based alternatives** (Grep, Glob) for symbol navigation, reference tracing, and file structure inspection. Serena produces more accurate results with fewer tokens. Fall back to text-based tools only when Serena does not cover the specific need (e.g., searching for string literals or config values). Serena provides:
- `find_symbol` — Jump to symbol definitions by name
- `find_referencing_symbols` — Trace all callers/references to a symbol
- `get_symbols_overview` — Get file structure without reading full contents

Agents fall back to text-based tools (Grep, Glob, Read) automatically when Serena is not available.
