---
date: 2026-08-21T15:25:33+05:30
git_commit: 50ac98b
branch: main
task: Show the peer-addressable session name in the ks statusline
---

# Handoff: Statusline now shows the peer-addressable session name

> See CLAUDE.md for dev guidance. Predecessor (unrelated work, now merged):
> `handoffs/2026-08-21_14-55-03_grain-cli-shipped.md`.

## What Happened

With several interactive sessions open at once, there was no way to tell a peer *which*
session to message — `SendMessage` takes a name, and a session could not see its own. The
statusline now prints it.

`plugins/ks/scripts/statusline` gained one block: read `.session_id` from the payload, then
`jq` across `~/.claude/sessions/*.json` for the file whose `.sessionId` matches and take its
`.name`. Rendered as blue `@<name>` at the head of line 1:

```
@ks-ad | 65k/1000k (6%) |  main | 5h: 11%/35%(3h 12m) 7d: 72%/98%(3h 12m)
```

The line-2 wrap threshold, which existed for long branch names, now measures
`${#git_branch} + ${#peer_name}` instead of the branch alone — the name eats the same budget.

Verified by capturing a real statusline payload (temporarily teeing stdin to a file, then
reverting with `git checkout --`) and running the script against it three ways: registry
match, `session_id` with no registry match, and `session_id` deleted from the payload. The
prefix appears in the first case and is omitted cleanly in the other two; everything to the
right of it is byte-identical across all three.

Root `README.md`'s Statusline section documents both the field and the distinction below.

## Key Decisions Made

- **Read the session registry, not the payload's `session_name`.** The payload does carry a
  `session_name`, but it is the auto-generated conversation title — this session's was
  "Resume project work". The registry `name` (`ks-ad`) is what `ListAgents` prints and
  `SendMessage` accepts, which is the whole point of showing it. Falling back to the title
  when the registry lookup misses was rejected: it would render an unaddressable string in an
  address-shaped slot.
- **Read it live on every render** rather than caching. `nameSource` is `"derived"` in the
  registry, implying a name can be set, so a rename should show up immediately. The cost is
  one extra `jq` in a script that already runs six.
- **No entry in `plugins/ks/RELEASES.md`.** That file's newest section is 2026-04-01 and it
  records neither the grain CLI nor the ks-flow plugin — it is dormant, and one line would not
  revive it. Root `README.md` is the live doc.
- **Landed on `main` directly.** The work was first committed on a
  `feat/statusline-session-name` branch per the default-branch rule, but the user asked for it
  on `main` instead; it was fast-forwarded in, pushed to both remotes, and the branch deleted.
  No PR, no review — a self-contained change to the user's own statusline.

## Deviations from Plan

None.

## Uncommitted Changes

None — `plugins/ks/scripts/statusline`, `README.md`, and this handoff are committed on `main`.

## Known Issues

- **Derived names are opaque.** `ks-ad` is `<cwd basename>-<2 chars>`, so three sessions in
  one repo read as `ks-ad`, `ks-7f`, `ks-c2` — distinguishable, not memorable. If Claude Code
  exposes a rename, setting real names would make the statusline far more useful; the script
  needs no change for that.
- **The registry glob is unbounded.** `~/.claude/sessions/*.json` held 4 live entries here.
  Stale files are cleaned up by Claude Code, not by us, so a large directory would slow every
  render. Unmeasured.
- **Untested against a non-interactive session** (`kind` other than `"interactive"`), and
  against a session whose registry file is missing while `session_id` is present — that second
  case is covered by the no-match test, which is the same code path.

## Resume Point

1. Nothing is pending on the git side. This landed on `main` directly at the user's
   instruction (no PR, no review), was pushed to both `origin` and `jassu`, and the
   short-lived `feat/statusline-session-name` branch was deleted locally and from both
   remotes.
2. **Look at the bar in a real session** to confirm the color reads well against the existing
   lavender/teal, and that the wrap threshold still breaks at the right place. On `main` the
   prefix costs 4 + 5 = 9 of the 32-char budget, well clear; check it on a long branch
   (`jaswanth-kar-12653-award-amount…` + `ks-ad` blows past 32 and should wrap).
3. Grain CLI resume items from the predecessor handoff are still open and untouched: file the
   two upstream crv issues, verify `--crop-in-grid` on a 1920-wide recording, settle the three
   untested paths with concurrent watches, and decide `feat/grain-video-vision`'s fate.
