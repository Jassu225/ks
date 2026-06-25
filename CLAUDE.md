# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A monorepo for Claude Code plugins:

- **`ks`** — KarmaSuite development workflows, which orchestrate a 10-phase software project lifecycle using slash commands, specialized agents, and Linear integration.
- **`ks-flow`** — a per-project Kanban board over your Claude Code sessions (an always-on launchd daemon ingests session JSONL + workflow `state.yaml` into PocketBase/Firestore; a Next.js board renders it live), plus macOS notifications when a session blocks. Also has a per-card/per-session **reminder** system (daily re-nag, overdue red glow) and an opt-in **Notes** page (free-form + Slack-permalink notes with reminders, split Professional/Personal). Self-bootstrapping. See `plugins/ks-flow/README.md`.

## Repository Structure

```
├── .claude-plugin/marketplace.json   # Plugin marketplace listing
├── plugins/
│   └── ks/                           # KarmaSuite plugin
│       ├── .claude-plugin/plugin.json
│       ├── commands/                  # Slash commands (/ks:command-name)
│       ├── agents/                    # Specialized subagents
│       ├── hooks/hooks.json           # Quality hooks (format, lint, typecheck)
│       ├── skills/                    # Coding standards (empty, .gitkeep)
│       ├── stash/skills/              # Coding standards reference (stashed)
│       ├── scripts/                   # CLI tools and scripts
│       ├── rules/ks-rules.md         # Plugin-level rules
│       ├── init / init-dev           # Setup scripts
│       └── .config                   # Project root path
│   └── ks-flow/                      # Session Kanban board plugin
│       ├── src/                       # Ingester daemon (TypeScript)
│       ├── web/                       # Next.js board UI
│       ├── bin/ks-flow                # CLI (start/open/close/stop/status)
│       ├── scripts/bootstrap.sh       # Self-bootstrap (deps, daemon build, launchd)
│       ├── pocketbase/pb_migrations/  # Local store schema
│       └── README.md                  # Full plugin docs
├── CLAUDE.md
└── README.md
```

## Setup

- **Production**: `cd plugins/ks && ./init`
- **Development**: `cd plugins/ks && ./init-dev`

This installs dependencies, builds CLI tools, and adds `plugins/ks/scripts/` to `PATH`. Use `claude-ks` to launch Claude Code with the plugin loaded.

### Code Review

Automated code review is **built in** — run `/code-review` after creating a PR (no plugin to enable). Pass `--comment` to post findings as inline PR comments, or `--fix` to apply them.

### Optional: Serena MCP (Semantic Code Analysis)

Serena is included automatically when launching via `claude-ks-serena`. It runs only for that session — no persistent MCP registration. Additional plugins can be loaded per-launch with `--plugin <name>`, e.g. `claude-ks-serena --plugin <plugin-name>`.

To load a **local** plugin on *every* launch, list it in `KS_EXTRA_PLUGINS` (space-separated) in `plugins/ks/scripts/.env` — e.g. `KS_EXTRA_PLUGINS="ks-flow"`. Running `plugins/ks-flow/init` sets this automatically so `claude-ks` always loads ks-flow alongside ks. See `plugins/ks/scripts/README.md`.

## Build & CLI Commands

```bash
# Install dependencies
cd plugins/ks/scripts && npm install

# Build TypeScript CLI tools
cd plugins/ks/scripts && npm run build

# Run Linear CLI directly
npx tsx plugins/ks/scripts/linear-cli.ts --help
npx tsx plugins/ks/scripts/linear-cli.ts issue get KAR-123

# Initialize a project workflow from Linear
npx tsx plugins/ks/scripts/ks-start-project.ts <linear-project-url> [output-path]

# Quality checks (also run automatically via hooks)
plugins/ks/scripts/quality-format.sh
plugins/ks/scripts/quality-lint.sh
plugins/ks/scripts/quality-typecheck.sh
```

## Key Slash Commands

| Command | Purpose |
|---------|---------|
| `/ks:project-manager` | Orchestrate full 10-phase lifecycle |
| `/ks:linear` | All Linear operations (issues, projects, comments) |
| `/ks:research_codebase` | Generate living codebase research document |
| `/ks:create_plan` | Implementation planning (PLAN MODE — no code changes) |
| `/ks:implement-plan` | Execute an approved implementation plan |
| `/ks:create_pr` | Create PRs with Linear ticket references |
| `/ks:gh-cli` | GitHub CLI — view PRs, comments, reviews, CI checks |
| `/ks:create-user-stories` | Generate user stories from a PRD |
| `/ks:build-prototype` | Build React prototype from PRD |
| `/ks:write-tad` | Write Technical Architecture Document |
| `/ks:prd-to-linear-tickets` | Convert PRD into Linear tickets |
| `/code-review` | Automated PR code review (built-in) |

## Agents

Research agents are **documentarians** — they describe what exists in the codebase without suggesting improvements or identifying problems. Other agents have active roles.

| Agent | Purpose |
|-------|---------|
| `ks:codebase-locator` | Find WHERE files live (file discovery, read-only) |
| `ks:codebase-analyzer` | Explain HOW code works (implementation details, read-only) |
| `ks:codebase-pattern-finder` | Show existing patterns and usage examples (read-only) |
| `ks:code-simplifier` | Refine code for clarity (has edit access) |
| `ks:web-search-researcher` | External research via web search |

## Two Workflow Types

**Project Workflow** (all 10 phases): Full feature development from concept to implementation. Started via `ks-start-project.ts` with a `project` key in state.yaml.

**Ticket Workflow** (phases 1, 2, 9, 10 only): Quick turnaround for specific Linear tickets. Started via `ks-start-ticket.ts` with a `ticket` key in state.yaml. Skips phases 3-8 since requirements are already defined.

### Workflow Directory Layout

```
workflow/{username}/{project-slug}/
├── state.yaml              # Phase tracking (current phase, status, timestamps)
└── resources/
    ├── user-context.md     # Phase 1
    ├── codebase-research.md # Phase 2 (incrementally updatable via re-running /ks:research_codebase)
    ├── prd.md              # Phase 3 (initial) → Phase 6 (completed with product requirements)
    ├── user-stories.md     # Phase 4
    ├── prototype.md        # Phase 5
    ├── tad.md              # Phase 7
    ├── linear-tickets.md   # Phase 8
    ├── implementation-plan-01.md # Phase 9 (iteration 1, and -02, -03, etc.)
    └── handoffs/           # Between-phase documentation
```

## Code Review (built-in)

Automated PR code review that checks for bugs, logic errors, and CLAUDE.md compliance. Run `/code-review` after creating a PR via `/ks:create_pr` (no plugin needed). `--comment` posts findings as inline PR comments; `--fix` applies them.

## External Plugin Integrations

### Serena MCP (Semantic Code Analysis)

Provides LSP-powered semantic tools for symbol navigation, reference tracing, and file structure inspection. When Serena is available, agents must prefer Serena tools over text-based alternatives.

## Critical Rules

- **Linear operations**: Always use `/ks:linear` command or the `linear` CLI in `$PATH`. Never call the Linear API directly or scrape linear.app.
- **PRs**: Use `/ks:create_pr`. Must reference a Linear ticket with "Closes KAR-XXX".
- **Planning**: `/ks:create_plan` runs in PLAN MODE — no task creation, no code changes. Use `ExitPlanMode` when approved.
- **Phase 9 boundary**: Planning only. Implementation happens in Phase 10.
- **Research agents are read-only**: They document what exists. Findings must be verified in actual code.
- **Hooks run automatically**: Format, lint, and typecheck run on every Stop and SubagentStop event.

## Environment Setup

The Linear CLI requires a `LINEAR_API_KEY` in `plugins/ks/scripts/.env`:
```
LINEAR_API_KEY=lin_api_your_key_here
```

## Adding New Components

- **Commands**: Add `.md` files to `plugins/ks/commands/` → available as `/ks:filename`
- **Agents**: Add `.md` files to `plugins/ks/agents/` → reference with `subagent_type: "ks:agent-name"`
- **Hooks**: Edit `plugins/ks/hooks/hooks.json` for event-driven automation

## Adding a New Plugin

```bash
mkdir -p plugins/<name>/.claude-plugin
# Create plugin.json with name, version, description
mkdir plugins/<name>/commands plugins/<name>/agents
# Add entry to .claude-plugin/marketplace.json
# Load once:   claude-ks --local-plugin <name>
# Load always: add <name> to KS_EXTRA_PLUGINS in plugins/ks/scripts/.env
```
