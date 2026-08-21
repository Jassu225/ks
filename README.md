# KS Plugins

Monorepo for Claude Code plugins:

- **`ks`** — KarmaSuite development workflows: a 10-phase project lifecycle orchestrated with slash commands, agents, and Linear integration.
- **`ks-flow`** — a per-project Kanban board over your Claude Code sessions, with macOS notifications when a session blocks waiting for you. See `plugins/ks-flow/README.md`.

## Structure

```
ks/
├── .claude-plugin/
│   └── marketplace.json    # Plugin marketplace listing
├── plugins/
│   ├── ks/                 # KarmaSuite plugin
│   └── ks-flow/            # Session Kanban board + notifications
├── CLAUDE.md
└── README.md
```

## Statusline

The `ks` plugin includes a custom statusline script (`plugins/ks/scripts/statusline`) that displays the session name, context window usage, git branch, and rate limit info (5-hour and 7-day windows with reset countdowns). Color-coded: green < 50%, yellow 50-79%, red >= 80%. When the session name plus branch name exceeds 32 characters, rate limits wrap to a second line.

The session name is shown as `@<name>` — the peer-addressable name that `ListAgents` prints and `SendMessage` takes, read live from the session registry (`~/.claude/sessions/<pid>.json`), so it can be quoted directly when telling one session to message another. It is not the payload's `session_name`, which is the auto-generated conversation title.

## Adding a New Plugin

```bash
mkdir -p plugins/<name>/.claude-plugin
# Create plugins/<name>/.claude-plugin/plugin.json
mkdir plugins/<name>/commands plugins/<name>/agents
# Add entry to .claude-plugin/marketplace.json
# Load once:   claude-ks --local-plugin <name>
# Load always: add <name> to KS_EXTRA_PLUGINS in plugins/ks/scripts/.env
```
