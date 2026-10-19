---
date: 2026-10-19T19:14:38+05:30
git_commit: 5ec14b0
branch: main
task: /ks:linear rules and `issue update --help` point agents to bulk-update / batch-get (5ec14b0)
---

# Handoff: Linear agents pick bulk-update

> See CLAUDE.md for dev guidance. `plugins/ks/RELEASES.md` (2026-10-19), `plugins/ks/commands/linear.md` (Workflow rules 1, 5, 6) and `plugins/ks/scripts/README.md` (lines ~114-115) describe the behaviour below.

## What Happened
- A peer session (karmasuite-86) moved 46 tickets to the next cycle with one `linear issue update --cycle next` per ticket. `linear issue bulk-update` (one issueBatchUpdate request) was the right tool. The peer found two gaps in the docs and CLI that led it there, and the user asked it to explain them to this session.
- Fixed both:
  - `commands/linear.md` Workflow rules:
    - Rule 1: read many issues with `batch-get`.
    - Rule 5: for the same `--cycle`/`--state`/`--assignee`/`--priority` on several issues, use one `bulk-update` call. Run `--dry-run` first; at most 50 issues, one team for `--cycle`/`--state`.
    - Rule 6: cycle moves point to `bulk-update`. It sends no `sortOrder`, so per-issue `update` is only for when the order has to change.
  - `scripts/linear-cli.ts`: the `issue update` description now ends "(the same --cycle/--state/--assignee/--priority on many issues: use bulk-update)". `npm run build` rebuilt it (dist is untracked), and `issue update --help` shows it.
  - RELEASES.md bullet under 2026-10-19. The scripts README already documented both commands, so it needed no change.
- The peer was told about the fix.
- Resume point 1 of the previous handoff (ks-flow rebuild check) is marked done at the user's call; they rebuilt ks-flow themselves. See Known Issues for what this session saw.

## Key Decisions Made
- Put the bulk guidance in the Workflow rules, which agents follow, not only in the Quick Reference "Bulk" block, which they skip.
- Did not add a `bootstrap.sh` fallback to `project.conf`. It was proposed, but not taken up.

## Deviations from Plan
None.

## Uncommitted Changes
None after this handoff's commit.

## Known Issues
- At 19:14 IST the installed ks-flow daemon copy was dated 13 Oct 19:42:
  - Path: `~/.claude/plugins/data/ks-flow/-Users-jassu-karmasuite-karmasuite--git/daemon/dist/transcript-restore.js`.
  - It has no `--workflow-dir needs a path` check, and `ks-flow restore --unit KAR-0 --workflow-dir` fails on the GCS config instead of exiting 2.
  - `project.conf` there is also dated 13 Oct. `scripts/bootstrap.sh` rewrites that file on every run, so the SessionStart bootstrap hasn't run since then. It exits 0 when `CLAUDE_PLUGIN_OPTION_project_path` is unset (lines 16-18).
  - The user said they rebuilt ks-flow and the item is closed. If c9b640b's `--workflow-only`/`--workflow-dir` behaviour looks absent, run `ks-flow start` (it falls back to `project.conf`) and look at the bootstrap gate above.
- Still open from earlier handoffs: the live restore test, the two-part PR review check (2026-10-19), the `document update --json` live check (2026-10-15), the `claude-ks --name` peer-name question (2026-10-14), and the worktree/restore tests (2026-10-13).

## Resume Point
1. The next time an agent changes many Linear issues, check that it uses `linear issue bulk-update ... --dry-run` and then the real call, not a loop of `issue update`.
2. Then carry on with the 2026-10-19_13-41 handoff's resume points 2-4: the live restore test, the two-part PR review, and how the KAR-13089 session was launched.
