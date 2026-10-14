---
date: 2026-10-14T20:05:14+05:30
git_commit: 22859b2
branch: main
task: claude-ks names ticket sessions KAR-XXX at launch (--name), since the SessionStart sessionTitle never reached the live peer name
---

# Handoff: claude-ks session name at launch

> See CLAUDE.md for dev guidance; plugins/ks/README.md (session name paragraph) and plugins/ks/scripts/README.md (`session-title.sh`) describe the behaviour below.

## What Happened

The user saw new ticket sessions listed in ListAgents under long names like `kar-13089-add-fund-dd-filters-to-query-p-ca`, though `scripts/session-title.sh` returns `sessionTitle: KAR-13089`.

What we found:
- A session has two names. The **transcript title** (`custom-title` / `agentName` entries in the JSONL) and the **peer name** in `~/.claude/sessions/<pid>.json` (`name`, `nameSource`, `nameSince`), which is what ListAgents prints and SendMessage `to:` takes.
- The peer name is fixed at startup. It is either a title already saved in the transcript (`nameSource: user`) or derived from the folder: the cwd basename cut to 40 characters, plus `-` and two hex characters (`nameSource: derived`).
- The hook's `sessionTitle` and `/rename` reach only the transcript, so a new session kept its derived name until resumed. Observed live: 12961 got its name after the user renamed it, quit and reopened it; 13089 got `KAR-13089` after quit + `--continue`; kar-12930 still shows its derived name despite 68 title entries. Only the name changes on resume; the session ID stays the same.
- The docs (code.claude.com sessions, cross-session-messaging, hooks) say `sessionTitle` "has the same effect as `/rename`" and that a session answers to its `/rename`/`--name` name. They don't document the registry or say that the live name only updates on restart. That looks like a Claude Code bug or a gap in the docs.

Built:
- `scripts/session-title.sh --print` prints the bare title. Without the flag it is still the hook, unchanged.
- `scripts/claude-ks` passes `--name "$(session-title.sh --print)"` unless the caller passes `-n`/`--name`/`--name=*`, `-r`/`--resume`/`--resume=*` or `-c`/`--continue`. Outside a workflow checkout no name is passed.
- Docs: `plugins/ks/README.md`, `plugins/ks/scripts/README.md`, `plugins/ks/RELEASES.md` (2026-10-14 entry).

## Key Decisions Made
- Name at launch with the documented `--name` flag rather than patching `~/.claude/sessions/*.json`. That registry is undocumented, outside the sandbox, and owned by Claude Code.
- Kept the hook. It still titles the transcript, which then names the session on resume and covers sessions started with plain `claude`.
- Resumed sessions get no `--name`. They already come back with their saved title, and `--name` could overwrite a name the user chose.

## Deviations from Plan
None.

## Uncommitted Changes
None after this session's commit.

## Known Issues
- The `--name` path has not been seen in a real session. It was tested only with a stand-in `claude` that prints its arguments (named ticket worktree → `--name KAR-13089`; `--name foo`, `--resume`, `-c`, a non-workflow repo → no added name). Not confirmed: that `--name` writes `nameSource: user` into the registry at startup.
- kar-12930's running session keeps its derived name until it is resumed.
- The 2026-10-13 Resume Point (`remove_worktree`, the `ks-start-ticket` restore, card ↻) is still open, along with the 2026-10-14 linear-document items.

## Resume Point
1. Start a brand-new ticket session with plain `claude-ks` (no `-c`, or via `ks-start-ticket`). Then, from another session: `jq '{name,nameSource}' ~/.claude/sessions/*.json`. Expect `KAR-XXX` / `user` right away. If it is still derived, `--name` doesn't set the peer name either; report it to Claude Code with the evidence above.
2. Then pick up the open items from `handoffs/2026-10-14_18-02-55_linear-document-content-file-and-issue.md`.
