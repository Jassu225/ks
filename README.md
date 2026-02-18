# KS Plugin

Private Claude Code plugin for KarmaSuite development workflows.

## Installation

Install the plugin from within Claude Code:

```
/plugin marketplace add karmasuite/ks
/plugin install ks@karmasuite-ks
```

## Setup

After installing, run the init script to install dependencies, build CLI tools, and configure your shell:

```bash
./init
```

This will:
- Install npm dependencies in `c-scripts/`
- Build the TypeScript CLI tools
- Add a `claude-ks` alias to `~/.zshrc`
- Add `c-scripts/` to your `PATH`

After running init, restart your terminal (or `source ~/.zshrc`) and use:

```bash
claude-ks
```

The `claude-ks` alias is for development purposes only — it loads the plugin directly from the local repo.

## Structure

```
ks/
├── .claude-plugin/
│   └── plugin.json      # Plugin manifest
├── commands/            # Slash commands (/ks:command-name)
│   └── hello.md
├── agents/              # Specialized subagents
│   └── example-agent.md
├── hooks/
│   └── hooks.json       # Event-driven automation
├── scripts/             # Supporting scripts for hooks
└── README.md
```

## Adding New Components

### Commands
Add `.md` files to `commands/`. They become available as `/ks:filename`.

### Agents
Add `.md` files to `agents/`. Reference them with `subagent_type: "ks:agent-name"`.

### Hooks
Edit `hooks/hooks.json` to add event handlers. Available events:
- `PreToolUse` / `PostToolUse`
- `SessionStart` / `SessionEnd`
- `UserPromptSubmit`
- etc.

The following scripts run automatically on Stop and SubagentStop events:
- `quality-format.sh` — Prettier formatting
- `quality-lint.sh` — ESLint validation
- `quality-typecheck.sh` — TypeScript type checking (can be slow; disable via `/hooks` if needed)
