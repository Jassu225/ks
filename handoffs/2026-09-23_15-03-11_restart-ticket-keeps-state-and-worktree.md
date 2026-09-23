---
date: 2026-09-23T15:03:11+05:30
git_commit: d5e586e
branch: main
task: Restarting a ticket keeps its workflow state and its worktree
---

# Handoff: Restarting a Ticket Keeps Its State and Worktree

> See docs/product-overview.md for product context, docs/tech-stack.md for dependencies, and CLAUDE.md for dev guidance.

## What Happened

Re-running `ks-start-ticket` on a ticket that had been worked before — a reopened
ticket — destroyed the workflow twice over.

**1. `state.yaml` was rewritten unconditionally** (`fs.writeFileSync` at the old
`ks-start-ticket.ts:398`). Every phase the ticket had completed, every PR in
`prs[]`, both Slack threads and `worktree_dir` went back to a fresh phase-0 state.
Fixed in `63e717a`:

- `loadExistingState(outputPath)` — reads the state.yaml already at the output
  path. Returns `null` for a missing file, unparseable YAML, or a file without a
  `ticket:` key (that last one catches a project state.yaml), logging a warning
  and letting the caller regenerate rather than merging onto garbage.
- `mergeWithExistingState(fresh, existing)` — Linear owns the `ticket:` block,
  because a reopened ticket has a new status and may have picked up labels, an
  estimate or a different assignee while it was closed. `phases[]`, `prs[]`,
  `slack:` and `worktree_dir` come from the existing file; the script cannot
  re-derive any of them.
- A project thread already recorded is reused rather than re-prompted for.
- Output now says `updated` instead of `saved`, plus
  `Carried over: N phase(s), M PR(s)`.

**2. The launch then died anyway.** `create-worktree` hard-errors on an existing
worktree (`:118`), an existing registration (`:127`) or an existing branch
(`:145`), so a reopen whose worktree was still on disk wrote the state file and
exited 1 — no session. Fixed in `dabf442`, in `lib/worktree.ts`:

- `resolveWorktreePath(name)` mirrors the path `create-worktree` derives
  (`dirname(repoRoot)/karmasuite-worktree/<name>`, its `:41`); `findExistingWorktree`
  returns it when it is on disk.
- When it is there, that worktree is worked in as it stands — branch and
  uncommitted work untouched, `create-worktree` never reached. The reuse is
  announced with path and branch, then Claude launches after 10s or on ENTER
  (`waitOrEnter`, per-second countdown; a non-TTY just waits out the clock).
- `syncStateIntoWorktree` copies the refreshed state.yaml into the reused
  worktree, since only `create-worktree` copies `workflow/` and it no longer runs.
- `launchClaude` extracted so the create path and the reuse path share it.
  `createWorktreeAndLaunchClaude` is now `async`; both callers `await` it.

**3. The state copies point in the other direction than expected.** Phases advance
inside the *worktree* session, so when a worktree is live its `state.yaml` is the
authority and the main-repo copy is stale. `ks-start-ticket` now loads the
worktree copy as the existing state when that worktree exists, falling back to the
repo copy; the log line says which (`(worktree)` / `(repo)`). Without this, reuse
would have merged onto the stale copy and rolled the workflow back.

Verified with two throwaway harnesses (both deleted): 18 assertions on
load/merge — refresh of status/title/estimate/labels, preservation of
worktree_dir, 3 phases, 1 PR and both Slack threads, plus missing file, broken
YAML, project state.yaml, absent `prs`/`phases`/`slack` keys, and a
newly-resolved thread when the old state had none. Then 12 assertions on the
worktree path over a scratch git repo with a fake sibling worktree — path
derivation matching `create-worktree`, detection hit/miss, refreshed state copied
in with `worktree_dir` on both copies, no truncation when the output path *is*
the worktree copy, non-TTY waiting the full 2s (2002ms), a fake-TTY ENTER
returning at 302ms out of 30s, and stdin left resumed→paused with its listener
removed. All pass. `tsc --noEmit` clean throughout.

## Key Decisions Made

- **Refresh the ticket, keep the history** — rather than leaving an existing
  state.yaml entirely untouched. A reopened ticket's status is exactly the field
  that moved, so a preserved-as-is file would have shown `Done` for the whole next
  session. User picked this over the leave-untouched and prompt-every-time options.
- **The worktree's state.yaml wins when the worktree is live.** Not asked for, but
  the reuse feature is wrong without it: phases only ever advance in the worktree,
  so merging onto the repo copy silently discards the last session's progress.
- **Reuse lives in the shared `lib/worktree.ts`, so `ks-start-project` gets it too.**
  The state-merge half is ticket-only, as scoped. The project script had the same
  `create-worktree` failure, and the fix is the same code path.
- **Reuse only when the directory is on disk.** A worktree registered in git but
  with its directory gone still falls through to `create-worktree` and its
  "already registered → `git worktree prune`" message. Pruning is a repo mutation
  the launcher should not make on its own.
- **A 10s wait, not a prompt.** Nothing is being decided — the launch happens
  either way. The pause only gives the notice time to be read, and ENTER skips it.
- **Warn and regenerate on a bad state.yaml** rather than aborting. A corrupt file
  should not block starting work on the ticket.
- **`undefined`/absent-key tolerance in the merge** (`existing.prs ?? []`,
  `existing.phases?.length ? … : fresh.phases`) — hand-edited state files in the
  wild are missing keys.

## Deviations from Plan

The worktree work was scoped, at the end of the first fix, as a follow-up question
("want me to make it reattach?"). The user's answer redirected it: not reattach
and continue as if creating, but *skip creation entirely* and work in what is
there. That is what shipped.

## Uncommitted Changes

None. Three commits on `main`:

- `63e717a` — `ks-start-ticket.ts`, `WORKFLOW.md`: preserve workflow history
- `dabf442` — `lib/worktree.ts`, both start scripts, `WORKFLOW.md`,
  `scripts/README.md`: reuse an existing worktree
- `d5e586e` — `CLAUDE.md`: "Restarting is not a reset" note under Two Workflow Types

`63e717a` and `dabf442` are pushed to `jassu` then force-pushed to `origin`.
**`d5e586e` and this handoff are not yet pushed.**

## Known Issues

- `plugins/ks/RELEASES.md` has not been touched since 2026-04-01 (`c10dafe`) —
  five months of shipped work, this included, is absent from it. Left alone rather
  than reviving a changelog the team appears to have dropped; worth a decision.
- `plugins/ks/scripts/quality-lint.sh` still fails with
  `ERR_PNPM_RECURSIVE_EXEC_NO_PACKAGE` (points at the karmasuite workspace, not
  this repo). Pre-existing, unrelated, not run this session.
- `npx tsx <file>` dies inside the sandbox with
  `Error: listen EPERM ... /tmp/claude-501/tsx-501/*.pipe` — the tsx CLI wrapper
  opens an IPC socket. Use `node --import tsx/esm <file>` to run a TS file, and
  `./node_modules/.bin/tsc --noEmit -p tsconfig.json` to typecheck (`npx tsc`
  grabs the wrong package).
- The reuse path assumes the worktree is in a usable state. A worktree left
  mid-rebase or with a detached HEAD is launched into as-is, without a warning.
- `resolveWorktreePath` hardcodes `karmasuite-worktree` to match
  `create-worktree:41`. If that script's `WORKTREES_BASE_DIR` changes, this must
  change with it.

## Resume Point

Nothing is blocked. First:

```bash
cd /Users/jassu/git/ks
git push jassu main && git push --force-with-lease origin main   # d5e586e + handoff
```

Then, to exercise the real path end to end (no harness has driven the Linear half):

```bash
# 1. Start a ticket, let it create the worktree, then exit the session
ks-start-ticket https://linear.app/karmasuite/issue/KAR-XXXX/<slug>

# 2. Advance a phase in the worktree's state.yaml by hand, then re-run the same
#    command. Expect: "Existing workflow state found (worktree)", the phase still
#    there, "Worktree already exists — working in it instead of creating one",
#    and the 10s countdown.
```

If picking this up further:

- `plugins/ks/scripts/ticket-state.schema.json` was not touched — the state shape
  is unchanged. Any new field added to `TicketWorkflowState` must also be decided
  into `mergeWithExistingState`, or it will silently reset on every restart.
- `ks-start-project.ts` still recreates its `state.yaml` unconditionally
  (`:523`). Deliberately out of scope this session; it now gets worktree reuse but
  not state preservation, so re-running it on a live project still wipes the
  phases. That asymmetry is the obvious next fix.
- The 10s constant is `REUSE_NOTICE_SECONDS` at the top of `lib/worktree.ts`.
