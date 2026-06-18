---
date: 2026-06-18T14:23:13+05:30
git_commit: ae0c46d
branch: feat/ks-flow-plugin
task: ks-flow notification overhaul — debounced + teammate-aware stop-nudge (quiet-duration gate), rich ticket/project content, terminal-notifier delivery w/ Alerts persistence, idle-debounce setting, Open-Notification-Settings button, and a new /processes board subpage. About to commit + push to both remotes.
---

# Handoff: ks-flow notification overhaul + /processes page

> Plugin docs: `plugins/ks-flow/README.md` (updated this session — Notifications, Reminders, Settings, new Processes section). Builds on `2026-06-17_23-27-18_ks-flow-datadir-fix-extra-plugins-archive-path.md`.

## What Happened

All in `plugins/ks-flow`. Daemon + web typecheck-clean (`npx tsc --noEmit` in `src/` and `web/`); bash `bash -n`-clean. Daemon redeployed live (`ks-flow start`, last pid 47465, single instance).

1. **Stop-nudge: debounce + teammate-aware, rewritten as a QUIET-DURATION gate.** The original behaviour fired the immediate "Claude is waiting" from the **hook**, which misfired the instant the main agent spawned background teammates (a `Stop` fires at every main-turn boundary). Now:
   - `notify-stop.sh` fires **no** immediate notice — it only records the `Stop` event. The **daemon owns all notices**.
   - The daemon's first notice waits until the session is **quiet for `debounceSec`** (default 60s). Quiet spans the session transcript, worktree siblings, **and teammate subagent transcripts** (`<session>/subagents/*.jsonl` — read by new `subagentActivityMs()`; the watcher is `depth:0` and never tails that nested dir, so we stat the files directly).
   - **Critical bug fixed at the end:** gating on `latestActivity > stoppedMs` deleted the stop before notifying, because the `Stop` event ts is **whole-second** (`_common.sh append_event` writes `.000Z`) while the transcript's turn-ENDING line is millisecond and trails the event by a few seconds → the session's own turn-end read as a "resume". Rewrote the gate to **time-since-last-activity** (`now - lastAct >= debounceMs`), immune to ts precision. Resume/cleanup now needs activity **>`RESUME_MARGIN_MS` (30s)** past the stop. (`daemon.ts` reminderTick + new `RESUME_MARGIN_MS`.)

2. **Rich notification content.** Ticket → `KAR-1234` / ticket title; project → project title; else brand/branch. Daemon `stopNotice()` matches session→unit by worktree (`sessionMatchesUnit`, since `SessionDoc.unitId` is always null). Bash hooks resolve via new zero-dep **`scripts/notify-context.mjs`** (`--cwd` → picks the workflow `state.yaml` whose `worktree_dir` matches the repo root; minimal line-parse of `ticket`/`project` + `identifier`/`name`). `_common.sh build_notify_fields` sets `NOTIFY_TITLE`/`NOTIFY_SUBTITLE`; all 4 hooks pass them + a `title` arg to `notify()`.

3. **Delivery = terminal-notifier, NO `-sender`, `-closeLabel "OK"`.** Long detour (see Key Decisions): `-sender <bundleid>` HANGS forever for terminals that aren't registered notification clients (Ghostty) and posts nothing (found 22 zombie procs). Tried osascript (works everywhere, unbranded "Script Editor", but no button control) then reverted to terminal-notifier. `-actions "OK"` was tried to relabel the "Show" button but (a) didn't relabel on this machine and (b) makes terminal-notifier linger waiting for the click — reverted to `-closeLabel "OK"`. The system "Show" action is unremovable but harmless. Both daemon (`lib/notify.ts`) and bash (`_common.sh notify()`) use the same flags.

4. **Persistence = Alerts style (System Settings, per-app).** macOS has no notification-duration API; "stay until dismissed" = Alerts style, set per posting-app. Added the **Open Notification Settings** button (`/api/open-notification-settings` → `open x-apple.systempreferences:com.apple.Notifications-Settings.extension`) + hint in the Reminders panel. User confirmed working after setting terminal-notifier → Alerts.

5. **`debounceSec` setting.** Added to `ReminderSettings` (`boardsettings.ts`, default 60), `/api/settings` read/write, and a "Idle debounce (sec)" field in `/settings`.

6. **New `/processes` board subpage.** Lists ks-flow processes (name, PID, start time, port) so duplicate daemons are visible. `/api/processes` joins `ps` + `lsof` (fixed an lsof parse bug: LISTEN rows end in `(LISTEN)`, so scan for the address token, not the last column); classifies daemon / PocketBase(8090) / board(4317); warns if `daemonCount > 1`. `▤` nav link in `Board.tsx`.

7. **Fixed a live duplicate-notification incident:** a stray manually-started daemon from **Jun 8** (`node dist/daemon.js` in `src/`, old code → generic content) had run 10 days alongside launchd's, firing every notice twice. Killed it (pid 24063). The /processes page exists to surface this in future.

## Key Decisions Made
- **Quiet-duration gate, not stop-ts comparison** — the only robust fix for whole-second `Stop` ts vs ms transcript ts. `RESUME_MARGIN_MS = 30s` clears the turn-end-lag without false resumes.
- **No `-sender`** — branding a notice as an arbitrary terminal (Ghostty) is impossible from an out-of-band process; only the terminal itself can, via OSC escape to its TTY, which the daemon (no TTY) can't reach. Accepted unbranded terminal-notifier identity.
- **terminal-notifier over osascript** — osascript can't relabel/suppress buttons and its "Script Editor" entry isn't reliably togglable to Alerts; terminal-notifier has a stable Settings entry.
- **Startup backlog still fires** — user explicitly chose to KEEP firing nudges for pre-daemon-start stops within the 60-min window (replays `events.jsonl` from offset 0).

## Deviations from Plan
- Net diff is small (~235 lines + 4 new files) despite a large session — the osascript migration and the terminal-selection dropdown / `notify.sender` setting / `/api/terminals` were **added then fully reverted**. `reminders-preflight/route.ts` has a cosmetic-only diff (re-wrapped a return) from that round-trip.

## Uncommitted Changes
Everything in `git status` (about to commit). Modified: `scripts/_common.sh`, `scripts/notify-{stop,waiting,permission,elicitation}.sh`, `src/daemon.ts`, `src/lib/{notify,boardsettings}.ts`, `web/app/api/{reminders-preflight,settings}/route.ts`, `web/app/settings/page.tsx`, `web/components/Board.tsx`, `README.md`. New: `scripts/notify-context.mjs`, `web/app/api/open-notification-settings/route.ts`, `web/app/api/processes/route.ts`, `web/app/processes/page.tsx`. (`plugins/ks/scripts/.env.example: Operation not permitted` in status = sandbox read-deny on a gitignored file, not a change. `src/dist`, `node_modules`, `.next` gitignored.)

## Known Issues
- The notification "Show" action button can't be removed/relabeled via terminal-notifier on this macOS — left as-is (harmless, no action).
- Alerts persistence is **machine-local** (System Settings → terminal-notifier → Alerts); not captured in the repo. Documented in README + the in-app hint.
- Web UI changes (`/processes`, debounce field, Open-Settings button, `▤` nav) need **`ks-flow open`** to rebuild the board server (the running one serves the old build). Daemon already live.
- `/api/processes` is macOS-specific (`ps`/`lsof` paths).

## Resume Point
1. Commit + push to **both** remotes are being done at the end of THIS session — verify: `git log --oneline -3`, and that `feat/ks-flow-plugin` pushed to `jassu` (git@github.com:Jassu225/ks.git) **and** `origin` (git@github.com:karmasuite/ks.git).
2. To see the web changes live: **`ks-flow open`** (rebuilds + restarts the board; daemon already running on the fix).
3. To verify notifications end-to-end: in a tracked session, finish a turn and let it idle ~60s → "Claude is waiting on you" should fire with ticket/project content and persist as an Alert. Multi-agent turns should NOT misfire mid-turn.
4. Check `/processes` shows exactly one **ks-flow daemon** row.
