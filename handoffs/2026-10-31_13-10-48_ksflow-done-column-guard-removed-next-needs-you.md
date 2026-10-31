---
date: 2026-10-31T13:10:48+05:30
git_commit: ce21a1d
branch: main
task: ks-flow Done column shipped, Inbox guard removed; next is the "Needs you" page
---

# Handoff: Done column + guard removal shipped; build the Needs-you page

> Captures ONLY deltas from project files. See CLAUDE.md, plugins/ks-flow/README.md ("Done column", "No guard on Inbox calls"), plugins/ks/RELEASES.md (2026-10-31). Previous handoff: 2026-10-31_12-09-47_ksflow-inbox-cards-next-needs-you-page.md (its "Needs you" plan still stands).

## What Happened
Three commits, each pushed to jassu then origin:
- `5ce4eac` `feat(ks-flow): Done is a board column, not two tables`. Verified live in Chrome: 2 Done cards with live worktrees, and 103 dimmed Restore-only cards behind **show removed**.
- `cf7362a` `fix(ks): run quality hooks only in the configured project`. `quality-files.sh` gates on the git common dir of `KS_PROJECT_ROOT_PATH` from `plugins/ks/.config`.
- `ce21a1d` `fix(ks-flow): remove the Inbox guard, document why it can't work`.

## User Decisions
- **ks-flow is a one-way hub.** Links go out from ks-flow, never back into it. The Inbox→card back-link was dropped (memory: project_ksflow_one_way_hub).
- **Done = a column**, not a table. "show completed" was renamed **show removed**.
- **Dropped:** the `wakes: true` check and the plannotator "hook was skipped" notices (plannotator #2159 covers them).
- **Polling for the Needs-you page (Slack/GitHub): still undecided.** The user said to "discuss later in the current work", so ask when building sources (b)/(c). My recommendation: only while the page is open.

## Debugging Trail (Inbox guard)
1. Tried: extended `inbox-guard.mjs` to refuse `resolve_message` on threads the session never wrote in (owner = `author.session` in `messages.jsonl`).
2. Failed: a live `resolve_message` on another session's thread went through. A probe line at the top of the script never ran in 3 calls, before and after `/reload-plugins`, though `/hooks` listed the hook.
3. Root cause: plannotator's mod answers `plannotator_inbox` in `tool.call` without `next(e)` (`apps/hook/hooks/mod/register.ts`: "No other hook or core runs for it"), so plugin `PreToolUse` command hooks never run. Same mechanism as anthropics/claude-code#104217.
4. Outcome: the user had the guard removed entirely. The only path left is a ks-flow mod that answers `tool.call` before plannotator does (untested, depends on mod order). Parked.

## Gotchas
- **Bash can't write under `plugins/ks` or `plugins/ks-flow`** (sandbox denyWithinAllow). Use Edit/Write for edits. Deletes need bare `git rm` (git is excluded only as the first token, so never `cd … && git`).
- **`ks-flow start/stop/open` isn't sandbox-excluded.** The user runs `! ks-flow stop && ks-flow start && ks-flow open`. The board build runs `next build` with type-checking, which is the web typecheck.
- **Done column with show removed = 105 cards.** A cap or "show all" was offered but not decided.

## Uncommitted Changes
None. Both handoffs are committed with this one.

## Resume Point
Build the **Needs-you page** in ks-flow (`web/app/needs-you`), starting with source (a): sessions waiting on the user plus Inbox questions, from data already in the store (`waiting`, `inbox` on work units), web-only, each row linking out. Then (b): PRs approved and green, or awaiting the user's review, via `gh`. Ask the polling question before (b). Sources (c) Slack and (d) Linear Triage come later. Plan with the user before coding.
