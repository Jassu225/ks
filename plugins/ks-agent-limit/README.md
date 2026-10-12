# ks-agent-limit

Caps how many Claude sessions and agents run at once on this machine. Every open session holds a slot, idle or not, and so does every live agent: subagents, teammates, forks and workflow agents. The default limit is 8. When a spawn would go past it, the plugin refuses the spawn and tells you, and the model waits and tries again.

## How it counts

- **Sessions:** this session, plus the other local sessions `ListAgents` reports (cloud and Remote Control sessions run elsewhere, so they don't count). Sessions started without this plugin count too.
- **Agents:** each ks-agent-limit session writes a heartbeat file, `~/.claude/ks-agent-limit/<session-id>.json`, every 15s. The file holds the session's live agents: the rows of `$.agent.list()`, its workflow agents (which that list never shows) and spawns in flight. The gate adds up every file younger than 60s. When a session ends, its file is marked ended. A crashed session's file stops counting once it is 60s old.
- A session started **without** the plugin still counts as one session, but its agents can't be seen and it isn't gated.

## What happens at the limit

The `agent.spawn` hook works in three steps:
1. It reserves a slot and publishes the reservation, so another session's gate counts it.
2. It counts everything.
3. If the total is over the limit, it releases the reservation and refuses the spawn. Nothing starts. You get:
   - a toast: `Agent blocked: 8/8 slots in use (3 sessions, 5 agents). Claude will check again in 3 min.`
   - a status line: `⏳ agent slots full 8/8`. It clears on the next heartbeat that finds a free slot.
   - The model reads the reason and is told to tell you it's waiting. It then waits with a background `sleep 180`, calls `mcp__ks-agent-limit__capacity` and starts at most `free` agents.

A hook can't hold a spawn for minutes (each hook gets a 10s budget), so the model does the waiting.

The `mcp__ks-agent-limit__capacity` tool returns `{ limit, sessions, agents, used, free }`. Call it before starting several agents.

## Options

| Option | Default | Meaning |
|---|---|---|
| `max_parallel` | 8 | Slots on this machine |
| `retry_minutes` | 3 | How long a refused spawn tells the model to wait |

`KS_AGENT_LIMIT_DIR` overrides the heartbeat folder.

## Loading

Once: `claude-ks --local-plugin ks-agent-limit`. Always: add `ks-agent-limit` to `KS_EXTRA_PLUGINS` in `plugins/ks/scripts/.env`. Every session that should be gated must load the plugin.

## Limits

- Two sessions spawning in the same instant can both see the other's reservation and both refuse. Both then retry later, so neither takes the last slot twice.
- A teammate running in its own terminal pane may count twice: once as an agent here and once as a peer session in `ListAgents`.
- The plugin calls `ListAgents` through `$.tool.call`, which goes through the permission check. If that call is refused, it counts sessions from the heartbeat files alone.

## Develop

```bash
claude plugin validate plugins/ks-agent-limit
claude plugin test plugins/ks-agent-limit
```
