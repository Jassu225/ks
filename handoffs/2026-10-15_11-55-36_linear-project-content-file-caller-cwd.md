---
date: 2026-10-15T11:55:36+05:30
git_commit: 6171c60
branch: main
task: linear project edit --content-file/--description-file; CLI wrappers resolve relative paths from the caller's cwd; document update --json reports the updated doc
---

# Handoff: linear project edit --content-file, caller-cwd paths

> See CLAUDE.md for dev guidance; plugins/ks/scripts/README.md ("Relative paths are the caller's") and plugins/ks/RELEASES.md (2026-10-15) describe the behaviour below.

## What Happened

The KAR-12961 session sent three Linear CLI requests:

1. **`project edit` had no file input.** It blocked a project description containing `"` and `'`. Added `--content-file` and `--description-file` (`-` = stdin) through the existing `readTextOption`. The inline forms keep their `\n` expansion, and inline + file for the same field is an error. `commands/add-product-requirements.md` used to pass the whole PRD inline; it now passes `--content-file <workflow-dir>/resources/prd.md`.
2. **Relative `--content-file` failed with ENOENT.** The `linear`, `slack` and `grain` wrappers `cd "$SCRIPT_DIR"` so `npx tsx` resolves, so relative paths resolved against `scripts/`. The same bug hit `slack … -f` and grain's `-o`/`--out`/`-d`/`upload <file>`, and grain's default `grain-<id>.<ext>` landed in `scripts/`. Fix: each wrapper exports `KS_ORIGINAL_DIR="$PWD"`, the convention `ks-start-ticket` already uses, and each CLI calls the new `restoreCallerCwd()` (`scripts/lib/env.ts`) right after `loadEnv()`. `.env` was already loaded by absolute path, so nothing depended on the cwd being `scripts/`.
3. **`document update --json` reported the old title.** It printed the document as read before the mutation. It now uses `payload.document` from `client.updateDocument` (falling back to the pre-read copy) and also outputs `url`.

Verified:
- `tsc --noEmit` passes.
- From the repo root, `linear project edit <fake project> --content-file CLAUDE.md` read the file and stopped at "Project not found". The two error paths and `--help` behave as expected.
- `slack template list` and `grain --version` still work.
- KAR-12961 confirmed live: `project edit --content-file <relative>` ran twice on its project, and the quotes survived (checked with `project get`).

## Key Decisions Made
- Fixed the cwd bug once, at the wrapper/CLI entry with `chdir`, instead of resolving each path flag separately. That covers every current and future path option across all three CLIs, defaults included.
- Kept `restoreCallerCwd()` separate from `loadEnv()`. `ks-start-ticket`/`ks-start-project` also call `loadEnv()` and handle `KS_ORIGINAL_DIR` themselves.

## Deviations from Plan
The request named only `document create`. The fix was extended to `slack` and `grain` because they have the same root cause.

## Uncommitted Changes
None after this session's commit.

## Known Issues
- The `document update --json` fix has not been run against the live API.
- `slack -f <relative>` and grain's relative `-o` have not been run live. They share the verified mechanism.
- Still open from earlier handoffs:
  - `handoffs/2026-10-14_20-05-14_claude-ks-session-name-at-launch.md`: confirm a fresh `claude-ks` session registers as `KAR-XXX`.
  - The 2026-10-13 worktree/restore tests.
  - The linear-document items from 2026-10-14.

## Resume Point
1. Start a fresh ticket session with `claude-ks` (no `-c`), then run `jq '{name,nameSource}' ~/.claude/sessions/*.json` from another session. Expect `KAR-XXX` / `user`.
2. On the next document edit, check `linear document update <id> --title New --json` shows the new title and url.
3. Then go through the older Resume Points (2026-10-13 and 2026-10-14 handoffs).
