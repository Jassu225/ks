# KS Plugin

Private Claude Code plugin for KarmaSuite development workflows.

## Usage

Load the plugin when starting Claude Code:

```bash
claude --plugin-dir /path/to/plugin-dir
```

Or add an alias to your shell config (`~/.zshrc` or `~/.bashrc`):

```bash
alias claude='claude --plugin-dir /path/to/plugin-dir'
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

## Available Commands

- `/ks:hello` - Verify plugin is loaded

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
