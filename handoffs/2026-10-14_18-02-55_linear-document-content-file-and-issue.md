---
date: 2026-10-14T18:02:55+05:30
git_commit: 5662eab
branch: main
task: linear CLI — document create/update --content-file, document --issue (create/update/list), one-parent guard
---

# Handoff: linear document --content-file and --issue

> See CLAUDE.md for dev guidance and plugins/ks/scripts/README.md ("A document has one parent") for the behaviour described here.

## What Happened

Resumed from the 2026-10-13 handoff. Its Resume Point (live tests of `remove_worktree`, `ks-start-ticket` restore, card ↻) needs the user's terminal, so it was not run.

A peer session (KAR-12930, publishing a TAD) reported two gaps in `linear document`:
1. No file input: only inline `--content`. Inline markdown with backticks breaks the sandbox first-token match → `listen EPERM`, so the peer had stripped all code formatting.
2. No way to attach a doc to an issue: only `--project`.

Built in `plugins/ks/scripts/linear-cli.ts`:
- `document create|update --content-file <path>` (`-` = stdin) via the existing `readTextOption`. Inline `--content` keeps its `\n` expansion; file content is sent raw.
- `document create|update --issue KAR-XXX` → `issueId`; `document list --issue KAR-XXX` → `filter.issue.id`. New `requireIssue()` helper wraps `findIssueByIdentifier` and exits with "Issue not found".
- The peer's live test showed Linear gives a doc **one parent**: `update --issue` cleared its project. So `--project` + `--issue` together is now an error (`rejectProjectAndIssue`), and `update --issue` prints a yellow "Moved off project <name>" line. Help text says this.
- Docs: `commands/linear.md` (examples + rule 10), `commands/write-tad.md` (publishes with `--content-file`; ticket workflows use `--issue`), `scripts/README.md` (examples + "A document has one parent" note).

## Key Decisions Made
- Kept `@linear/sdk` at 29.0.0. Its types lack `issueId` / the `issue` filter, but the latest SDK (97.2.0) has both and the live API accepts them. The input objects were already cast to `Record<string, unknown>`, so no SDK upgrade was needed.
- Resolve `KAR-XXX` to a UUID client-side, even though the API accepts identifiers, so a typo fails before any write.
- Refuse `--project` + `--issue` rather than letting one win silently.

## Deviations from Plan
None.

## Uncommitted Changes
None after this session's commit.

## Known Issues
- `document create --issue` has not been run against the live API. Verified live: `update --content-file --issue` (by the peer, on its TAD), `list --issue`, and the error paths.
- The yellow "Moved off project" line has not been seen live (the peer ran its update before it was added).
- `document list` / `get` don't print the doc's issue: SDK 29's `Document` has no `issue` getter.
- The 2026-10-13 Resume Point is still open.

## Resume Point
1. Do the 2026-10-13 handoff's Resume Point (`remove_worktree -D` on KAR-13178, `ks-start-ticket` restore, card ↻).
2. When a ticket next needs a doc: `linear document create --title … --content-file <file> --issue KAR-XXX`, then `linear document list --issue KAR-XXX`.
3. If `document get` should show the doc's issue, upgrade `@linear/sdk`; that is a large version jump, so re-run `npx tsc --noEmit` after it.
