---
date: 2026-11-02T12:19:24+05:30
git_commit: e09f80c
branch: main
task: Workflow reads and writes the ks-docs knowledge base (Phase 2 read, Phase 10 substep)
---

# Handoff: ks-docs in the workflow; Briefing/master work committed

> See CLAUDE.md ("ks-docs (knowledge base)" under Critical Rules) and plugins/ks/RELEASES.md (2026-11-02). Previous handoff: 2026-10-31_13-10-48_ksflow-done-column-guard-removed-next-needs-you.md (the "Needs you" page discussion is still open there).

## What Happened
- **Everything uncommitted on main was committed and pushed** (jassu first, then force-pushed to origin):
  - `2b9fccb` fix(ks): `create-worktree` deletes only git-tracked `.claude` files (keeping `agents/test-writer.md`) and copies the main checkout's gitignored `.claude/settings.local.json` into new worktrees. The ks-master session wrote this change. That file grants KarmaSuite sessions sandbox write access to `~/git/ks-docs`.
  - `7780ca7` feat(ks-flow): Briefing, Activity Log and the ks-master session, 85 files of work from other sessions. ks-flow's `npm test` passed (74) before the commit.
- **ks-docs**: `~/git/ks-docs` (GitHub Jassu225/ks-docs, private) is KarmaSuite's shared knowledge base in the Open Knowledge Format v0.2. Knowledge lives in `content/`; the agent rules are in its `CLAUDE.md`. Agents write; a person reviews, sets `verified: human:...` and commits.
- **`e09f80c` feat(ks): the workflow reads and writes ks-docs**:
  - `commands/research_codebase.md`: Initial Setup step 3a reads `content/index.md`, the relevant area indexes and matching concepts. The concepts go to the research agents as leads to confirm in code, never as findings. Phase 2 never writes to ks-docs.
  - `commands/implement-plan.md`: Post-Implementation step 3 "Update ks-docs" runs for both ticket and project workflows, after code review and before the congratulations. A new `### Update ks-docs` section:
    1. Checks that `content/index.md` exists (otherwise `unavailable`) and that `git status --porcelain -- content` is empty (otherwise `skipped`, listing the files for the user).
    2. Spawns the `ks-docs-writer` subagent with the plan, the research, the diff and the PRs. It follows ks-docs' `CLAUDE.md`, cites sources pinned to the PR's head commit, and may write nothing.
    3. Hands the review to the user.
    4. Records `docs: {status, files, note, at}` on Phase 10's current iteration in `state.yaml`.
  - `commands/project-manager.md`: Phase 10 describes the substep. Bookkeeping runs it when `docs` is missing, before marking COMPLETED. The `state.yaml` example shows `docs`.
  - `CLAUDE.md` gets a "ks-docs (knowledge base)" critical rule; `RELEASES.md` gets a 2026-11-02 entry, which also covers the create-worktree fix.
- **ks-docs `CLAUDE.md`**: ks-master edited it at our request, with the user's OK. It is **uncommitted in ks-docs**: a new section "## Before writing: no unreviewed changes" (`git status --porcelain -- content`; edits to the tooling don't block), and "After writing" step 3 points to it.

## Key Decisions Made
- **A substep, not Phase 11.** `TERMINAL_PHASE = 10` in ks-flow `phasemodel.ts`, the statusline's `FRESH_SESSION_PHASES`, the phase lists in `ks-start-ticket` and every existing `state.yaml` all assume 10 phases. The step also iterates with Phase 10 and needs no fresh session.
- **The "no unreviewed changes" rule lives in ks-docs' `CLAUDE.md`**, so it covers every writer. The workflow step only pre-checks it, so it can record `skipped` and avoid spawning a subagent for nothing.
- **Only `content/` counts** for the check, so the user's own edits to the tooling don't block agents.
- **The ks-docs path is hard-coded as `~/git/ks-docs`.** When it's missing the step records `unavailable`. There is no config key.
- New `state.yaml` field `docs` on Phase 10 iterations. ks-flow's `stateyaml.ts` and the ks pane ignore unknown iteration keys; checked in `stateyaml.ts`.

## Deviations from Plan
None.

## Uncommitted Changes
- This repo: none (this handoff is committed with this push).
- `~/git/ks-docs/CLAUDE.md` (the rule above), for the user to review and commit.

## Known Issues
- **Not yet run on a real ticket.** The first Phase 10 that reaches "Update ks-docs" is the test.
- **Possible permission prompts:** `settings.local.json` lets Bash write to `~/git/ks-docs`, but the subagent's Write and Edit tools follow normal permissions. Unless the karmasuite session runs in bypass mode or lists `~/git/ks-docs` in `additionalDirectories`, each file may prompt.
- **Race:** two sessions that both check before either writes can both write. The next check catches the leftovers.
- This session's sandbox can't write `~/git/ks-docs`; ks-master can, and needs the user's OK in its own session for edits to the agent rules there.
- Pushing to origin `main` bypasses its PR rule (as on every push in this repo).

## Resume Point
1. If a ticket has reached Phase 10 since then, check its `state.yaml` for `docs` on the last Phase 10 iteration and look at what landed in `~/git/ks-docs/content/`. Fix the writer prompt in `implement-plan.md` ("Update ks-docs") if its output breaks the ks-docs rules. If Write/Edit prompted on each file, suggest adding `~/git/ks-docs` to the karmasuite checkout's `additionalDirectories`.
2. Otherwise continue the open discussion from the previous handoff: the "Needs you" page and its sources, and whether to poll from the daemon or only while the page is open.
