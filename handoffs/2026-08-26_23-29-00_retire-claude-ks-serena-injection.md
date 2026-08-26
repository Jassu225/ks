---
date: 2026-08-26T23:29:00+05:30
git_commit: 1bcec15
branch: feat/slack-thread-reader
task: Stop injecting Serena via `claude-ks-serena`; point every workflow launch at `claude-ks` and document Serena as a normally registered MCP server
---

# Handoff: `claude-ks-serena` retired — Serena moves to normal MCP registration

> Predecessor: `handoffs/2026-08-26_13-02-48_slack-thread-reader-and-crv-prs.md`. See CLAUDE.md
> for dev guidance.

## What Happened

Docs-and-commands change, no code. The workflow used to tell the user to relaunch with
`claude-ks-serena` at three phase boundaries (1→2, 8→9, 9→10, plus 2→9 on the ticket
workflow), and `WORKFLOW.md` had a three-row table mapping phases to launchers.
`claude-ks-serena` injects Serena with `--mcp-config`:

```sh
exec "$SCRIPT_DIR/claude-ks" "$@" --mcp-config "$SERENA_CONFIG"
```

That never reached the agents it was for. A subagent whose frontmatter declares a
`tools:` list does not receive the session's `--mcp-config` servers, and all three
research agents declare one (`codebase-locator.md:4`, `codebase-analyzer.md:4`,
`codebase-pattern-finder.md:4`, each leading with `mcp__serena__find_symbol,
mcp__serena__find_referencing_symbols, mcp__serena__get_symbols_overview`). So the
semantic phases were paying for a launcher whose server the semantic agents couldn't see.

Every launch reference now says `claude-ks`. Serena is documented as a normally
registered MCP server — the user is registering it that way after this session.

## Key Decisions Made

- **Kept `plugins/ks/scripts/claude-ks-serena` on disk**, per explicit instruction, but
  nothing references it as a thing to run. CLAUDE.md now says "don't wire it into
  anything" and gives the `--mcp-config`/`tools:` reason, so the next reader doesn't
  helpfully restore it.
- **Kept the `mcp__serena__*` entries in the three agents' `tools:` lists.** First
  instinct was to strip them as dead weight; wrong call once Serena is registered
  normally — they resolve then. Explicitly confirmed to keep.
- **Reworded rather than deleted the Serena guidance.** An intermediate version of the
  docs claimed Serena was no longer used at all, which would have gone stale the moment
  it was registered. Final wording separates the two facts: the `--mcp-config` injection
  is retired; Serena itself is present in every session.
- **Dropped `--plugin code-review@claude-plugins-official` from the phase 10 row** while
  collapsing the launcher table. Code review has been built in since PR #2; that row was
  stale independently of Serena.
- **Phase-boundary message wording** changed from "Phase N uses semantic code analysis"
  to "Phase N starts a fresh session" — the semantic-analysis clause only existed to
  justify the different launcher.

## Deviations from Plan

The request named `ks-start-ticket.ts` and `ks-start-project.ts` as needing the change.
They didn't: both go through `createWorktreeAndLaunchClaude` in
`plugins/ks/scripts/lib/worktree.ts:78`, which has spawned `claude-ks` since the
KS_EXTRA_PLUGINS work (see `handoffs/2026-06-17_23-27-18_...`) and never had a Serena
path. Zero script changes; the whole change is markdown.

## Uncommitted Changes

None — five files committed on `feat/slack-thread-reader`:
`CLAUDE.md`, `plugins/ks/WORKFLOW.md`, `plugins/ks/commands/project-manager.md`,
`plugins/ks/rules/ks-rules.md`, `plugins/ks/scripts/README.md`, plus this handoff.

## Known Issues

- **`feat/slack-thread-reader` now carries two unrelated commits** (the Slack thread
  reader from the predecessor session, and this) and still has **no PR**. `origin/main`
  is at `f61d0b8`. Whoever opens the PR needs a Linear ticket for the `Closes KAR-XXX`
  line — neither commit has one.
- **Serena registration itself is the user's next step** and is not in this repo. Until
  it lands in their MCP config, `plugins/ks/rules/ks-rules.md:45` and `CLAUDE.md:157`
  overstate availability ("present in every session"). The fallback sentence covers the
  gap behaviorally, but the docs are ahead of the config by design.
- `~/.claude/settings.json:68` has `"serena@claude-plugins-official": false` — the
  marketplace *plugin* is disabled. Unrelated to registering the MCP server, but worth
  knowing before debugging a missing-Serena session.
- `~/.claude.json` holds `toolUsage` counters for `mcp__serena__*` and
  `mcp__ks-serena__*` from past sessions. Inert stats, not config. Not cleaned up.
- Prose mentions of Serena remain in `plugins/ks/commands/research_codebase.md:57`,
  `create_plan.md:120`, `skills/add-page-ai-chat/SKILL.md:54`, and the three agents'
  "When Serena is available" lines. All still true under normal registration; left alone.
- Historical mentions in `plugins/ks/RELEASES.md`, `plugins/ks/thoughts/`, and
  `docs/symphony-claude-feasibility.md` are records of past state, deliberately untouched.
- **The four crv threads are still unanswered** (checked at the top of this session:
  #19/#20/#22 open with zero comments, PRs #21/#23/#24 open with zero reviews). The
  head-clip removal in `grain-cli.ts` stays gated on #21. Nothing is polling.

## Resume Point

1. **Register Serena as an MCP server** (user's step), then confirm a research agent
   actually gets the tools — spawn `ks:codebase-locator` and check it can call
   `mcp__serena__find_symbol`. That is the whole point of this change and is unverified.
2. **Decide what to do with `feat/slack-thread-reader`**: it has two commits and no PR.
   Either open one against a Linear ticket, or merge to main directly.
3. Unchanged from the predecessor: when crv #21 merges, rebase #23/#24, then delete the
   head-clip path in `plugins/ks/scripts/grain-cli.ts` and bump `requireCrv()`.
