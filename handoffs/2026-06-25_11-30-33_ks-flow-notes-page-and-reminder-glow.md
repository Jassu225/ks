---
date: 2026-06-25T11:30:33+05:30
git_commit: 781ce22
branch: feat/ks-flow-plugin
task: ks-flow Notes page (notes + reminders, Slack permalink notes w/ humanized+colored mentions, soft-delete/Trash, Professional/Personal columns), Edit-.env button, sticky headers, reminder system fixes (master toggle gates all, overdue red glow, pause silences custom reminders), and a third board table for completed-without-worktree. ALL UNCOMMITTED.
---

# Handoff: ks-flow Notes page + reminder/glow/pause work

> Plugin docs: `plugins/ks-flow/README.md` (authoritative). Repo guidance: `CLAUDE.md`. Continues the long-lived `feat/ks-flow-plugin` branch. Prior handoff: `2026-06-19_01-23-11_ks-code-review-builtin-and-notification-focus-diagnosis.md`.

## What Happened

Big feature session on ks-flow. **Nothing committed yet** — the user tested iteratively and is holding the commit. HEAD is still `781ce22` from the previous session. Everything below is in the working tree.

### 1. Notes page (`/notes`) — new feature
A per-project page for saved notes + reminders, **opt-in** via Settings → Notes (off by default). Note rows reuse the `reminders` collection with `kind:'note'` (+ new fields `section`, `workType`, `text`, `sourceDate`, `sourceUrl`). The daemon fires note reminders on the same path as per-card custom reminders.
- **Add** from a header **+ Add note** menu (Slack note / Any note) → a **modal** form. "Any note" = free text; "Slack note" = paste a message permalink.
- **Board splits by work type**: Professional (left) / Personal (right), default Professional, legacy/undefined rows fall left. Each column reverse-chronological by `createdAt`.
- **Slack notes**: paste a permalink → server (`/api/notes/slack/resolve`) parses `channel`+`ts` and fetches the message **text + date** via `conversations.history` / `conversations.replies`. Reminder optional, blank by default (Slack has NO API for saved-message due dates — see decisions).
- **Mentions humanized + colored at render time** (`renderSlackParts` in the page): `<@U…>` → `@name` (indigo), `<#C…>` → `#name` (sky), `@here/@channel` (amber), links (indigo anchors). **DB text stays raw.** User/channel IDs without inline names resolve **cache-first from the DB** (`slack_names` collection / Firestore `slackNames`, via serverdb `getSlackNames`/`putSlackNames`), Slack `users.info`/`conversations.info` only on a miss (`/api/notes/slack/names`).
- **Soft delete**: ✕ → confirm modal → `cleared:true` (kept in DB, hidden, daemon skips). Header **🗑 Trash** restores (`cleared:false`) or Delete-forever (hard `DELETE`). `GET /api/notes?trash=1`.

### 2. Edit .env + sticky headers
- **Edit .env** button in the Settings **header** → `/api/open-env` runs `open -t` on `$CLAUDE_PLUGIN_DATA/.env` (never read / never over HTTP; creates with chmod-600 template if absent).
- Sticky headers (`sticky top-0 z-10`) on settings / notes / processes pages (board already pinned via flex layout).

### 3. Reminder system fixes (daemon — `src/daemon.ts reminderTick`)
- **Unified custom + note reminders to daily re-nag** (was once + wake/start) — fire at due, re-nag once/24h until cleared.
- **Master `reminders.enabled` now gates ALL firing** (stop-nudge + custom + note) — was stop-nudge only.
- **Pause silences custom reminders too**: daemon builds `pausedUnits` (any unit with a paused session) and skips custom reminders for them. Notes have no unit → unaffected.

### 4. Overdue red glow (global)
`.overdue-glow` in `globals.css` mirrors `.session-glow` in red. On session work-unit cards (their custom reminders) and Notes cards. **Active indigo glow wins** over overdue red; **paused** session card shows no red glow. Clock-driven via `useNow`.

### 5. Third board table — `Completed · worktree removed`
`CompletedNoWorktree.tsx` (read-only): done units with NO live worktree (inverse of the existing `CompletedWorktrees`). **Hidden by default**; header **show completed** checkbox reveals it. Board now reads as a lifecycle: active → completed-not-removed → completed-removed.

## Key Decisions Made
- **Slack saved-messages can't be auto-listed.** Slack retired the stars/Save-for-later read APIs in 2023 (confirmed live: `stars.list` returned 0 items). So Slack notes are **paste-a-permalink** (single message IS fetchable), not an auto-synced list. Reminder is NOT seeded from any Slack date — blank by default, user sets it. (User confirmed each pivot.)
- **Reuse `reminders` collection** for notes (`kind:'note'`) — no new notes collection.
- **DB-backed name cache** (`slack_names`), not a JSON file (user's call). Generalized from an earlier `slack_users` (renamed before it was ever applied) to cover users + channels by id prefix.
- **Mentions substituted at render time only**; raw text preserved in DB.
- **Pause = full silence** for a card (stop-nudge + custom reminders + glow).

## Deviations from Plan
- None — feature evolved through user iterations; each step confirmed via AskUserQuestion.

## Uncommitted Changes
Modified: `CLAUDE.md`, `plugins/ks-flow/README.md`, `src/daemon.ts`, `src/lib/db/types.ts`, `web/app/api/settings/route.ts`, `web/app/globals.css`, `web/app/processes/page.tsx`, `web/app/settings/page.tsx`, `web/components/Board.tsx`, `web/components/SessionCard.tsx`, `web/lib/serverdb.ts`, `web/lib/types.ts`.
New (untracked): `pocketbase/pb_migrations/1700000003_slack_names.js`, `web/app/api/notes/` (route.ts, config/, slack/resolve/, slack/names/), `web/app/api/open-env/`, `web/app/notes/page.tsx`, `web/components/CompletedNoWorktree.tsx`.
Typecheck: `web` + `src` both clean (`node_modules/.bin/tsc --noEmit` from each dir).

## Known Issues
- **`slack_names` migration needs a daemon/PB restart to apply** — PocketBase reads migrations from the data dir; bootstrap re-copies them every run and PB applies on startup. Until then mention-resolution no-ops (shows raw ID).
- Stale macOS notification banners persist in Notification Center until dismissed — a leftover from a pre-fix daemon fire can look like a live violation (verify via the reminder row's `lastFiredAt` vs the daemon process start time; see the pause diagnosis at the end of the session). The pause-silences-custom fix is live and correct (daemon restarted 11:16, `lastFiredAt` stayed pre-restart).
- Slack resolution needs the right token scopes: `users:read`, channel-`*:history` (for message fetch), `channels:read`/`groups:read` (channel names). Missing → graceful fallback (raw id / unresolved), surfaced as `missing_scope` where applicable.

## Resume Point
1. **Decide on commit.** User has been holding. Proposed split (or squash): (a) Notes page feature; (b) Edit-.env + sticky headers; (c) reminder master-gate + overdue glow + pause-silences; (d) third board table. Use `/ks:create_pr` later — this branch is a long-lived ks-flow series, eventual PR to `main`.
2. **Daemon-affecting changes require rebuild+restart** to take effect on the live daemon: `cd plugins/ks-flow/src && npm run build` then restart (board **kill** → next session, or relaunch `claude-ks`). The `1700000003_slack_names` migration also needs the PB restart.
3. Optional live verifications still worth doing: add a Slack note with @mentions/#channels (confirm colored names + cache row in `slack_names`), toggle **show completed**, pause a card with an overdue custom reminder (confirm no fire + no red glow).
4. No outstanding code bugs. Typecheck green.
