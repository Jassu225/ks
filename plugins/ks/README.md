# KS Plugin

Claude Code plugin for KarmaSuite development workflows. Orchestrates a 10-phase software project lifecycle using slash commands, specialized agents, and Linear integration.

## Development Setup

For plugin development, clone the repo and run `init-dev`.

```bash
cd plugins/ks
./init-dev
```

After running, restart your terminal (or `source ~/.zshrc`) and use:

```bash
claude-ks
```

## Production Setup

Install the plugin from within Claude Code:

```
# Add marketplace
/plugin marketplace add karmasuite/ks

# Install the plugin
/plugin install ks@karmasuite
```

Then run the init script to install dependencies, build CLI tools, and configure your shell:

```bash
cd plugins/ks
./init
```

This will:
- Install npm dependencies in `plugins/ks/scripts/`
- Build the TypeScript CLI tools
- Add `plugins/ks/scripts/` to your `PATH`

## Adding Components

### Commands
Add `.md` files to `commands/`. They become available as `/ks:filename`.

### Agents
Add `.md` files to `agents/`. Reference them with `subagent_type: "ks:agent-name"`.

The research agents (`codebase-locator`, `codebase-analyzer`, `codebase-pattern-finder`, `web-search-researcher`) also hold `SendMessage`, so the orchestrator can keep a follow-up conversation with a running agent instead of re-spawning it with lost context.

### Skills
Add a directory to `skills/` containing a `SKILL.md` with `name` + `description` frontmatter (plus optional `references/` files it links to). Claude Code auto-discovers it — no manifest entry needed — and loads it when the description matches the task.

Current skills:
- `add-page-ai-chat` — wire a data-modifying Karmie AI chat onto a KarmaSuite page (new `ReportAgentKind`, handler, `*Core` extraction, AI tools, FAB/drawer wiring, optional domain Agent Skill).
- `create-report-agent` — build and iterate a report agent that reproduces a customer's grant report (intake questions, probes, ruleset authoring, run→score→fix loop, replay validation, prod cutover). Pure configuration — a `report_agent` row's `agentContext`, no repo changes.

### Hooks
Edit `hooks/hooks.json` to add event handlers.

The following scripts run automatically on Stop and SubagentStop events:
- `quality-format.sh` — Prettier formatting
- `quality-lint.sh` — ESLint validation
- `quality-typecheck.sh` — TypeScript type checking

All three resolve their changed-file set through `quality-files.sh`, which honours an optional `.quality-ignore` in the target repo root — see `scripts/README.md`.

#### Session name

A `SessionStart` hook (`scripts/session-title.sh`, on startup, resume and clear) names the session after the checkout's workflow unit: the ticket id (`KAR-13147`), or for a project its workflow folder name. `sessionTitle` sets the session's name, which is also the peer name `ListAgents` prints and `SendMessage` takes, so it is kept short and space-free; the statusline's ticket pill carries the ticket. Outside a workflow checkout the name is left alone. The lookup is `scripts/workflow-unit`, which the shell statusline uses too. (The session's UUID can't be set this way; only `claude --session-id <uuid>` chooses it.)

#### Statusline (split: script + function-hook module)

In `claude-ks` sessions the statusline is split in two:

```
@KAR-13147 | 110k/1000k (11%) |  jaswanth/kar-13147-map-employee-fails-to-assign-expenses-to-the-correct-bc
▸▸ bypass permissions on (shift+tab to cycle) · PR #6724 · ← for agents
( KAR-13147 ↗ ) Plan phase ( ● IN PROGRESS ) ( ▲ PREVIEW ↗ ) ≡ more     5h: 13%/21%(3h 56m) 7d: 60%/74%(1d 18h 46m)
```

- **Static half**: `scripts/statusline`, in the statusline's own area: session name, context, branch. `claude-ks` exports `KS_MOD_STATUSLINE=1`, and the script stops after this line (plain `claude` sessions get its full output, ticket link and rate limits included).
- **Interactive half**: the module `hooks/register.tsx` lists under `modules`, drawn in the prompt's hint line, one row under Claude Code's own line (kept as it draws it, `next(e)`, so its live pills keep working): a ticket pill linking to Linear (brightens under the pointer), the current phase (`Plan phase`) and a status pill (`● IN PROGRESS`, `↺ REVISITING`, `◎ NEXT · NEW SESSION`, `◎ UP NEXT`, `✓ DONE`), the branch's Vercel preview pill (below), `≡ more` / `≡ less` (opens or closes the project pane; closing it any other way flips it back), and the rate-limit windows at the right, colored by projected usage at reset as the script does (`hooks/statusline/usage.ts`).
- **Which workflow**: the `state.yaml` under `workflow/` whose `worktree_dir` is this checkout's git root, or, for older ticket states without `worktree_dir`, `workflow/*/tickets/<id>/state.yaml` from the ticket id in the branch name (the lookup `scripts/workflow-unit` does). Outside a workflow checkout the row has no pills.
- **Vercel preview pill**: the newest preview deployment of the unit's branch (its latest PR's branch, else the checkout's), read through the vercel plugin's MCP server (`$.mcp.call('plugin:vercel:vercel', 'list_deployments', { slug: <GitHub org>, branch })`): `▲ DEPLOYING` (links to the build logs), `▲ PREVIEW` (links to the branch's stable alias, `<project>-git-<branch>.…`, asked of Vercel once per branch with `list_deployment_aliases`), `▲ PREVIEW FAILED`. Without the vercel plugin the first failed call stops the check for the session, and the pill (and the pane's section) stay hidden. Logic: `hooks/live/vercel.ts`.
- **Live, on one clock**: every refresh runs off a single 5s tick (`hooks/live/schedule.ts`): each job has its own interval, read every tick, and never stacks on itself. `state.yaml` (when its mtime changes) and the rate limits every 5s; the Linear status every 60s and the phase times every 60s, both only while the pane is open; the Vercel preview every 10s while a build runs or for 90s after a `git push` from the session, else every 2 min. The pane's pulsing dot keeps its own 80ms timer. When a phase completes, a toast names the next phase.
- **Links** everywhere (statusline and pane) are drawn by one `linkTo`: the text underlined, then `↗`; pills by one `pill`. Pills use Nerd Font powerline caps (`\ue0b6` / `\ue0b4`).

#### Project pane (`/ks-project`)

`/ks-project`, or the statusline's `≡ more` button, opens a pane with everything the checkout's `state.yaml` records (docked beside the transcript in fullscreen, inline otherwise):

- **Header**: the ticket pill (links to Linear) and the Linear status pill: live, fetched on open and every 60s while open (`linear issue get --json` via `tsx`, ~4s), in Linear's own state color, with `live · 11:31 AM`; until the first fetch (or if it fails) the state `ks-start-ticket` recorded, marked `snapshot` (`hooks/live/linear.ts`). Below, after a blank row, the current phase and its status pill, exactly as the statusline shows them (one `workflowStatus` feeds both, e.g. `Plan phase ( ● IN PROGRESS )`); then the title, and priority, estimate, assignee (or project lead), due date.
- **Phases**: each phase with its status glyph, start → end in local time, and in brackets the **engaged time** from the ticket's time log (`~/.claude/ks-time/`, see `scripts/README.md`, "Time tracking") with the iteration count, e.g. `(18m engaged, 2 iterations)`; the calendar span is not shown, as it says little. The phase being worked counts up to now, refreshed every 60s. The phase being worked pulses on the terminal: its dot is a one-cell `Raster` repainted every 80ms (`$.ui.blit`, no redraw of the pane) between dim and bright amber, a ~1.6s breath (`hooks/project/pulse.ts`); other surfaces show it still.
- **Slack**: every thread under `slack:` (project thread, release thread, PR review threads), linked.
- **Pull requests**: each PR's GitHub link, its review thread, and when it was opened.
- **Preview deploy**: the preview pill, `open preview` (the branch's stable alias) and `build logs` links, the branch, the short SHA, when it was built and when it was checked. Hidden without the vercel plugin or a preview.
- **Linear**: the ticket or project, the parent project, a project's PRD/prototype/TAD/plan tickets, initiatives, labels.
- **Workspace**: the worktree path (with a copy button) and the unit's workflow folder (`workflow/<user>/tickets/<id>`, holding `state.yaml`, `resources/` and the handoffs) as one `file://` link that opens the folder (plain text on desktop, which links only `https:`), with its own copy button for the full path.

The full `state.yaml` is parsed by `node` with the `yaml` package `scripts/` already ships (`hooks/project/info.ts` turns it into the pane's view), and re-read whenever its mtime changes. A plugin gets one hooks module, so `hooks/register.tsx` holds both the statusline's and the pane's hooks; the logic lives in `hooks/statusline/` and `hooks/project/`.

- The `$.state` contract is `types/index.d.ts`, named in `plugin.json` as `"types"`. The engine writes API types into `.claude-plugin/types/` when it loads the plugin, with its own `.gitignore`, so they are never committed.
- Check changes with `claude plugin validate plugins/ks` and `claude plugin test plugins/ks` (tests in `hooks/statusline/statusline.test.ts`, `hooks/project/pane.test.ts` and `hooks/live/live.test.ts`), and type-check with `plugins/ks/scripts/node_modules/.bin/tsc -p plugins/ks` from the repo root (the committed `tsconfig.json` extends the generated types, so it works once the plugin has loaded). A `--plugin-dir` session (`claude-ks`) hot-reloads the module when its files change.
