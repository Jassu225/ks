# KS Plugins

Monorepo for Claude Code plugins. Currently contains the `ks` plugin for KarmaSuite development workflows.

## Structure

```
ks/
├── .claude-plugin/
│   └── marketplace.json    # Plugin marketplace listing
├── plugins/
│   └── ks/                 # KarmaSuite plugin
├── CLAUDE.md
└── README.md
```

## Adding a New Plugin

```bash
mkdir -p plugins/<name>/.claude-plugin
# Create plugins/<name>/.claude-plugin/plugin.json
mkdir plugins/<name>/commands plugins/<name>/agents
# Add entry to .claude-plugin/marketplace.json
# Load with: claude-ks --local-plugin <name>
```
