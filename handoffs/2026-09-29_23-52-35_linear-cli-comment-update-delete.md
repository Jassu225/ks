---
date: 2026-09-29T23:52:35+05:30
git_commit: 7f24fd7
branch: main
task: Linear CLI — edit and delete comments
---

# Handoff: Linear CLI Can Edit and Delete Comments

> See docs/product-overview.md for product context, docs/tech-stack.md for dependencies, and CLAUDE.md for dev guidance.

## What Happened

A peer session (KAR-12961) posted a long scope comment on the ticket. The user
then asked it to change one bullet. `linear comment` had only `list` and
`create`, so the only options were a follow-up comment, a duplicate, or a manual
edit in the Linear UI.

Added in `plugins/ks/scripts/linear-cli.ts` (`7f24fd7`):

- `linear comment update <comment-id> <body>` — `client.updateComment(id, { body })`
  (GraphQL `commentUpdate`); replaces the whole body. Prints `✓ Updated comment <id>`
  plus the permalink; `--json` gives `{ success, id, url, editedAt }`.
- `linear comment delete <comment-id>` — `client.deleteComment(id)`.
- `linear document comment update|delete` — the same handlers, wired for parity.
- Human-readable `comment list` and `document comment list` now print each
  comment's id (dim, after the date). `--json` already returned `id`.

Docs: `commands/linear.md` (Comments, Documents, guideline #7: edit instead of
reposting) and `scripts/README.md` (examples, plus a note that `update|delete`
take a comment id and so work on either kind of comment).

Verification: `tsc --noEmit` clean; both `--help` trees show the new commands.
This session could not reach the live API (the sandbox denies reads of `.env`,
so `LINEAR_API_KEY` is unset). The peer session confirmed `comment update`
against the live API: it edited comment `d6909090-4d01-44d3-8907-214b9fb5a2e7`
on KAR-12961, and `comment list --json` returned `id` and `body`.

## Key Decisions Made

- **One handler pair for both surfaces.** A Linear comment id is global
  (`commentUpdate`/`commentDelete` take only the id), so there is no separate
  document-comment mutation. `document comment update|delete` exist only so the
  command can be found from `document comment --help`.
- **`update` replaces the body; no patch/append mode.** The edit flow is: read
  the body from `comment list --json`, change it, send the full new body.
- **No confirmation prompt on `delete`.** It matches `attachment delete` and
  `document delete`, and the CLI is driven non-interactively by agents.

## Deviations from Plan

None. The peer's suggestion to expose ids in `comment list --json` was already
in place; ids were added to the human output instead.

## Uncommitted Changes

None. `7f24fd7` (feature) and this handoff, pushed to `jassu` then force-pushed
to `origin`.

## Known Issues

- `delete` (both surfaces) and `document comment update` have not been run
  against the live API. They use the same SDK client as the verified `update`.
- `update` can edit only comments the API key's user may edit (normally their
  own). Linear's error is printed as `Failed to update comment <id>: ...`.
- Carried over, still open: `ks-start-project.ts` still recreates its
  `state.yaml` unconditionally (`:523`); `RELEASES.md` untouched since
  2026-04-01; `quality-lint.sh` fails with `ERR_PNPM_RECURSIVE_EXEC_NO_PACKAGE`.
  See `2026-09-23_15-03-11_restart-ticket-keeps-state-and-worktree.md`.

## Resume Point

Nothing is blocked. The next fix, deferred twice, is state preservation in
`plugins/ks/scripts/ks-start-project.ts` (`:523`). Mirror
`loadExistingState` / `mergeWithExistingState` from `ks-start-ticket.ts`, with
Linear owning the `project:` block, and prefer the worktree's `state.yaml` when
the worktree is live.

To test delete on a throwaway comment (run outside the sandbox, or with `!`):

```bash
linear comment create KAR-XXXX "scratch" --json   # → id
linear comment delete <id>
```
