---
date: 2026-10-31T12:09:47+05:30
git_commit: 0070315
branch: main
task: ks-flow ↔ Plannotator Inbox shipped; next is the "Needs you" page (to be discussed)
---

# Handoff: Inbox on ks-flow cards shipped; plan the "Needs you" page

> See CLAUDE.md for dev guidance, plugins/ks-flow/README.md ("Plannotator Inbox", "Cards") for how it works, plugins/ks/RELEASES.md (2026-10-31) for the user-facing summary. Previous handoff: 2026-10-31_08-04-58_pr-preview-vercel-server-name.md.

## What Happened
- **The brief.** The master session (karmasuite-99) sent one. On 2026-10-30 KAR-13197 asked two blocking questions only in the Plannotator Inbox, and nobody saw them for hours: ks-flow showed the card as idle. The brief had three parts: (1) the Inbox on each card, (2) a cross-source "Needs you" page, (3) a link back from the Inbox to the card. The user chose part 1 first and asked for a diagonal **ribbon** ("tied from one side to another") to draw attention.
- **Research first.** I read the Inbox docs (docs.plannotator.ai/open-source/inbox) and its source. The source is a local checkout at `~/.claude/plugins/marketplaces/plannotator`, v0.28.40; the installed binary is 0.28.39. The key facts are in the ks-flow README "Plannotator Inbox" section:
  - The files are append-only `{v,seq,at,kind,id,record}` full snapshots; the highest seq wins.
  - Question state is derived the way the Inbox's `inboxQuestionState` does it.
  - Deleting a thread rewrites the files (new inode); deleting a project removes its folder.
  - Links are `<url>#thread=<root>&msg=<id>`, with `url` taken from `inbox.json`. The port changes on every restart. Never read the `token`.
- **Built** (commit `0070315`, pushed to jassu then origin):
  - `plugins/ks-flow/src/lib/inbox.ts`: the reader, fold and per-thread summary, plus `attachInbox` (joins threads to a card by **session id only**) and the registry and health check.
  - `src/daemon.ts`: an `inbox` job on the 15s clock (also run by a card's ↻ refresh). It joins threads onto cards, sets `waiting.tool='Inbox'`, and adds `project.inboxUrl`/`inboxRunning`. It sends one macOS notice per new question; questions already open at startup are not announced. The pause and reminder switches apply.
  - Web: in `SessionCard.tsx`, `NeedsYouRibbon` (a diagonal sash, red when the agent stopped) and the `InboxThreads` rows. CSS is `.needs-you-ribbon` in `globals.css`. The Inbox address goes Board → Column → card.
  - `scripts/inbox-guard.mjs`, a PreToolUse hook (matcher `mcp__.*plannotator.*`). It refuses `send_message`/`submit_guide` whose `project_path` has a different git toplevel from the session's cwd.
  - Tests: `cd plugins/ks-flow/src && npm test` (node:test + tsx, 12 tests). `tsx` was added as a devDependency, and tests are excluded from the build.
- **Verified live in Chrome** (claude-in-chrome) on the real board at :4317:
  - A test question appeared on the KAR-13197 card: red NEEDS YOU sash, `⏳ waiting: Inbox`, a `⛔ Stopped on you` row.
  - Both links opened the Inbox thread.
  - Archiving the thread cleared everything.
  - Two archived test threads remain in the Inbox ("ks-flow ribbon test", "… test 2"). The user said that's fine.

## Key Decisions Made
- **Session id is the only identity; `base_path` matching was removed.** The user called it a hack: any session can name any folder. Each card also sees only questions and unseen messages its *own* sessions wrote (`narrow()`), so another session's `reply_to` into the card's thread doesn't show.
- **The guard is a guard rail, not a lock.** It runs only in sessions that load ks-flow. The Inbox's stdio server (`plannotator inbox mcp`: `agent_session` is caller-settable, and it trusts `PLANNOTATOR_SESSION_TAG`) and its HTTP API accept any session id. Only the in-process `plannotator_inbox` tool stamps the real id. This is documented under "Limits" in the README.
- **Ribbon trigger:** an open question, an open action item, or a picked-but-unsent answer. Unseen messages alone get only a quiet `✉ N new` row.

## Deviations from Plan
- **Part 3, the link back from the Inbox, was deferred** (the user agreed).

## Uncommitted Changes
- This handoff file.

## Known Issues
- **Done tickets get no ribbon.** A Done ticket's card sits in the completed table, which doesn't render the ribbon, so an Inbox question from it shows only in the Inbox and as a notice.
- **`resolve_message` isn't guarded.** Any session can archive any thread.
- **The guard has not been seen refusing a live call.** The Inbox validates the folder before hooks run, so a safe probe never reached it. To test: in a fresh claude-ks session, send with `project_path` set to another existing worktree; it should be refused.
- **`ks-flow start/stop/open` can't run from the sandbox** (it writes to `~/.claude/plugins/data/ks-flow`). The user runs `! ks-flow stop && ks-flow start && ks-flow open`.

## Resume Point
The user wants to **discuss** what to build next before any code. My recommendation, as last presented:
1. **The "Needs you" page** (`web/app/needs-you`?): one list of everything waiting on the user, each item deep-linking to its source. Add sources one at a time:
   - (a) sessions waiting and Inbox questions: data already in the store, web-only
   - (b) PRs, approved and green or awaiting the user's review: `gh pr list --search`
   - (c) Slack mentions and DMs with no reply or reaction from the user: the ks `slack` CLI (`slack search messages "<@U09FZ1QJ7F1> after:<date>"`, then `slack message thread <ch> <ts> --names`; `slack` must be the first token, never supply SLACK_TOKEN)
   - (d) Linear tickets assigned to the user still in Triage
   - **Open decision:** poll Slack and GitHub from the daemon on a timer, or only while the page is open. I recommend only while the page is open.
   - I suggested building (a), (b) and the Done-ticket ribbon fix first.
2. **Smaller items:**
   - the Done-ticket ribbon
   - the link back from the Inbox to the card (check whether the board has deep links to a single card)
   - the `resolve_message` guard
   - checking whether `wakes: true` is caller-settable (if not, cards could trust only messages that carry it)
   - plannotator's "hook was skipped" notices (a hook-order clash with `cc-plugin-sec-default`)

Start by summarizing these options and asking the user which to take, and the polling question.
