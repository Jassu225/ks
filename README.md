# KS Plugins

Monorepo for Claude Code plugins:

- **`ks`** — KarmaSuite development workflows: a 10-phase project lifecycle orchestrated with slash commands, agents, and Linear integration.
- **`ks-flow`** — a per-project Kanban board over your Claude Code sessions, with macOS notifications when a session blocks waiting for you. One board can span several devices on a shared Firestore store: each card belongs to one device, settings are shared, the master runs on the device you choose. See `plugins/ks-flow/README.md` ("Brand-new setup", "Several devices").
- **`ks-master`** — the master session (Briefing over Slack, log-in / log-off); on demand, started by `claude-ks-master`, on the one device chosen in ks-flow's Settings → Devices.
- **`ks-browser`** — browser testing and test videos; on demand, started by `claude-ks-test`.
- **`ks-suite`** — a dependencies-only bundle: installs `ks` and `ks-flow`.
- **`ks-agent-limit`** — disabled, not maintained (kept in the repo).

## Setup

Two ways in, one end state (checked by `ks-setup doctor`).

**Install** (standard Claude Code plugins), **per project**, from inside your
KarmaSuite checkout:

```bash
cd <your KarmaSuite checkout>
claude plugin marketplace add <path or URL of this repo>
claude plugin install --scope local ks-suite@karmasuite      # ks + ks-flow (dependencies)
claude plugin install --scope local ks-master@karmasuite     # optional, on demand
claude plugin install --scope local ks-browser@karmasuite    # optional, on demand
```

Then, in Claude: `/ks:setup`.

`--scope local` switches the plugins on only for that checkout, in its own
gitignored `.claude/settings.local.json`; other repos don't load them, and
nothing is committed. A worktree reads its own copy of that file:
`create-worktree` copies it into new worktrees, and `ks-setup apply` adds the
plugin switches to existing ones. Tokens and other KS settings never go there
(Keychain and `~/.config/ks`).

**Development** (a clone, edits live):

```bash
git clone <this repo> && plugins/ks/init-dev
```

`init-dev` loads the clone as the `karmasuite` directory marketplace, installed
the same per-project way (Claude reads the plugins in place; edits apply on
`/reload-plugins`), installs the CLI dependencies, and runs the same `ks-setup`
steps as `/ks:setup`.

After either, a plain `claude` — and the desktop app and IDEs — gets the
plugins, the KS rules (SessionStart context), a task list per worktree
(`.claude/settings.local.json`) and the tokens. `claude-ks` is deprecated.

### How config and secrets work

| What | Where | Read by |
|---|---|---|
| Tokens (Linear, Slack, Grain, backup key) | macOS Keychain, service `ks.<tool>` | the CLIs, the ks-flow daemon and board |
| Plain settings (project path, …) | `~/.config/ks/<tool>.env` | the same, plus hooks and launchers |
| ks-flow store settings | `<ks-flow data dir>/.env` (per project) | ks-flow |
| Plugin folders | `~/.config/ks/plugins.json` (each plugin's SessionStart records itself) | `ks-root`, the `~/.local/bin` shims, ks-flow |

`ks-config` (and the `/ks:config` skill) reads and changes them; tokens are
typed with hidden input (`ks-config secret linear.LINEAR_API_KEY`), never in
chat. Lookup order: real env, then the store, then the old
`plugins/ks/scripts/.env` / `plugins/ks/.config` (until `ks-config import-legacy`).

Why not Claude Code's `userConfig`: its values reach hooks, MCP servers and
skill text, but not commands run through Bash, the launchd daemon or the
terminal. Once a CLI becomes its own plugin with an MCP server, its token can
move to a `sensitive` `userConfig` value.

## Statusline

**Optional, turned on by setup.** `/ks:setup` (and `ks-setup apply`) suggests it, and Claude runs `ks-setup statusline --yes` once you agree: it sets `statusLine` to `~/.local/bin/statusline` (a shim to the plugin's script, so it follows plugin updates) in the KarmaSuite checkout's own `.claude/settings.local.json` and its worktrees' copies. Only that checkout uses it: a status line of your own in `~/.claude/settings.json` stays for every other folder. `ks-setup doctor` reports it (`statusline:project`, info).

The `ks` plugin includes a custom statusline script (`plugins/ks/scripts/statusline`) that displays the session name, context window usage, git branch, and rate limit info (5-hour and 7-day windows with reset countdowns). Color-coded: green < 50%, yellow 50-79%, red >= 80%. When the session name plus branch name exceeds 32 characters, rate limits wrap to a second line.

The session name is shown as `@<name>` — the peer-addressable name that `ListAgents` prints and `SendMessage` takes, read live from the session registry (`~/.claude/sessions/<pid>.json`), so it can be quoted directly when telling one session to message another. It is not the payload's `session_name`, which is the auto-generated conversation title.

When the checkout belongs to a ks workflow, the line also shows the Linear ticket (`KAR-123`) or `project` as a clickable OSC 8 link to Linear. The owning `state.yaml` is the one under `workflow/` whose `worktree_dir` is this checkout's git root. Older ticket states that predate `worktree_dir` are found by the ticket id in the branch name (`workflow/*/tickets/<id>/state.yaml`). Terminals without OSC 8 support show plain text.

When `KS_MOD_STATUSLINE=1` (set in `~/.claude/settings.json` env by `ks-setup claude-settings`, and by the launchers) the statusline is split: this script prints only the static half (session name, context, branch), and the ks plugin draws the interactive half, the ticket and current phase as pills, `≡ more` and the rate limits, in the prompt's hint line (see `plugins/ks/README.md`, "Statusline"). Plain `claude` sessions keep this script's full output.

## Adding a New Plugin

```bash
mkdir -p plugins/<name>/.claude-plugin
# Create plugins/<name>/.claude-plugin/plugin.json
mkdir plugins/<name>/commands plugins/<name>/agents
# Add entry to .claude-plugin/marketplace.json
# Declare "dependencies": ["ks"] when it needs the ks plugin
# Dev: /reload-plugins picks it up (the clone is a directory marketplace)
# Then: claude plugin install <name>@karmasuite
```
