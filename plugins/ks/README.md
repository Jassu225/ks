# KS Plugin

Claude Code plugin for KarmaSuite development workflows. Orchestrates a 10-phase software project lifecycle using slash commands, specialized agents, and Linear integration.

## Development Setup

For plugin development, clone the repo and run `init-dev`.

```bash
cd plugins/ks
./init-dev
```

After running, restart your terminal (or `source ~/.zshrc`) and use:

```bash
claude-ks
```

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
cd plugins/ks
./init
```

This will:
- Install npm dependencies in `plugins/ks/scripts/`
- Build the TypeScript CLI tools
- Add `plugins/ks/scripts/` to your `PATH`

## Adding Components

### Commands
Add `.md` files to `commands/`. They become available as `/ks:filename`.

### Agents
Add `.md` files to `agents/`. Reference them with `subagent_type: "ks:agent-name"`.

### Hooks
Edit `hooks/hooks.json` to add event handlers.

The following scripts run automatically on Stop and SubagentStop events:
- `quality-format.sh` — Prettier formatting
- `quality-lint.sh` — ESLint validation
- `quality-typecheck.sh` — TypeScript type checking
