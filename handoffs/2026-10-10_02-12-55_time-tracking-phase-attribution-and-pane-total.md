---
date: 2026-10-10T02:12:55+05:30
git_commit: 0be3199
branch: main
task: ks time tracking — drop the mod's own MCP polls, attribute events to phases from state.yaml, pane total + No phase rows
---

# Handoff: Time Tracking Phase Attribution and Pane Total

> See CLAUDE.md for dev guidance. Time-tracking rules: `plugins/ks/scripts/README.md` ("Time tracking"). Pane: `plugins/ks/README.md`. Previous session: `handoffs/2026-10-09_15-11-16_time-tracking-backups-page-and-action-streams.md`.

## What Happened

1. **Mod polls dropped** (previous handoff's resume step 3). The logs confirmed the statusline mod's own `$.mcp.call`s raise `PostToolUse`.
   - Counts across both logs: `list_deployments` ×685, `list_deployment_aliases` ×38.
   - Nothing marks them apart from Claude's calls except the tool name.
   - `lib/time-tracking.ts` `MOD_TOOLS` drops both tools in `intervals()`, so they can't keep a turn with no `Stop` (a slash command) busy.
   - Result: KAR-13030 agent time went from 2h 03m to 1h 49m.
2. **Phase lag fixed.** The user reported KAR-13178 Implement at 3–4m.
   - Cause: `time-log.sh` cached the phase at SessionStart/prompt only. Implement went IN_PROGRESS at 01:17:19 mid-turn, so the whole implementation run (8.5m subagent included) was logged with no phase until the next prompt.
   - `time-log.sh` now caches `id<TAB>state_file` and reads the phase with awk on every event.
   - `withPhaseSpans()` (time-tracking) restamps each event from state.yaml's phase runs. `phaseSpans()` (state-time) reads those runs: the phase's own `started_at`/`ended_at`, or one run per iteration. This also corrects existing logs.
   - `mainIntervals` lets the phase move within a turn (`phase = e.phase ?? phase` on progress events and Notification).
   - `ks-time` uses the spans for `--write` and for the checkout's own unit. The pane builds them from the new `ProjectInfo.phases[].runs`.
   - Result for KAR-13178 (from its worktree): Implement 16m engaged / 13m agent (was 4m); No phase 11m → 1m.
   - The session's transcript ends at 01:29:18, and no other Claude session touched the ticket. The rest of the user's implement work happened outside Claude Code.
3. **Pane total.** `phaseTime` is now `{ byPhase, engaged, agent }`. Under PHASES the pane shows:
   - **No phase** (only when > 0);
   - **Total**: engaged in bold, `· agent` dimmed. It is a union, so not the sum of the rows.
   - `live.test.ts` asserts both rows.
4. Docs updated: `scripts/README.md` (phase attribution, No phase, mod tools, pane total), `plugins/ks/README.md` (pane rows), `CLAUDE.md`.

## Key Decisions Made

- Filter the mod tools by name in `intervals()`, not in the logger. The raw log keeps every event, so rules can change and recount the past. Claude calling the same tools loses nothing, because a turn's time runs to its next event.
- Attribute phases from state.yaml runs where the state is at hand, and fall back to the logged phase. Where runs overlap (a revisit), the latest-started run wins. An event outside every run keeps its logged phase.
- An interval belongs to the phase before the event that ends it. The first event logged in a new phase starts that phase's time.

## Deviations from Plan

None.

## Uncommitted Changes

None after this handoff's commit.

## Known Issues

- `ks-time KAR-123` run **outside** the unit's checkout has no state.yaml to hand, so it shows phases as logged. Old logs keep the lag there. `ks-time` in the worktree and the pane are correct.
- Sessions running at deploy have the old `.sessions/<id>` cache line (`id<TAB>phase`). They log no phase until their next prompt rewrites it. The state spans still correct this wherever the state is used.
- A phase-boundary interval with no main-chain event after the new phase's start stays billed to the old phase. Real logs always have the state.yaml edit's `PostToolUse` right there.
- Open from earlier, still unchanged:
  - ks-flow deploy plus the browser check of the stream panels;
  - pane close mark cut off;
  - KAR-12961 re-uploads;
  - orphan `SubagentStop`s. They come every ~32s in KAR-13178's log, with ids never started. Harmless; origin unknown.
- `plugins/ks/scripts/quality-typecheck.sh` looks for `apps/www/.tsconfig.quality-check.json`, so it doesn't apply in this repo. Use `npm run build` plus `claude plugin test`.

## Resume Point

1. Start a new `claude-ks` session in the KAR-13178 worktree and open `/ks-project`. Check that PHASES shows Implement ~16m, then No phase and Total.
2. Refresh 13178's state.yaml figures: run `ks-time --write` in `~/karmasuite/karmasuite-worktree/jaswanth/kar-13178-fix-ai-chat-budget-update-error-before-customer-testing` (or let the next Stop do it).
3. Then the previous handoff's ks-flow steps: `ks-flow start`, `ks-flow open`, and check the backup stream panels in the browser.
4. Checks after edits:
   - `node --import tsx --test lib/*.spec.ts` (in `plugins/ks/scripts`; 18 pass)
   - `npm run build`
   - `claude plugin validate plugins/ks`
   - `claude plugin test plugins/ks` (26 pass)
