# KS Plugin

Private Claude Code plugin for KarmaSuite development workflows.

## Setup

Run the init script to install dependencies, build CLI tools, and configure your shell:

```bash
./init
```

This will:
- Install npm dependencies in `c-scripts/`
- Build the TypeScript CLI tools
- Add a `claude-ks` alias to `~/.zshrc`
- Add `c-scripts/` to your `PATH`

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
