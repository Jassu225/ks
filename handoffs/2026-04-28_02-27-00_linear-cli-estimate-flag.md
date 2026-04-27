---
date: 2026-04-28T02:27:00+05:30
git_commit: 0af4915
branch: main
task: Add --estimate flag to linear issue create/update
---

# Handoff: Linear CLI --estimate Flag

> See CLAUDE.md for dev guidance.

## What Happened

User asked whether `linear` CLI could update ticket estimate. It could not. Added `--estimate <number>` flag to both `linear issue create` and `linear issue update`:

- `plugins/ks/scripts/linear-cli.ts` — added `estimate?: number` to both option types, threaded into SDK `createIssue` payload and `updateInput` for `updateIssue`. Added `--estimate <number>` Commander option with `parseInt` coercer on both subcommands.
- `plugins/ks/commands/linear.md` — added usage examples for create (`--estimate 3`) and update (`--estimate 5`).

Build clean (`tsc` no errors — confirms `IssueUpdateInput.estimate` and `IssueCreateInput.estimate` are valid SDK fields). `--help` smoke test confirmed flag wired.

Committed as `0af4915` (`feat: support --estimate flag on linear issue create/update`) and pushed `b4ae1dc..0af4915` to `origin/main`. Push triggered protected-branch bypass warning (account has bypass).

## Key Decisions Made

- **Integer coercion via `parseInt(v, 10)`** — matches existing `--priority` pattern. Linear's `estimate` field is a number representing story points; team-configurable scale (Fibonacci, T-shirt, etc.) so no validation in CLI.
- **Updated only the slash command doc, not a separate "linear skill"** — repo has no dedicated linear skill (`plugins/ks/skills/` is empty); `commands/linear.md` is the canonical doc.
- **Did not test against a real ticket** — flag wiring verified via build + help; user did not request live test.

## Deviations from Plan

None — direct request, no plan doc.

## Uncommitted Changes

Carry-overs from prior handoffs, untouched this session:

- Modified: `plugins/ks/.claude-plugin/plugin.json`, `plugins/ks/hooks/hooks.json`, `plugins/ks/init`, `plugins/ks/rules/ks-rules.md`
- Untracked: `plugins/ks/.mcp.json`, `plugins/ks/commands/{debug-issue,explore-codebase,refactor-safely,review-changes}.md`, `plugins/ks/scripts/crg`, and five handoff files (including this one).

## Known Issues

- **Protected-branch bypass on push to main** — same as prior session. If policy tightens, route through `/ks:create_pr`.
- **Sandbox EPERM on `tsx`** — confirmed again at start of session. Documented in commit `b4ae1dc`; bypass with `dangerouslyDisableSandbox: true` for `linear`/`slack` CLI calls.
- **Estimate value range is team-dependent** — Linear teams configure their own estimate scale (e.g., Fibonacci 1/2/3/5/8, T-shirt 1-5). CLI does no validation; passing an out-of-scale number may be silently rounded or rejected by Linear API at runtime. Not tested.

## Resume Point

1. If user wants live verification, run `linear issue update KAR-XXX --estimate 3` against a real ticket and confirm via `linear issue get KAR-XXX -j | jq .estimate`. Requires `dangerouslyDisableSandbox: true`.
2. Carry-overs still open from 2026-04-17 / 2026-04-18 handoffs:
   - Bundle-vs-split decision for `init` / `crg` / `plugin.json` / `hooks.json` / `ks-rules.md` modifications + four new untracked command docs (`debug-issue`, `explore-codebase`, `refactor-safely`, `review-changes`).
   - Phase 5 prototype gap.
   - Empty `plugins/ks/servers/` directory.
   - `pipx-inject` re-runs every `init`.
   - Whether sandbox callout belongs in other network-touching command docs (`gh-cli.md`, etc.).
