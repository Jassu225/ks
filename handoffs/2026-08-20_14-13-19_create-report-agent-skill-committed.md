---
date: 2026-08-20T14:13:19+0530
git_commit: e085bc8
branch: feat/ks-flow-plugin
task: Commit the create-report-agent skill, refresh it against the KAR-12687 work that continued after it was written (TRC v22 + BJA STOP v06), add it to the plugin docs
---

# Handoff: `create-report-agent` skill committed and de-staled

> Repo guidance: `CLAUDE.md`. Prior handoff: `2026-08-07_13-09-04_slack-cli-usergroups-and-mention-encoding.md`.
> The grant work this skill generalises lives in the **KarmaSuite** repo, worktree
> `~/karmasuite/karmasuite-worktree/jaswanth/kar-12687-create-report-agent-for-trc-in-ncst`, under
> `workflow/jaswanth/tickets/kar-12687/resources/` — its own handoffs are the authority on the agents themselves.

## What Happened

### 1. Found the session's actual open item
Tree was clean except one untracked directory carried since **Aug 18**: `plugins/ks/skills/create-report-agent/`
(`SKILL.md` + four references — `question-checklist.md`, `ruleset-anatomy.md`, `iteration-protocol.md`,
`failure-catalog.md`). Content complete; never committed, never documented.

The Slack resume point from the 08-07 handoff (live-verify `@mention` encoding) is **still open** — untouched
this session.

### 2. The skill was one session stale
It was written on Aug 18 *during* KAR-12687 and cites that project as its worked example. The grant work then
ran another day and a half (KarmaSuite handoff `2026-08-19_22-50-38_bja-stop-v06-complete-both-agents-live.md`):
TRC reached **v22**, was saved and replay-validated at zero drift, and a **second agent shipped** — `XLSX - BJA
STOP Quarterly FFR Reconciliation`, fund 9157, ruleset **v06**, 95.66 % on an agent-touched-cells denominator.
Both live in prod. Fixes applied:

- **`v20` → `v22` pointers** (`SKILL.md` ×2, `ruleset-anatomy.md` ×1) and the quarterly sibling (`bja-stop/` v06)
  named as an alternate model, so the skill offers a monthly AND a quarterly example. Recorded that agent #2 took
  6 versions where agent #1 took 22 — the compression is the skill's justification. Clarified the resources path
  is in the KarmaSuite repo, not this one.
- **Phase 5 save step**: every "Download & save as agent" creates a NEW agent card under the SAME display name →
  indistinguishable gallery duplicates. Rename with a `- vNN` suffix and archive the superseded card in the same
  breath as the save; close/reopen to confirm the re-pasted prompt persisted.
- **`failure-catalog.md` — four traps earned Aug 19**:
  - *Shared-formula misread* (scoring): `<f t="shared" si=…/>` with EMPTY text **is** a formula; a text-based
    classifier calls it a literal. Produced a phantom "38 literal→formula" regression chased across 3 runs and
    4 fix attempts by two agents. Compare `<f>` node presence/counts, never `f.text`.
  - *Sibling-agent memory seeding a rule override* (runtime): a same-org invoice agent's fund-record sourcing beat
    the pinned routing table for an entire run; §1a's generic "memory is not a source" demotion did **not** hold.
    Countermeasure: renounce the specific wrong source BY NAME.
  - *Duplicate agent cards* (infra) — as above.
  - *Code-sandbox outage mid-run* (infra): survivable, not fatal — the agent checkpoints, refuses to fabricate,
    re-queries. Budget wall-clock: 81–114 min threads.
- **`iteration-protocol.md` scoring**: name the denominator convention beside every score. BJA moved to
  agent-touched-cells while TRC used a union denominator, so the two campaigns' similar-looking percentages are
  not comparable — including against your own earlier runs.

### 3. Docs
`CLAUDE.md` (tree comment + Skills table) and `plugins/ks/README.md` "Current skills" listed only
`add-page-ai-chat`; both now list `create-report-agent`.

## Key Decisions Made
- **Refresh the skill before committing it**, rather than committing the Aug 18 snapshot and fixing it later — the
  stale `v20` pointers would have sent the next reader at a superseded ruleset, and the four traps were the most
  expensive lessons of the session that produced them.
- **Left the TRC-specific tooling pointer alone.** `iteration-protocol.md` §Scoring points only at TRC's
  `tooling/`; BJA has its own `bja-stop/tooling/scoreRun.py`. Pattern names (`verify.py`, `cellDiff.py`) matter
  more than paths, so the second path was not added.
- Skill kept as **configuration guidance only** — it describes building a `report_agent` row's `agentContext`, no
  repo changes, matching how both agents were actually shipped.

## Uncommitted Changes
None.

## Known Issues
- **Slack `@mention` encoding still never live-verified** (carried from 08-07). Regex passed 9 offline cases; no
  message ever posted. Resume step 1 below.
- The skill's worked-example paths resolve only inside the KAR-12687 **worktree** —
  `~/karmasuite/karmasuite/workflow/jaswanth/tickets/kar-12687/` holds just `state.yaml`. A reader on the
  KarmaSuite main branch will find the pointers dead until that branch merges.
- KAR-12687's own carry-overs (not this repo's): PR #6498 open/unmerged with `/code-review` unrun; BJA v05 agent
  `aa9212b4` still shares a display name with v06 `2208f324` (rename/archive pending); four questions blocking
  BJA v07 §8 sit with Kat.
- `plugins/ks/scripts/dist/` is gitignored — consumers still need `npm run build` in `plugins/ks/scripts/` (or
  `./init`) for the Aug 7 Slack CLI commands.

## Resume Point
1. **Live-verify Slack mention encoding** (oldest open item, ~2 min):
   `slack message send <test-channel> "@engineers ping test, cc @Jaswanth"` unsandboxed, then
   `slack channel history <test-channel> --limit 1 --json | jq -r '.[0].text'` and confirm the raw text holds
   `<!subteam^S06UD9DDCBV|@engineers>` and `<@U09FZ1QJ7F1>`.
2. Consider whether `create-report-agent` should gain a short "second agent in the same org" section — the BJA
   run proved sibling agents' memories interfere, which is a *fleet* concern the skill only mentions as a trap.
3. Branch `feat/ks-flow-plugin` is long-lived and now synced on both remotes (`origin` = karmasuite/ks,
   `jassu` = Jassu225/ks). Eventual PR to `main` via `/ks:create_pr`.
