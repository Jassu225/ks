# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A monorepo for Claude Code plugins. Currently contains the `ks` plugin for KarmaSuite development workflows, which orchestrates a 10-phase software project lifecycle using slash commands, specialized agents, and Linear integration.

## Repository Structure

```
├── .claude-plugin/marketplace.json   # Plugin marketplace listing
├── plugins/
│   └── ks/                           # KarmaSuite plugin
│       ├── .claude-plugin/plugin.json
│       ├── commands/                  # Slash commands (/ks:command-name)
│       ├── agents/                    # Specialized subagents
│       ├── hooks/hooks.json           # Quality hooks (format, lint, typecheck)
│       ├── skills/                    # Coding standards reference
│       ├── project-manager/           # 10-phase documentation
│       ├── scripts/                   # CLI tools and scripts
│       ├── ks-rules.md               # Plugin-level rules
│       ├── init / init-dev           # Setup scripts
│       └── .config                   # Project root path
├── CLAUDE.md
└── README.md
```

## Setup

- **Production**: `cd plugins/ks && ./init`
- **Development**: `cd plugins/ks && ./init-dev`

This installs dependencies, builds CLI tools, and adds `plugins/ks/scripts/` to `PATH`. Use `claude-ks` to launch Claude Code with the plugin loaded.

### Optional: Code Review Plugin

Enable automated code review for PRs:
1. Open `~/.claude/settings.json`
2. Move `code-review@claude-plugins-official` from `disabledPlugins` to `enabledPlugins`

### Optional: Serena MCP (Semantic Code Analysis)

Serena is included automatically when launching via `claude-ks-serena`. It runs only for that session — no persistent MCP registration. Additional plugins can be loaded with `--plugin <name>`, e.g. `claude-ks-serena --plugin code-review@claude-plugins-official`.

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
| `/ks:prd` | Generate PRD with user stories |
| `/ks:build-prototype` | Build React prototype from PRD |
| `/ks:write-tad` | Write Technical Architecture Document |
| `/ks:prd-to-linear-tickets` | Convert PRD into Linear tickets |
| `/code-review:code-review` | Automated PR code review (requires plugin) |

## Agents

All agents are **documentarians** — they describe what exists in the codebase without suggesting improvements or identifying problems.

| Agent | Purpose |
|-------|---------|
| `ks:codebase-locator` | Find WHERE files live (file discovery) |
| `ks:codebase-analyzer` | Explain HOW code works (implementation details) |
| `ks:codebase-pattern-finder` | Show existing patterns and usage examples |
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
    ├── codebase-research.md # Phase 2 (living document)
    ├── prd.md              # Phase 3
    ├── user-stories.md     # Phase 4
    ├── prototype.md        # Phase 5
    ├── product-requirements.md # Phase 6
    ├── tad.md              # Phase 7
    ├── linear-tickets.md   # Phase 8
    ├── implementation-plan.md # Phase 9
    └── handoffs/           # Between-phase documentation
```

## External Plugin Integrations

### Code Review (`code-review@claude-plugins-official`)

Automated PR code review that checks for bugs, logic errors, and CLAUDE.md compliance. Run `/code-review:code-review` after creating a PR via `/ks:create_pr`. Only issues with 80+ confidence are posted as comments.

### Serena MCP (Semantic Code Analysis)

Provides LSP-powered semantic tools (`find_symbol`, `find_referencing_symbols`, `get_symbols_overview`) to the research agents (codebase-locator, codebase-analyzer, codebase-pattern-finder). Replaces noisy text-based grep for symbol navigation and import-tracing. Agents fall back to Grep/Glob/Read automatically when Serena is not running.

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
# Load with: claude-ks --local-plugin <name>
```
