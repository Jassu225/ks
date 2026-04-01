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

## Statusline

The `ks` plugin includes a custom statusline script (`plugins/ks/scripts/statusline`) that displays context window usage, git branch, and rate limit info (5-hour and 7-day windows with reset countdowns). Color-coded: green < 50%, yellow 50-79%, red >= 80%. When the branch name exceeds 32 characters, rate limits wrap to a second line.

## Adding a New Plugin

```bash
mkdir -p plugins/<name>/.claude-plugin
# Create plugins/<name>/.claude-plugin/plugin.json
mkdir plugins/<name>/commands plugins/<name>/agents
# Add entry to .claude-plugin/marketplace.json
# Load with: claude-ks --local-plugin <name>
```
