---
date: 2026-04-17T15:30:00+05:30
git_commit: 3440a6a
branch: main
task: Statusline rate limit color: raw pct → projected usage at reset
---

# Handoff: Statusline Rate-Based Color Coding

> See CLAUDE.md for dev guidance.

## What Happened

Reworked color logic in `plugins/ks/scripts/statusline` for 5h and 7d rate limit segments. Previously colored by raw `used_percentage` (green <50, yellow 50–79, red ≥80). Now colors by **projected usage at reset** — linear extrapolation of current rate vs time elapsed in the window.

### Formula

```
pct_elapsed = (window_seconds - (reset_epoch - now)) / window_seconds * 100
projected   = pct_used * 100 / pct_elapsed
```

Thresholds on `projected`:
- `≥ 100` → red (167)
- `≥ 80`  → yellow (220)
- `< 80`  → green (114)

### Signature change

`usage_color` now takes 3 args: `pct`, `reset_epoch`, `window_seconds`. Call sites:
- 5h: `usage_color "$five_h_pct" "$five_h_reset" 18000`
- 7d: `usage_color "$seven_d_pct" "$seven_d_reset" 604800`

### Fallbacks

Falls back to old raw-pct thresholds (50/80) when:
- reset_epoch or window_seconds missing/invalid
- time_elapsed ≤ 0 (just reset, clock skew)
- pct_elapsed < 10 (early-window projection too noisy; 5% used in 1% elapsed would project 500%)

## Key Decisions Made

- **Projection over raw pct** — user explicit ask: color by consumption rate vs time left, not absolute percent. Catches "burning too fast early" and "almost safe late" that raw thresholds flatten.
- **10% elapsed guard** — projection unstable at window start. Early window uses legacy raw thresholds so status doesn't flicker red at startup.
- **Bash integer math** — no bc/awk. `projected = int_pct * 100 / pct_elapsed` stays int-safe since inputs are already percents.
- **Window constants inline at call sites** — 18000 (5h) and 604800 (7d) passed as literals. Easier to grok than a lookup.

## Deviations from Plan
None — feature landed on the first iteration. No plan doc; direct request.

## Uncommitted Changes

Session touched only `plugins/ks/scripts/statusline` (+35/−6 lines).

Other pre-existing dirty working tree (carried from prior handoff):
- Modified: `plugins/ks/.claude-plugin/plugin.json`, `plugins/ks/hooks/hooks.json`, `plugins/ks/init`, `plugins/ks/rules/ks-rules.md`
- Untracked: `plugins/ks/.mcp.json`, `plugins/ks/commands/{debug-issue,explore-codebase,refactor-safely,review-changes}.md`, `plugins/ks/scripts/crg`, `handoffs/2026-04-17_14-00-00_crg-install-wiring.md`

## Known Issues

- `five_hour` and `seven_day` window durations are hardcoded (18000, 604800). If API ever exposes window length, switch to that. Not worth abstracting yet.
- 10% elapsed cutoff is a guess. If user reports flicker or false-red at window start, raise to 15–20%.
- Carry-overs from prior handoff still open: `plugins/ks/servers/` empty, Phase 5 prototype gap, pipx-inject re-runs on every `init`.

## Resume Point

1. Smoke-verified on synthetic stdin (4 cases: red, green, yellow, early-window fallback). Observe live for one real 5h cycle before committing to confirm color transitions feel right.
2. Decide commit scope: statusline change alone is self-contained and safe to commit standalone. Prior handoff already flagged a bundle-vs-split decision for init/crg changes; this change can ride either way.
3. If a commit is wanted now:
   ```
   git add plugins/ks/scripts/statusline
   git commit -m "feat: color statusline rate limits by projected usage at reset"
   ```
4. Revisit prior-handoff open items: crg end-to-end (already verified), Phase 5 prototype gap, empty `plugins/ks/servers/` dir.
