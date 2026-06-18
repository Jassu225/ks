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

Do not run ESLint, Prettier, or TypeScript type checking manually — hooks handle formatting, linting, and type checking automatically on every Stop and SubagentStop event. The orchestrator (`/ks:implement-plan`) relies on these hooks rather than running formatting or linting explicitly. Tests must still be run explicitly during phase verification since hooks do not cover test execution.

## Code Review

After creating a PR via `/ks:create_pr`, run `/code-review` for automated code review. The review checks for bugs, logic errors, and CLAUDE.md compliance.

## Slack

Always use the `/ks:slack` command for any Slack-related operations. The `slack` CLI is available in `$PATH`. When a message should mention or address someone (e.g., "ask John…", "tell Sarah…"), resolve the person's name to a Slack user ID first using `slack user info <name> --json`. If the lookup fails, fall back to `slack user list --json` and find the closest match. Use `<@USER_ID>` in the message text for proper mentions. Always show the user the full message and target channel, and get explicit confirmation before sending.

## Semantic Code Analysis (Serena)

When Serena is running, **all agents must prefer Serena tools over text-based alternatives** (Grep, Glob) for symbol navigation, reference tracing, and file structure inspection. Serena produces more accurate results with fewer tokens. Fall back to text-based tools only when Serena does not cover the specific need (e.g., searching for string literals or config values). Agents fall back to text-based tools automatically when Serena is not available.

### Tools
- `find_symbol` — Jump to symbol definitions by name (functions, classes, types, variables, components)
- `find_referencing_symbols` — Trace all callers, importers, and references to a symbol
- `get_symbols_overview` — Get top-level symbols defined in a file without reading full contents

### When to use Serena vs text-based tools
- **Symbol** (function, class, type, variable, component, hook) → use Serena
- **String literal**, comment, config value, file path pattern → use Grep/Glob
- Serena returns an error or empty results → fall back to Grep/Glob

## Code Simplifier Agent

When running the `ks:code-simplifier` agent, always read its agent definition file first and include ALL of its simplification rules explicitly in the prompt. Do not rely on the agent to pick up these rules on its own — enumerate every rule from the definition so nothing gets missed.

## Workflow State Files

When updating `state.yaml`, refer to the corresponding JSON schema. To locate them, read the `$KS_PLUGIN_DIR` environment variable (run `echo $KS_PLUGIN_DIR` via Bash), then find the schemas at `$KS_PLUGIN_DIR/scripts/project-state.schema.json` (project workflow) or `$KS_PLUGIN_DIR/scripts/ticket-state.schema.json` (ticket workflow).

## KarmaSuite Conventions

### General Rules
- Prisma: Alphabetically ordered attributes, `@map("snake_case")`
- TypeScript: Use dictionaries over arrays for lookups
- React: Use `FC<PropsWithChildren<...>>` for components
- Prefer `packages/react-components` over legacy `components`
- Use `MathUtils.sum()` for calculations
- Never import from client into server or vice versa
- Testing: Vitest with proper database setup

## Slack Templates
- When a Slack template specifies a channel, ALWAYS use that channel. Never offer alternative channels as options. Just confirm the message content and send to the template's channel.

### For Database Changes
1. Update Prisma schema (alphabetically ordered, @map annotations)
2. Run migration: `cd packages/prisma && pnpm migrate:dev`
3. Update related TypeScript types
4. Add/update tRPC procedures
5. Test with: `cd packages/prisma && pnpm migrate:reset:test`

### For Database Views
When creating a new view or modifying an existing one, **do not edit `database_views.sql` directly**. Instead:
1. Create a new Prisma migration manually — `mkdir` a new timestamped directory under `packages/prisma/prisma/migrations/` (e.g., `20260317120000_update_portfolio_summary_view`)
2. Write the updated `CREATE OR REPLACE VIEW` SQL in the new migration's `migration.sql`
3. This ensures the change is tracked as a migration and applied in order during deployments

### For Engine/Business Logic
1. Locate in `packages/engines/src/`
2. Follow existing patterns (e.g., getEngine.ts for allocations)
3. Use `MathUtils.sum()` for calculations
4. Write unit tests with Vitest
5. Consider atomic transactions for DB operations

### For UI Components
1. Prefer `packages/react-components` (Tailwind + Radix)
2. Use shared hooks from `packages/react-hooks`
3. Use icons from `packages/react-icons`
4. Follow TailwindCSS config from `packages/tailwind-config`
5. Handle tRPC errors with onError callbacks

### For GL Integrations
1. Check `packages/general-ledger-external`
2. Follow patterns for QB/NetSuite/Sage
3. Consider sync implications
4. Test with actual GL data structures

### For API Endpoints
1. tRPC procedures in `apps/www/src/server/api/routers/`
2. Proper error handling
3. Input validation with Zod
4. Consider permissions/auth

### For Background Jobs
1. Inngest functions in `apps/www/src/inngest/`
2. Consider retry logic
3. Monitor execution
