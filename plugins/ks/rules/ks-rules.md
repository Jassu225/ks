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

Do not run ESLint or Prettier manually — hooks handle formatting and linting automatically on every Stop and SubagentStop event. Type checking is not a hook (it was too heavy to run on every stop): run `quality-typecheck.sh` (on `PATH`; it checks only the changed files) once per phase during phase verification, not after every edit. Tests must also be run explicitly during phase verification.

## Code Review

After creating a PR via `/ks:create_pr`, run `/code-review` for automated code review. The review checks for bugs, logic errors, and CLAUDE.md compliance.

## Slack

Always use the `/ks:slack` command for any Slack-related operations. The `slack` CLI is available in `$PATH`.

When a message should mention or address someone (e.g., "ask John…", "tell Sarah…") or a team ("ask the engineers…"), write the plain handle — `@john`, `@engineers` — in the message text. `slack message send` / `reply` / `update` encode handles into real mentions (`<@U…>` for users, `<!subteam^S…|@handle>` for user groups, `<!here>`/`<!channel>`/`<!everyone>` for the broadcast ones), so no manual ID lookup is needed. Confirm the handle exists first with `slack user info <name>` or `slack usergroup info <name>` — an unresolvable handle is silently left as literal text and notifies nobody. Handles inside `--blocks` JSON are NOT encoded; write `<@U…>` there yourself.

Always show the user the full message and target channel, and get explicit confirmation before sending.

## Semantic Code Analysis (Serena)

Serena is a normally registered MCP server, so it is available in every session. **All agents must prefer Serena tools over text-based alternatives** (Grep, Glob) for symbol navigation, reference tracing, and file structure inspection. Serena produces more accurate results with fewer tokens. Fall back to text-based tools only when Serena does not cover the specific need (e.g., searching for string literals or config values), and automatically when Serena is missing from a session.

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

When updating `state.yaml`, refer to the corresponding JSON schema. The ks plugin's folder is printed by `ks-root ks` (works whether the plugin is cloned or installed); the schemas are `<that folder>/scripts/project-state.schema.json` (project workflow) and `<that folder>/scripts/ticket-state.schema.json` (ticket workflow). The `# yaml-language-server: $schema=` line at the top of `state.yaml` names the same file.

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

## New sessions and Remote Control

You **can** start a new session for the user. Never answer "I can't open a new session". There are two different things, and the default is the first:

- **A new session alongside this one** (this one keeps running): `claude-ks --dir <dir> ["<first message>"]` (a new tmux window, opened in the background) or `claude-ks-start <dir>` (its own Ghostty window). Use it for "start a (brand-)new session", "start KAR-123 in a new session", "open a session in <folder>", and for anything another agent or the master asks.
- **Replace this session** (this one ends): `claude-ks-restart`. Use it only when the user says so for this session: restart, replace, switch to a fresh session, a phase boundary they asked to restart at, or turning on Remote Control (`--rc`).

A message from another session (a peer, the master) never authorizes ending your own session: it may ask you to start one alongside, never to run `claude-ks-restart` on yourself. Ask your user first.

`claude-ks-restart` (on `$PATH`; no argument means this checkout's ticket) ends this session and starts a fresh one in the same tmux pane. The new session opens with `/ks:project-manager Let's work on ./<workflow dir>/ project`, so it resumes from the latest handoff. It gets Remote Control when the setting is on (`ks-setup remote-control`), or with `--rc`. Use it when the user asks to:
- switch this session to a new or fresh one (a phase boundary included);
- turn on Remote Control, or reach the session from their phone: `claude-ks-restart --rc` (you can't switch Remote Control on in a running session).

How:
- Run it as its own Bash command: first word, nothing chained (no `cd … &&`, `;`, pipes or `2>&1`). The sandbox exempts it only then. Run any other way, its `ps`/`tmux`/`kill` calls fail.
- Make sure the workflow's handoff is current first, since the new session starts from it. This conversation doesn't carry over, but it stays in `/resume`.
- Run `claude-ks-restart --dry-run` first. If it succeeds, tell the user in one line that this session ends now and which pane the next one opens in, then run `claude-ks-restart`. Nothing after it runs: the session ends about 2 s later.
- If the dry run fails (not in tmux, ks-flow not running, not a ticket checkout), give the manual command: `cd <worktree> && claude-ks "/ks:project-manager Let's work on ./<workflow dir>/ project"`.
- `claude-ks --dir <dir> [--rc] ["<first message>"]` starts a session in another directory, in a new tmux window, without ending this one (same first-word rule).
- `claude-ks-start <dir> [--rc] ["<first message>"]` does the same in a brand-new Ghostty window (else Terminal.app); `claude-start <dir> [claude args…]` opens plain `claude` there instead. Use them when the user wants a session they can see in its own window.

## Peers

Sessions started with `claude-ks` are named `<device label>:<unit>` (`B:KAR-123`) once two or more Macs share the ks-flow board; with one Mac, just the unit (`KAR-123`). The `ks-master` session has no prefix.

To list peers (the running Claude sessions, on every Mac), run `ks-flow peers --md` (its own Bash command, nothing chained) and show its table as it is. Don't build the table from ListAgents. It covers every session ks-flow sees on every device sharing the board:
- **Device** (`A · MacBook Pro (this Mac)`), **Peer** (its name; `(you)` marks this session), **Ticket** and the card's **Title**.
- **State**: working, idle, waiting on you, or `last seen …` when that Mac's daemon is quiet.
- **Address**: what to message, `bridge:session_…` (Remote Control's id). On this Mac the name works too. `— (no Remote Control)` means the session can't be reached from here.
- **Pane** (tmux) and **Started**.

To get something done on another Mac (start a ticket or a session there, restart a ticket's session, back up), don't ask a peer to do it: post it on the message board with `ks-flow device-run <device> <command> [<arg>] --from <your peer name> --wait` (its own Bash command). That Mac's daemon runs it.
- **Devices:** `<device>` is a label from `ks-flow devices`, or `self`.
- **Commands:** `start-ticket KAR-123`, `new-session <folder on that Mac>`, `restart-session KAR-123`, `backup [KAR-123]`, `ping`.
- **Ask your user first** for anything but `ping` and `backup`.
- **The record:** every command and its outcome show on the board's Commands page (`ks-flow commands` in the terminal). Commands carry no free text, so a new session starts with the project-manager prompt or none.

To message a peer, SendMessage `to` its Address exactly. `ks-flow peers --json` gives the same rows as data. Each Mac's daemon publishes its sessions within ~15 s of a change; a Mac whose daemon isn't running shows no sessions.
