# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Claude Code plugin (`ks`) for KarmaSuite development workflows. It orchestrates a 10-phase software project lifecycle — from problem statement through implementation — using slash commands, specialized agents, and Linear integration.

## Setup

- **Production**: Run `./init` to install dependencies, build CLI tools, and add `c-scripts/` to `PATH`.
- **Development**: Run `./init-dev` to do everything `init` does plus add a `claude-ks` alias to `~/.zshrc`. Use `claude-ks` to launch Claude Code with the plugin loaded from the local repo.

## Plugin Structure

- **`.claude-plugin/plugin.json`** — Plugin manifest
- **`commands/`** — Slash commands (available as `/ks:command-name`)
- **`agents/`** — Specialized subagents for code analysis
- **`c-scripts/`** — TypeScript CLI tools (Linear API, project init, quality checks)
- **`hooks/hooks.json`** — Automatic code quality hooks (format, lint, typecheck on Stop/SubagentStop)
- **`project-manager/`** — Phase documentation files (01 through 10)
- **`skills/`** — Reusable coding standards reference (TS, React, backend, Postgres patterns)
- **`ks-rules.md`** — Plugin-level rules loaded into every session

## Build & CLI Commands

```bash
# Install c-scripts dependencies
cd c-scripts && npm install

# Build TypeScript CLI tools
cd c-scripts && npm run build

# Run Linear CLI directly
npx tsx c-scripts/linear-cli.ts --help
npx tsx c-scripts/linear-cli.ts issue get KAR-123
npx tsx c-scripts/linear-cli.ts project list

# Initialize a project workflow from Linear
npx tsx c-scripts/ks-start-project.ts <linear-project-url> [output-path]

# Quality checks (also run automatically via hooks)
c-scripts/quality-format.sh
c-scripts/quality-lint.sh
c-scripts/quality-typecheck.sh
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
| `/ks:prd` | Generate PRD with user stories |
| `/ks:build-prototype` | Build React prototype from PRD |
| `/ks:write-tad` | Write Technical Architecture Document |
| `/ks:prd-to-linear-tickets` | Convert PRD into Linear tickets |

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

## Critical Rules

- **Linear operations**: Always use `/ks:linear` command or the `linear` CLI in `$PATH`. Never call the Linear API directly or scrape linear.app.
- **PRs**: Use `/ks:create_pr`. Must reference a Linear ticket with "Closes KAR-XXX".
- **Planning**: `/ks:create_plan` runs in PLAN MODE — no task creation, no code changes. Use `ExitPlanMode` when approved.
- **Phase 9 boundary**: Planning only. Implementation happens in Phase 10.
- **Research agents are read-only**: They document what exists. Findings must be verified in actual code.
- **Hooks run automatically**: Format, lint, and typecheck run on every Stop and SubagentStop event.

## Environment Setup

The Linear CLI requires a `LINEAR_API_KEY` in `c-scripts/.env`:
```
LINEAR_API_KEY=lin_api_your_key_here
```

## Adding New Components

- **Commands**: Add `.md` files to `commands/` → available as `/ks:filename`
- **Agents**: Add `.md` files to `agents/` → reference with `subagent_type: "ks:agent-name"`
- **Hooks**: Edit `hooks/hooks.json` for event-driven automation
