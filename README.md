# KS Plugin

Private Claude Code plugin for KarmaSuite development workflows.

## Production Setup

Install the plugin from within Claude Code:

```
# Add marketplace
/plugin marketplace add karmasuite/ks

# Install the plugin
/plugin install ks@karmasuite
```

Then run the init script to install dependencies, build CLI tools, and configure your shell:

```bash
./init
```

This will:
- Install npm dependencies in `c-scripts/`
- Build the TypeScript CLI tools
- Add `c-scripts/` to your `PATH`

## Development Setup

For plugin development, clone the repo and run `init-dev`. This does everything `init` does plus adds a `claude-ks` alias to `~/.zshrc` that loads the plugin directly from the local repo:

```bash
./init-dev
```

After running, restart your terminal (or `source ~/.zshrc`) and use:

```bash
claude-ks
```

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

## Recommended CLAUDE.md Instructions

For better workflow results during long-running sessions, copy the contents of [`COMPACT-INSTRUCTIONS.md`](COMPACT-INSTRUCTIONS.md) into your project's `CLAUDE.md` file. These rules help the agent maintain reliable behavior when context compression occurs during multi-phase workflows.
