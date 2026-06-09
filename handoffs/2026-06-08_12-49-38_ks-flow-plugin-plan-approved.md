---
date: 2026-06-08T12:49:38+05:30
git_commit: 185259a
branch: feat/ks-flow-plugin
task: ks-flow plugin — approved implementation plan copied into plugin docs; build not yet started
---

# Handoff: ks-flow Plugin — Plan Approved, Build Pending

> See CLAUDE.md for dev guidance. Full design lives in `plugins/ks-flow/docs/IMPLEMENTATION_PLAN.md` (the approved plan).

## What Happened

Designed (not yet built) a new Claude Code plugin **`ks-flow`**: a per-project Kanban board over the user's Claude Code sessions + macOS notifications when a session blocks waiting for the user. Went through a long planning conversation; plan was approved via plan mode and saved to `~/.claude/plans/transient-imagining-snowflake.md`, then **copied into the repo at `plugins/ks-flow/docs/IMPLEMENTATION_PLAN.md`** (the only file created this session besides the moved Symphony doc and this handoff).

Key research done and baked into the plan:
- Read official CC docs (hooks, plugins, plugins-reference). Confirmed: plugin hooks at **user scope** fire in every session; `${CLAUDE_PLUGIN_DATA}` is the persistent state dir; `${CLAUDE_PLUGIN_ROOT}` is ephemeral; `bin/` adds to PATH; `userConfig` prompts at enable; `monitors/` are per-session (not used).
- Verified the on-disk JSONL session format empirically (one file/session, append-only, `aiTitle`, `pr-link`, string-vs-array `content`, last-activity = last line *with* a timestamp not mtime, subagents under `<id>/subagents/`).
- Read the ks workflow `state.yaml` model (`plugins/ks/scripts/{ks-start-ticket,ks-start-project}.ts`, `lib/workflow-types.ts`, sample at `~/karmasuite/karmasuite/workflow/jaswanth/tickets/<id>/state.yaml`). Kanban **columns = workflow phases from state.yaml** (project-defined, ticket vs project, mutable) — not hard-coded.

Also moved the unrelated Symphony feasibility doc out of `plugins/ks-flow/` to `docs/symphony-claude-feasibility.md` earlier in the session (untracked).

## Key Decisions Made

- **Per-project scope, not global.** Plugin asks for a `project_path`; tracks only sessions whose cwd's git-common-dir matches the project's (covers all its worktrees). Runtime cwd-filter in both ingester and hook scripts.
- **DB behind a provider-agnostic interface** (`SessionWriter`/`SessionSource`/`DbProvider` + `ProjectDoc`/`WorkUnitDoc`/`SessionDoc`). **Firestore** is the first impl (admin SDK writer in daemon; client SDK `onSnapshot` reader in the board → no SSE/polling). Emulator mode for local-only; cloud for durable archive. `file`/`sqlite` are documented future providers.
- **Columns from `state.yaml` phases** (project-level `phaseModel`, ordered union of phases + type template). Cards = work-units in `currentPhase`. Sessions joined by `worktree_dir`↔cwd; their waiting/activity surface as **badges**, not columns.
- **Always-on launchd daemon**, auto-bootstrapped by a `SessionStart` hook (node_modules diff-install + idempotent launchctl). State in `${CLAUDE_PLUGIN_DATA}`; byte-offset checkpoints local (no per-line cloud writes); writes batched/debounced.
- **Fully plugin-native** setup (no manual `./init`); `terminal-notifier` for notifications, fired directly from hooks (daemon-independent).

## Deviations from Plan

None — plan was approved as written. Build has not started.

## Uncommitted Changes

All untracked (nothing committed this session, on fresh branch `feat/ks-flow-plugin`):
- `plugins/ks-flow/docs/IMPLEMENTATION_PLAN.md` — the approved plan (NEW).
- `docs/symphony-claude-feasibility.md` — moved here from `plugins/ks-flow/` earlier.
- This handoff file.

Note: `plugins/ks/scripts/.env.example` shows "Operation not permitted" in `git status` (sandbox/env-file read denial — pre-existing, unrelated).

## Known Issues

- Browser-exposed Firestore creds in cloud mode → mitigated by owner-only security rules + sensitive userConfig; admin-SDK+SSE fallback noted but deferred.
- `worktree_dir` must be `~`-expanded/realpath'd on both sides before matching session cwd.
- First install can't recover sessions already deleted by the 30-day cleanup (documented limitation).

## Resume Point

Build is **not started**. Task list (TaskList) has 7 tasks, all pending:
1. Scaffold plugin skeleton (`.claude-plugin/plugin.json` w/ userConfig + defaultEnabled:false, `hooks/hooks.json`, README; add `ks-flow` entry to root `.claude-plugin/marketplace.json`).
2. DB provider abstraction + Firestore provider.
3. Ingester daemon core (paths/checkpoints/jsonl/derive/worktree + backfill + chokidar + queue).
4. `state.yaml` ingestion (stateyaml/phasemodel/join).
5. Hook scripts + `bootstrap.sh` + launchd plist + `bin/ks-flow`.
6. Next.js board UI.
7. End-to-end verification with Firestore emulator.

Start with: read `plugins/ks-flow/docs/IMPLEMENTATION_PLAN.md`, then begin Task #1 (scaffold). Mirror conventions from `plugins/ks/scripts/{package.json,tsconfig.json}` and `plugins/ks/scripts/protect-neon-branch.sh` (hook stdin/jq pattern). Validate with `claude plugin validate ./plugins/ks-flow` and test via `claude --plugin-dir ./plugins/ks-flow`.
