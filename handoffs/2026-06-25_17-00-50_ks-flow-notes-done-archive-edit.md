---
date: 2026-06-25T17:00:50+05:30
git_commit: 781ce22
branch: feat/ks-flow-plugin
task: ks-flow Notes — per-type reminder notification titles, Done→Archive lifecycle (new `done` flag + Archive drawer), and inline edit for free-text (non-Slack) notes. Plus all prior uncommitted Notes/reminder work. ALL UNCOMMITTED.
---

# Handoff: ks-flow Notes — Done/Archive + edit + per-type notification titles

> Plugin docs: `plugins/ks-flow/README.md` (authoritative, updated this session). Repo guidance: `CLAUDE.md`. Continues the long-lived `feat/ks-flow-plugin` branch. Immediately prior handoff (same uncommitted base): `2026-06-25_11-30-33_ks-flow-notes-page-and-reminder-glow.md` — read it for the full Notes-page / reminder-glow / pause / third-board-table context that is STILL uncommitted underneath this session's work.

## What Happened
Three small Notes features on top of the still-uncommitted big Notes session. HEAD unchanged (`781ce22`). Everything in the working tree.

### 1. Per-type note notification titles (daemon)
`src/daemon.ts reminderTick` — a fired note reminder's subtitle was `"${section} note"` / `"Saved note"`. Now built from `workType` + Slack-ness:
**Professional Slack note** / **Personal Slack note** / **Professional note** / **Personal note**.
`r.workType === 'personal' ? 'Personal' : 'Professional'` + `r.section === 'slack' ? 'Slack note' : 'note'` (linear/generic → "note").

### 2. Done → Archive (new `done` flag)
A note can now be **completed & archived**, distinct from Trash.
- New field **`done?: boolean`** on ReminderDoc — added to BOTH `src/lib/db/types.ts` and `web/lib/types.ts`.
- **Card ✓ button** (emerald hover, beside ✕) → `PATCH {uid, done:true}`, archives **immediately** (no confirm — reversible).
- **Header ✓ Archive** button (with count) opens an **Archive drawer** mirroring Trash; each row has **Reopen** (`done:false` → back to board).
- **API** `/api/notes`: GET gained `?archive=1` (`done && !cleared`); active list now `!done && !cleared`; trash unchanged (`cleared`). PATCH accepts `done`.
- **Daemon** `reminderTick`: skip condition now includes `r.done` → archived notes stop nagging.

### 3. Inline edit for non-Slack notes
- **Card ✎ button** (indigo hover) — only when `section !== 'slack'` and not already editing. Slack notes stay read-only (body is the fetched message).
- Click → inline `<textarea>` (3 rows, prefilled) + **save** (`PATCH {uid, text}`) / **cancel**. Empty disabled. PATCH already supported `text`; only UI was added.

### Docs
`README.md` Notes section updated: new **Editing** para, the three lifecycle actions (✓ Done/Archive vs ✕ Trash, both vs reminder **clear**), the `done`/`cleared` independence + GET filters, and the **Notification titles** line.

## Key Decisions Made
- **`done` is a separate flag from `cleared`**, not a reused one — Archive (finished) and Trash (mistake) are semantically different drawers. Independent booleans; a note is active only when neither is set.
- **Done archives immediately, no confirm** (it's reversible via Reopen); Trash keeps its confirm modal (it leads to a hard delete).
- **Edit gated to non-Slack** — Slack note text is the fetched message; editing it would desync from the source. No ✎ on Slack cards.
- Notification title uses **"note" (lowercase)** after the work type, "Slack note" when `section==='slack'`.

## Deviations from Plan
- None — each ask was a direct small feature, implemented as requested.

## Uncommitted Changes
This session touched: `src/daemon.ts` (titles + done-skip), `src/lib/db/types.ts` (+done), `web/lib/types.ts` (+done), `web/app/api/notes/route.ts` (archive GET + PATCH done), `web/app/notes/page.tsx` (✎ edit, ✓ done, Archive drawer + handlers), `README.md` (Notes docs).
These sit ON TOP of the prior-session uncommitted set (see that handoff): `CLAUDE.md`, `globals.css`, `processes/page.tsx`, `settings/page.tsx`, `Board.tsx`, `SessionCard.tsx`, `serverdb.ts`, `web/app/api/settings/route.ts`, and untracked `pocketbase/pb_migrations/1700000003_slack_names.js`, `web/app/api/notes/`, `web/app/api/open-env/`, `web/app/notes/`, `web/components/CompletedNoWorktree.tsx`.
Typecheck: `web` clean; `src` clean (`node_modules/.bin/tsc --noEmit` from each dir).
(Note: `git status` shows a benign `plugins/ks/scripts/.env.example: Operation not permitted` — sandbox read-deny on .env*, not a real change.)

## Known Issues
- **Daemon changes need rebuild + restart** to go live: `cd plugins/ks-flow/src && npm run build`, then restart (board **kill** → next session, or relaunch `claude-ks`). Until then the live daemon uses the old note subtitle and still nags archived notes.
- Web changes hot-reload in dev; a prod board needs a rebuild.
- Carryover from prior handoff still applies: `1700000003_slack_names` migration needs a PB/daemon restart; stale macOS banners may linger; Slack resolution needs the right token scopes.

## Resume Point
1. **Decide on commit** — the whole Notes/reminder series is still uncommitted and growing. Suggested commit chunks (or squash): (a) Notes page + Slack notes + Trash; (b) Edit-.env + sticky headers; (c) reminder master-gate + overdue glow + pause-silences; (d) third board table; (e) **this session**: per-type notification titles + Done/Archive + inline edit. Long-lived branch → eventual `/ks:create_pr` to `main`.
2. **Rebuild + restart daemon** to activate the title + done-skip changes (command above).
3. Optional live verify: add a Personal free-text note → confirm ✎ edits in place, ✓ archives + appears in Archive drawer + Reopen returns it, and a fired reminder shows e.g. "Personal note" as the title. Confirm Slack notes have no ✎.
4. No outstanding code bugs. Typecheck green.
