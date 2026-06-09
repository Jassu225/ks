---
date: 2026-06-09T19:01:43+05:30
git_commit: 26e0c96
branch: feat/ks-flow-plugin
task: ks-flow — board UX (completed-worktrees cleanup, Linear/Slack tags, glow border, swimlanes) + daemon read/write-I/O optimisation. Committed (c3c2018 daemon, 26e0c96 web); typecheck-verified, not yet run live.
---

# Handoff: ks-flow — board UX + daemon I/O optimisation

> Builds on `2026-06-08_22-57-19_ks-flow-pocketbase-ui-overhaul.md`. This is the **delta since the push** at commit `476b58e` (the whole plugin was committed + pushed to both remotes `origin`/`jassu` earlier this session). Plugin docs: `plugins/ks-flow/README.md` (now covers the board UI + cards + daemon sourcing/I/O) + `plugins/ks-flow/docs/IMPLEMENTATION_PLAN.md`; dev guidance in `CLAUDE.md`.

## What Happened

After committing/pushing the plugin (`476b58e`…`5b15c1a`), the rest of the session was UX + perf work on top, now committed as **`c3c2018`** (daemon: dedup + I/O gates + full-state replication) and **`26e0c96`** (web: board UX + docs). Typechecks clean (daemon `npx tsc` in `src/`, web `npx tsc --noEmit` in `web/`); **not yet rebuilt/run live.**

**Completed-worktrees cleanup flow (built earlier this session, in `476b58e`)** — for reference, the "Completed worktrees · not removed" table + Remove button (live-session gate via `lsof`/`ps`, confirm-then-kill, streaming `zsh -c 'source …; eval "$KS_CMD"'` runner) is already committed. The items below are the **post-push delta**.

**Board UX (web/).**
- **Linear + Slack tags on cards** (`SessionCard`): `Linear ↗` / `Slack ↗` links; completed-table ticket id is a Linear link too. Sourced from new fields (below).
- **Copy-worktree-path** button on cards (`⧉ path`, `navigator.clipboard`, secure-context/localhost).
- **Glowing animated border for active sessions** — conic-gradient masked to a ~1.5px ring, spun via `@property --ks-angle` (`globals.css` `.session-glow`). Driven by **client-side recency**: a session is "active" if it wrote within **5 min** (`ACTIVE_WINDOW_MS`), evaluated against a ticking clock — NOT the daemon's stale snapshot `activity` flag, so the glow self-expires.
- **Shared clock**: new `web/lib/useNow.ts`; `Board` calls `useNow(30_000)` once and passes `now` → `Column` → `WorkUnitCard` (one timer, not per-card).
- **Last-active time** on cards: footer `⟳ active <rel>` + absolute timestamp on hover (`unit.lastActivity`).
- **Swimlanes default ON**; ticket lane shows only ticket phases (`TICKET_PHASES = {0,1,2,9,10}`); empty lanes hidden.
- **Horizontal scroll restricted to the board**: `main` is `overflow-y-auto overflow-x-hidden`; each swimlane's columns row is `overflow-x-auto`. Header + completed table no longer scroll sideways.
- Completed-table tweaks: worktree column wraps (`break-all`, capped `max-w-[16rem]`); title widened (`max-w-md` + tooltip).

**Data model — replicate the whole state.yaml.**
- `WorkUnitDoc` (daemon `src/lib/db/types.ts` + web `lib/types.ts`) gained `linearUrl`, `slackThreadUrl`, and **`state`** = the entire parsed state.yaml verbatim (so any field is available without new plumbing).
- `stateyaml.ts`: `linearUrl` ← entity `url`; `slackThreadUrl` ← `slack.project_thread.url`; `state` ← full parsed doc.

**Daemon dedup + I/O (src/daemon.ts).**
- **Source-precedence dedup** (replaces "most-advanced"): per `unitId`, rank tuple `[from-worktree, worktree-live, phase#, #phases]` — a **worktree copy always overrides the main-checkout copy**; main wins only once no worktree carries the unit (post-cleanup). Matches the real lifecycle (worktree authoritative while live → workflow copied back to main + worktree deleted on completion).
- **Read-I/O gate**: `scanStateYaml` skips `readFileSync` + YAML-parse when `statSync().mtimeMs` is unchanged and the unit is known (`stateMtimes` map). Parse only on change; mtime recorded only on successful parse.
- **Write gate**: `recomputeProject` upserts only changed docs — `lastUnitSig`/`lastProjectSig` compare `JSON.stringify(doc)` **excluding `updatedAt`**. Kills the per-edit re-write-everything amplification.
- Side-fix: the 60s worktree re-enumeration now `scheduleProjectRecompute()` when the worktree set changes (the mtime gate stopped the per-tick recompute, which had been nulling dead `worktreeDir`s).

## Key Decisions Made

- **Glow = client-side 5-min recency, not the daemon `activity` snapshot.** The snapshot never re-evaluates on a timer → glow could stick on. Recency + ticking clock self-expires. User chose the 5-min window.
- **Shared clock**, not per-card timers (user request).
- **Store the entire state.yaml (`state` blob)** rather than adding fields one-by-one (user request). Kept `linearUrl`/`slackThreadUrl` extracted for easy rendering.
- **Gates are in-memory** (RAM maps), not persisted/DB-backed. Steady-state (15s loop) is the target; restart does one cold pass. Discussed persisting read-gate mtime (local file or a `sourceMtimeMs` doc field) — **parked**; write-signature persistence barely helps due to the session-join dependency.
- **Source-precedence dedup** per the user's confirmed worktree lifecycle.

## Deviations from Plan

- None structural. Dedup heuristic changed from most-advanced → source-precedence per the user's lifecycle clarification.

## Uncommitted Changes

Committed + pushed to both remotes (`origin` + `jassu`):
- **`c3c2018`** — `src/daemon.ts`, `src/lib/db/types.ts`, `src/lib/stateyaml.ts` (dedup + I/O gates + full-state replication).
- **`26e0c96`** — all `web/*` (incl. new `web/lib/useNow.ts`) + `README.md` (board UX + docs).
- This handoff is committed separately on top.
- (`plugins/ks/scripts/.env.example: Operation not permitted` in git status is a sandbox read-denial on a gitignored file — not a change.)

## Known Issues

- **`SessionDoc.activity` (daemon) now unused for the glow** — still emitted, harmless; could drop later.
- **Restart cold pass**: in-memory read/write gates wiped on daemon restart → one full parse + full upsert, then steady-state cheap. Persisting read-gate mtime would fix (parked).
- **Slack tags won't show** until a `slack.project_thread.url` exists (all null in current data). Linear tags do (entity `url` always set).
- **`state` blob includes everything** in state.yaml (incl. `whoami.email`) — fine for local PocketBase; also pushed to Firestore in cloud mode.
- mtime gate is ms-granular; a sub-ms re-edit could be missed until the next change (negligible).

## Resume Point

Committed + pushed. Code typechecks but is **not yet rebuilt/run live** — that's the next action.

1. **Rebuild + verify live:**
   - Daemon (re-ingest with new fields + dedup + gates): `cd plugins/ks-flow/src && npx tsc` then `launchctl kickstart -k gui/$(id -u)/com.ksflow.ingester` (or full `CLAUDE_PLUGIN_OPTION_project_path=~/karmasuite/karmasuite bash plugins/ks-flow/scripts/bootstrap.sh`).
   - Board: `~/git/ks/plugins/ks-flow/bin/ks-flow close && ~/git/ks/plugins/ks-flow/bin/ks-flow open`.
   - Check: Linear/Slack/⧉-path tags, glowing border on active cards (≤5 min since last write), swimlanes default-on with ticket lane = 5 phases, board scrolls horizontally but header/completed-table don't, completed worktree path wraps.
2. **Parked follow-ups** (user said "park"): all-phases-COMPLETED as a "completed" trigger; default/example remove command (copy-back + `git worktree remove`); persist read-gate mtime to make restart cheap; daemon-side pruning of stale store records; drop the now-unused daemon `SessionDoc.activity` flag.
