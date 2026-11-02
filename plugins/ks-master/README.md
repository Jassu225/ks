# ks-master

The master session behind ks-flow's **Briefing**: one long-lived Claude session
that reads Slack every six hours and puts everything that needs Jaswanth on the
ks-flow board with a due time, runs the day's log-in and log-off, and restarts
itself before its context fills up. The design and every file format are in
[`plugins/ks-flow/docs/briefing.md`](../ks-flow/docs/briefing.md); this README
covers the plugin.

Loaded **only** by `claude-ks-master` (`plugins/ks/scripts/`). Don't add it to
`KS_EXTRA_PLUGINS`: without the launcher's environment its mod does nothing,
and its skills only make sense in the master.

## What's in it

| Path | What |
|---|---|
| `hooks/register.ts` | The wake-up mod (below) |
| `hooks/master.ts` | Its logic without `$` (request order, ownership, defaults), tested in `master.test.ts` |
| `instructions.md` | The master instructions, with this launch's paths filled in, attached by the mod as hidden `prompt.submit` context to the conversation's first prompt and to every wake-up. Not `prompt.compose`: on Team/Enterprise accounts Claude Code's built-in guard `cc-plugin-sec-default` sends that event past user-tier plugins ("its prompt.compose hook was skipped") |
| `<master-dir>/mod.log` | One line per wake-up the mod submits, then `ran` (a slash command, through `$.command.run`: Claude Code refuses a plugin's `$.prompt.submit` that starts with `/`), `entered`, `dropped: <reason>` or `failed: <reason>` (the last two also written as `done/<request>.dropped`) |
| `skills/start` | `/ks-master:start`: every new master's first message. Reads the newest master handoff (none = first master), finishes what it left half done, reports in two lines. Never resumes a ticket or project workflow |
| `skills/briefing` | `/ks-master:briefing <trigger> [slot]`: one Slack pass. The master opens and closes the run; a subagent reads Slack and writes the items |
| `skills/log-in` | `/ks-master:log-in`: catch-up pass, overdue/hot/promises, session roll call, the day's plan, saved to the daily log |
| `skills/log-off` | `/ks-master:log-off`: last pass, archived/open/slipped, promises due tomorrow, roll call with suggestions, time from `ks-time`, a walk through open items (archive or keep: he archives on the board), daily log, restart |
| `skills/restart` | `/ks-master:restart <reason>`: handoff into the master handoffs folder, then `claude-ks-rc-restart --master --handoff <file>` |

## Starting and restarting

- `claude-ks-master` — in this terminal. `--detached` — always in the tmux
  session `ks-master` (a new window there when it exists, else that session
  created), not attached; it opens the viewer (`plugins/ks/scripts/ks-master-view`, a self-reattaching `tmux attach -t ks-master` in Ghostty, else Terminal.app) when none is open, so one window always shows the master; what the ks-flow daemon runs when no master is alive. `--pane <id>`
  — in that pane. `--dry-run` — print, start nothing.
- `claude-ks-rc-restart --master [--handoff <file>] [--force] [--dry-run]` —
  replace the running master in its pane. A graceful restart needs a handoff
  written since the master started (`--handoff` records it); `--force` skips
  that (the daemon's hard restart).
- Neither starts a second master: while `session.json` has no pid yet, both
  find the process by session id in `~/.claude/sessions/*.json`, and one
  under 3 minutes old with no process yet counts as still starting (refused,
  exit 1).

See `plugins/ks/scripts/README.md`, "ks-flow master".

The launcher runs `claude-ks --local-plugin ks-master` (this folder, so edits
hot-reload; no `claude plugin install` needed) in the karmasuite main checkout
(`KS_PROJECT_ROOT_PATH` from `plugins/ks/.config`), with Remote Control on
(name `ks-master`), a fresh `--session-id`, and the first message "Let's resume
working on this project". It exports:

| Variable | Value |
|---|---|
| `KS_MASTER_DIR` | `<ks-flow data dir>/master` — the data dir from `plugins/ks-flow/src/lib/datadir.mjs` (honours `KS_FLOW_DATA`) |
| `KS_MASTER_HANDOFFS` | `<project>/workflow/<user>/ks-master/handoffs` — `<user>` is `KS_MASTER_USER`, else the only folder under `workflow/`, else `id -un` |

The mod reads the data dir from `KS_MASTER_DIR` rather than resolving it again
(a mod can't import `datadir.mjs` or run git cheaply); the launcher resolved it
with ks-flow's own resolver, so they agree.

## The wake-up mod

All under `$KS_MASTER_DIR`:

- **session.json** — written by the launcher (`pid: null`). The mod finds its
  own pid in `~/.claude/sessions/<pid>.json` (matched by session id; after three
  misses, `$PPID` of a child process) and writes it in. It only touches the
  file while it is the master the file names: same session id, or same pid
  (after `/clear` changes the id, it writes the new id). An old master still
  shutting down while a new one starts is neither, so it stops writing the
  heartbeat and taking requests.
- **heartbeat.json** — `{ sessionId, at, busy }` every 30 s, and at the start
  and end of every main-loop turn.
- **requests/** — checked every 15 s. When the session is idle, the oldest file
  (`<iso>-<trigger>.json` sorts by time) is moved to `done/` with `mv` — the
  claim — and its `prompt` submitted with `$.prompt.submit`. A later request
  with the same trigger and any unreadable file are moved to `done/` without
  being submitted. A request with no `prompt` gets its trigger's default:
  `schedule` → `/ks-master:briefing schedule <slot>`, `button` →
  `/ks-master:briefing button`, `restart` → `/ks-master:restart requested from
  the board`.
- **Context** — after each turn the mod reads `$.session.usage().context.percent`;
  past 70 % it submits `/ks-master:restart context N%` once, when idle.

**Idle vs busy.** The mod API has no "is a turn running" call. The mod counts
it from `turn.start` / `turn.complete` on the main loop (no `agentId`): a turn
runs from the prompt to the final answer, tool calls and permission prompts
included, so `busy` covers all of it. Background subagents don't count. A mod
reload (only at a turn's end) starts it at idle.

**Does `$.prompt.submit` queue?** Yes: the API documents a plugin's prompt as
"a turn of its own, once the session is idle" — it never interrupts a running
turn, and its promise resolves once the turn started or was queued. The mod
still waits for idle before taking a request, so a request stays in
`requests/` (where the daemon's stuck check sees it) until it really runs.

## Sandbox

In the karmasuite project's sandbox, `ks-flow`, `slack`, `ks-time` and
`claude-ks-rc-restart` must be excluded first-word commands (`"ks-flow *"`,
`"claude-ks-rc-restart *"`, …), and PocketBase on 127.0.0.1 reachable.

## Checks

```bash
claude plugin validate plugins/ks-master
claude plugin test plugins/ks-master
```
