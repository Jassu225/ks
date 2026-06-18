---
date: 2026-06-18T21:07:02+05:30
git_commit: 21d1790
branch: feat/ks-flow-plugin
task: ks-flow notification reliability overhaul — fix restart-silence (rebuild docs + reconstruct nudges), completion/generic gating, body-wrap layout, /processes kill button, and the root cause that KST worktrees never loaded ks-flow. All committed + pushed to both remotes.
---

# Handoff: ks-flow notification reliability + KST plugin-load fix

> Plugin docs: `plugins/ks-flow/README.md` (Notifications + Reminders + Processes sections updated this session). Launcher docs: `plugins/ks/scripts/README.md`. Builds on `2026-06-18_14-23-13_ks-flow-notification-overhaul-and-processes-page.md`.

## What Happened

Debugging session that started from "completed ticket still notifies?" and "I don't see notifications" and ended in a full reliability pass + finding the real root cause. The daemon tracks **`/Users/jassu/karmasuite/karmasuite`** (NOT this `ks` repo), so all testing was against that project's sessions. Daemon redeployed live repeatedly via `ks-flow start` (rebuilds on src diff + restarts launchd); last pid 35356. All src/ + web/ typecheck-clean; bash `bash -n`-clean.

Seven commits (3a40017 → 21d1790), all pushed to **jassu** (git@github.com:Jassu225/ks.git) and **origin** (git@github.com:karmasuite/ks.git):

1. **`3a40017` — reliable stop-nudges.** Four daemon fixes:
   - **Restart-silence (the big one):** `ingestSessionFile`'s EOF fast-path (`if st.size <= start && cp: return`) never built the in-memory `SessionDoc` for a session sitting at its persisted offset, so after any restart `sessionDocs` was **empty** (`backfill: 0 ingested`) → a Stop could never match its work-unit → silence. Startup backfill now passes `ingestSessionFile(path, true)` to force a full re-read and rebuild docs (now `22 ingested`); the live watcher keeps the fast path.
   - **`unitCompleted` (`lib/phasemodel.ts`):** require the **terminal phase 10 (`implementation`) COMPLETED** *or* a closed Linear status (Done/Canceled/Merged/Duplicate), with nothing IN_PROGRESS/REVISITING. Old logic ("last non-skipped phase completed") wrongly flagged an only-initialized ticket (phase-0-only) as done.
   - **Generic suppression:** stop-nudge fires only for a **matched** ticket/project unit; no unit (ad-hoc / main-checkout / removed-worktree) → `continue` (no generic "ks-flow / idle" notice).
   - **Events offset persistence:** `eventsOffset` now saved in `checkpoints.json` (key = `EVENTS_PATH`, sessionId `__events__`), read on startup — a restart resumes instead of replaying the last `maxAge` (60min) of Stops (the duplicate-burst). Cold start / downtime still replays unconsumed backlog.

2. **`8f6db8b` — /processes kill button.** `POST /api/processes {pid}` re-validates the pid against a live `ps` scan and only kills a process classified as a running ks-flow daemon. Page keeps the **newest** daemon (badged `kept`), shows a red **Kill** button on the **older** one(s), `window.confirm` guard.

3. **`9efd042` — KST root cause.** `ks-start-ticket` / `ks-start-project` (via `lib/worktree.ts createWorktreeAndLaunchClaude`) spawned **plain `claude`** with only the ks plugin (DEV-gated `--plugin-dir`), so KST-created worktrees **never loaded ks-flow** → no Stop/waiting hooks → untracked, no notifications. Now spawns **`claude-ks`** (the SCRIPTS_DIR sibling), which loads ks + every `KS_EXTRA_PLUGINS` (ks-flow) + ks-rules. This was THE reason kar-12327 produced zero events until manually relaunched with `claude-ks`.

4. **`d389878` + `8f9a636` — wrap long text.** macOS truncates a notice's title/subtitle to one line but **wraps the message body**; terminal-notifier has no wrap flag. Reordered fields: short identifier → **title**, status phrase ("Claude is waiting on you" / "needs permission" / …) → **subtitle**, long ticket/project title → **message body** (wraps). Applied to the daemon (`stopNotice` → `{label, detail}`) and the bash hooks (`NOTIFY_TITLE/SUBTITLE` → `NOTIFY_LABEL/DETAIL` in `_common.sh build_notify_fields`, + the 3 hook call sites).

5. **`6ef200b` + `21d1790` — restart re-arm, grouped.** Offset persistence meant a restart left `stopState` (in-memory) empty → a still-waiting session lost its nudge. Startup now `reconstructStopState()`: scans the events log, re-arms a session only if its **last lifecycle event is a `Stop`** (not SessionEnd) and within maxAge — resumed/ended stay quiet. To avoid an N-notice burst, the first post-restart notices are batched into **one grouped notice** (`"N sessions waiting on you"` + identifiers in the body); a lone session (verified: kar-12327) falls back to its normal rich notice. A `fromRestart` flag + `armingFromStartup` gate route both warm-restart reconstruction and cold-start replay through the same batching; `armingFromStartup` cleared after the first `reminderTick`.

## Key Decisions Made
- **Force-rebuild docs on startup only** (not persist doc fields in the checkpoint) — simplest correct fix; cost = one cold-backfill-equivalent read per restart, acceptable.
- **`unitCompleted` = terminal phase 10 OR Linear-closed** — covers both full-workflow-done and quick-closed-in-Linear, without false-positiving a phase-0 ticket.
- **Grouped restart notice over individual burst** (user's explicit request) — preserves the "don't spam on restart" intent while not losing genuinely-waiting sessions.
- **Delegate KST launch to `claude-ks`** rather than re-implementing plugin-dir flags in `worktree.ts` — single source of truth.
- **PocketBase `worktreeDir: null` is a board-display nulling** (`recomputeProject` line ~306, gated by `isLive`), NOT a matching bug — the in-memory `units` map (used by notifications) keeps the real parsed `worktreeDir`.

## Deviations from Plan
- None. Scope grew organically from the user's debugging questions; each step verified live before the next.

## Uncommitted Changes
Two doc files staged-but-uncommitted at handoff time (about to commit as the final step of this request): `plugins/ks-flow/README.md` (Processes → Kill button) and `plugins/ks/scripts/README.md` (KST launches via claude-ks). `plugins/ks/scripts/.env.example: Operation not permitted` in `git status` = sandbox read-deny on a gitignored file, not a change.

## Known Issues
- Notification "Show" action button still un-removable via terminal-notifier; Alerts persistence still machine-local (System Settings → terminal-notifier → Alerts) — both pre-existing, documented.
- `/api/processes` is macOS-specific (`ps`/`lsof`).
- The kill button only sticks for a **stray** daemon; the launchd-managed one respawns (documented — that's intended/self-healing).
- Restart re-arm reads the **whole** `events.jsonl` once on startup (small file, fine today; if it ever grows huge, bound the scan to a tail window).

## Resume Point
1. **Commit + push the two doc files** (the final step of the current request): `git add plugins/ks-flow/README.md plugins/ks/scripts/README.md && git commit && git push jassu && git push origin` — verify both remotes match HEAD.
2. To see notifications end-to-end: in the **karmasuite** project, launch a worktree session via **`claude-ks`** (or KST now that it's fixed), finish a turn, idle ~60s without ending → rich wrapped notice fires with the ticket id + wrapped title. For the **grouped restart** path: have ≥2 sessions idle, then `ks-flow start` → one `"N sessions waiting"` notice.
3. Daemon is live (pid 35356) on all fixes; board needs **`ks-flow open`** to rebuild if you want the Kill button visible in the running board UI.
4. Confirm `/processes` shows exactly one **ks-flow daemon** row.
