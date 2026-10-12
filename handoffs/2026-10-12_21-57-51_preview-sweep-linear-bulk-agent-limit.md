---
date: 2026-10-12T21:57:51+05:30
git_commit: c7bb096
branch: main
task: One Vercel call per pane poll for every PR preview; Linear issue list sort fix and issue bulk-update; new ks-agent-limit plugin (machine-wide session + agent cap)
---

# Handoff: Preview sweep, Linear bulk-update, ks-agent-limit

> See CLAUDE.md for dev guidance, plugins/ks/README.md ("Project pane") for previews, plugins/ks-agent-limit/README.md for the cap.

## What Happened

### 1. Vercel previews: one call per poll (`d4f327c`)
The user confirmed per-PR previews work live, then asked for a single poll for any number of PRs. The Vercel MCP `list_deployments` has no multi-branch filter, so `loadPreviews` (`plugins/ks/hooks/register.tsx`) now seeds and then sweeps:
- **Seed:** a branch seen for the first time gets one `{branch, limit: 1}` call.
- **Sweep:** afterwards, every poll makes one call, `{since, limit: 20}`. `since` is the last sweep minus 60s of skew, or the oldest running build if that is earlier. A newer deploy replaces a branch's entry.
- **Full page:** if a sweep returns a full page (20), the known branches are seeded again, because the page may have missed some.
- **Resets:** branches that leave the PR set are dropped. `forgetPreviews` clears everything when the unit changes or a call is refused.
- **Vercel helpers:** `vercel.ts` gained `listedDeployments` and exports `Deployment`.
- **Test:** `live.test.ts` has a test for 3 branches; 27/27 pass.
- **Scheduler:** confirmed it is already one 5s tick that runs each job from its stored `lastRun`; no change.

### 2. Linear CLI (`5f001fc`), requested by peer session karmasuite-58
- **Sort fix:** `issue list --sort manual --limit N` applied the limit before sorting. Linear now sorts server-side through `client.issues({ sort })` (`scripts/lib/issue-sort.ts`, plus a spec). The live result matched the peer's expected order.
- **`issue bulk-update <ids...>`:** sends one `issueBatchUpdate` (`client.updateIssueBatch`) request. Flags: `--state`, `--assignee`, `--priority`, `--cycle`, `--dry-run`, `--json`.
  - Never sends `sortOrder`.
  - Refuses more than 50 ids rather than splitting them up. The 50 cap comes from a third-party source and is unverified.
  - `--cycle` and `--state` need every id to belong to one team.
- **Not run on real tickets**, as the peer asked. They run the move themselves. The syntax was sent back to them.

### 3. `ks-agent-limit` plugin (`c7bb096`)
The user asked for a cap: every open session and every live agent (subagent, teammate, workflow agent, fork) holds a slot, 8 by default. Before starting agents, a session can check how many it may start. With no free slot, it re-checks every 3 minutes. Their choices: count every open session; count any live agent; deny and let the model retry; build it as a separate plugin in this repo.
- **`hooks/register.ts`:** the `agent.spawn` gate.
  - It reserves a slot, publishes the reservation, then counts.
  - Over the limit, it releases the reservation and returns `{deny}`. It also tells the user, as they asked mid-build: a 15s toast (`Agent blocked: 8/8 slots in use …`) and a status line (`⏳ agent slots full 8/8`) that the heartbeat clears.
  - The deny text tells the model to say it is waiting, run a background `sleep 180`, then call `mcp__ks-agent-limit__capacity` and start at most `free` agents.
- **`mcp__ks-agent-limit__capacity`:** returns `{limit, sessions, agents, used, free}`.
- **Counting across sessions:**
  - Each session writes `~/.claude/ks-agent-limit/<session>.json` every 15s. The file is ignored once stale (60s) and marked ended at `session.end`.
  - Peer sessions are counted through `ListAgents`, skipping cloud and Remote Control rows. The count is the larger of that and the number of live files.
  - Workflow agents are tracked from spawn to `turn.complete`, because `$.agent.list()` never shows them.
- **`hooks/capacity.ts`:** the pure counting logic. `capacity.test.ts` holds 6 tests, all passing.
- **Options** (`userConfig`): `max_parallel` (8) and `retry_minutes` (3). `KS_AGENT_LIMIT_DIR` overrides the folder.
- **Name:** first built as `ks-slots`. The user picked `ks-agent-limit` from a shortlist; the model's tool `slots` became `capacity`.

## Key Decisions Made
- **The model waits, not the hook:** a hook gets a 10s budget, so it can't hold a spawn for 3 minutes.
- **Heartbeat files:** no session can see another session's agents, so each one publishes its own count.
- **Reserve, then count:** two sessions spawning at the same moment may both be refused, but neither can take the last slot twice.
- **A failing gate lets the spawn through:** a broken gate never strands work.
- **Not enabled:** the user wants to turn it on later. It is not in `KS_EXTRA_PLUGINS`.

## Uncommitted Changes
None after the handoff commit.

## Known Issues
- **ks-agent-limit was never run in a live session.** Unchecked:
  - whether the hook's `ListAgents` call passes the permission check (if refused, sessions are counted from files only)
  - the real `sections` and `rows` shape
  - how the toast and status line render
- **ks-agent-limit counting gaps:**
  - A teammate in its own pane may count twice.
  - Sessions without the plugin count as one slot each, but their agents are invisible and they aren't gated.
  - Finished agents hold their slot until they drop out of `$.agent.list()`.
- **`capacity.test.ts` fails `tsc`** because the test mocks are loosely typed (`$.agent.spawn({prompt})`, the `FsEntry` fields, the registered tool name). The sources type-check clean and `claude plugin test` passes.
- **The previews sweep was not checked in a live pane.**
- **The 50-id cap on `bulk-update`** is not confirmed by Linear's docs.

## Resume Point
- **Enable ks-agent-limit:** add `ks-agent-limit` to `KS_EXTRA_PLUGINS` in `plugins/ks/scripts/.env`, or try it once with `claude-ks --local-plugin ks-agent-limit` and `max_parallel` set to 2 in `/config`. Then ask for several agents and check that the toast, status line and retry appear.
- **Check the previews sweep:** open `/ks-project` on a ticket with several PRs and confirm one `list_deployments` call per poll after the first one.
