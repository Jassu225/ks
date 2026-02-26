# KS Plugins

Monorepo for Claude Code plugins. Currently contains the `ks` plugin for KarmaSuite development workflows.

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

## Development Setup

For plugin development, clone the repo and run `init-dev`. This does everything `init` does plus sets `DEV=true`:

```bash
cd plugins/ks
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
│   └── marketplace.json    # Plugin marketplace listing
├── plugins/
│   └── ks/                 # KarmaSuite plugin
│       ├── .claude-plugin/
│       │   └── plugin.json # Plugin manifest
│       ├── commands/        # Slash commands (/ks:command-name)
│       ├── agents/          # Specialized subagents
│       ├── hooks/
│       │   └── hooks.json   # Event-driven automation
│       ├── skills/          # Coding standards reference
│       ├── project-manager/ # 10-phase workflow docs
│       ├── scripts/         # CLI tools and scripts
│       ├── init / init-dev  # Setup scripts
│       └── ks-rules.md     # Plugin-level rules
├── CLAUDE.md
└── README.md
```

## Adding New Components

### Commands
Add `.md` files to `plugins/ks/commands/`. They become available as `/ks:filename`.

### Agents
Add `.md` files to `plugins/ks/agents/`. Reference them with `subagent_type: "ks:agent-name"`.

### Hooks
Edit `plugins/ks/hooks/hooks.json` to add event handlers.

The following scripts run automatically on Stop and SubagentStop events:
- `quality-format.sh` — Prettier formatting
- `quality-lint.sh` — ESLint validation
- `quality-typecheck.sh` — TypeScript type checking

## Adding a New Plugin

```bash
mkdir -p plugins/<name>/.claude-plugin
# Create plugins/<name>/.claude-plugin/plugin.json
mkdir plugins/<name>/commands plugins/<name>/agents
# Add entry to .claude-plugin/marketplace.json
# Load with: claude-ks --local-plugin <name>
```
