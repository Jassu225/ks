---
date: 2026-04-17T14:00:00+05:30
git_commit: 3440a6a
branch: main
task: Wire code-review-graph (crg) script and init installer
---

# Handoff: CRG Script Wiring and Init Installer Chain

> See CLAUDE.md for dev guidance.

## What Happened

User added an untracked `plugins/ks/scripts/crg` bash wrapper that invokes `code-review-graph` with a per-repo `CRG_DATA_DIR`. This session:

1. Made `plugins/ks/scripts/crg` executable (`chmod +x`).
2. Added a `python3` guard at the top of `crg` — exits with an error if `python3` is missing.
3. Extended `plugins/ks/init` with a chained installer for `code-review-graph` + `igraph`:
   - Installs `code-review-graph` via `pipx` if not already installed (`pipx list --short | grep`).
   - On success, installs `igraph` via `brew` if not already installed (`brew list igraph`).
   - On success, runs `pipx inject code-review-graph igraph`.
   - Each step fails soft with a warning so `init` doesn't abort.
   - Warns (and skips the chain) if `pipx` or `brew` is missing.

## Key Decisions Made

- **Chain-gated installs**: `igraph` and inject only run if `code-review-graph` is ready. Ready = already installed OR freshly installed.
- **Skip-if-installed** on both `code-review-graph` and `igraph`, but still run `pipx inject` every time (idempotency left to pipx, which prints a warning if already injected — acceptable).
- **Soft failures**: individual steps warn instead of `exit 1`, so Linear/Slack token setup instructions at the end still print.

## Deviations from Plan
None.

## Uncommitted Changes

Modified:
- `plugins/ks/.claude-plugin/plugin.json`
- `plugins/ks/hooks/hooks.json`
- `plugins/ks/init` (this session added crg/igraph install chain)
- `plugins/ks/rules/ks-rules.md`

Untracked:
- `plugins/ks/.mcp.json`
- `plugins/ks/commands/debug-issue.md`
- `plugins/ks/commands/explore-codebase.md`
- `plugins/ks/commands/refactor-safely.md`
- `plugins/ks/commands/review-changes.md`
- `plugins/ks/scripts/crg` (this session's focus, now executable with python3 guard)

Only the `init` change and `crg` file were touched this session. The other uncommitted files are pre-existing working-tree state.

## Known Issues

- `pipx inject code-review-graph igraph` re-runs every time even when igraph is already injected; pipx prints a warning but it's non-fatal. Could be skipped via `pipx list --include-injected` check if noise becomes a problem.
- Pre-existing from prior handoff: `plugins/ks/servers/` still empty; Phase 5 prototype tooling gap (Claude Code vs web) not yet addressed.

## Resume Point

1. Test `crg` end-to-end inside a git repo: run `crg --help` (or a real invocation) and confirm `$CRG_DATA_DIR` under `~/.code-review-graphs/` gets created with the `<rel-path>`-safe name.
2. Run `plugins/ks/init` (or `init --dev`) on a clean machine to verify the new install chain works: no `pipx` → warn, no `brew` → warn, happy path → all three commands succeed.
3. Decide whether to commit just the `init` + `crg` changes on their own, or bundle with the other uncommitted working-tree files (plugin.json, hooks.json, ks-rules.md, new command files, .mcp.json).
4. Revisit prior-handoff open items: Phase 5 prototype gap, empty `plugins/ks/servers/` dir.
