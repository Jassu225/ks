# KS Scripts

CLI scripts for Linear integration and KarmaSuite workflow management.

## Setup

1. Install dependencies:
   ```bash
   cd plugins/ks/scripts
   npm install
   ```

2. Add your Linear API key to `.env`:
   ```bash
   # Edit .env file
   LINEAR_API_KEY=lin_api_your_key_here
   ```

   Get your API key from: https://linear.app/settings/api

### Loading extra plugins with `claude-ks`

The `claude-ks` / `claude-ks-serena` launchers always load the `ks` plugin. To
also load other local plugins (under `plugins/<name>`) on every launch, set a
space-separated list in `.env`:

```bash
# .env — load ks-flow alongside ks on every claude-ks invocation
KS_EXTRA_PLUGINS="ks-flow"
```

Each entry is added as `--plugin-dir plugins/<name>`; missing dirs are warned
and skipped. Modular — list any plugin here, no launcher edits needed. Running
`plugins/ks-flow/init` adds `ks-flow` to this list automatically (idempotent,
non-destructive). One-off alternative: `claude-ks --local-plugin <name>`.

`ks-start-ticket` / `ks-start-project` launch the new worktree session **through
`claude-ks`** (not plain `claude`), so the worktree inherits the same plugin set
— ks + every `KS_EXTRA_PLUGINS` entry (e.g. ks-flow, wiring its session-tracking
and notification hooks) + `ks-rules`. A single source of truth for what loads.

## Scripts

### Linear CLI

Comprehensive CLI for all Linear operations.

```bash
# Show help
npx tsx linear-cli.ts --help

# List projects
npx tsx linear-cli.ts project list
npx tsx linear-cli.ts project list --json

# Get project details
npx tsx linear-cli.ts project get <project-id>
npx tsx linear-cli.ts project from-url "https://linear.app/team/project/my-project-abc123"

# List project updates
npx tsx linear-cli.ts project updates <project-id-or-url>
npx tsx linear-cli.ts project updates <project-id> --json

# Create a project update
npx tsx linear-cli.ts project update <project-id> --body "Completed sprint goals. All tests passing."
npx tsx linear-cli.ts project update <project-id> --body "On track for delivery" --health onTrack
npx tsx linear-cli.ts project update "https://linear.app/team/project/my-project" -b "Update text" -h atRisk

# List/get issues
npx tsx linear-cli.ts issue list --project <project-id>
npx tsx linear-cli.ts issue get KAR-123 --json
npx tsx linear-cli.ts issue get KAR-123 --full  # includes comments and attachments

# List attachments/resources for an issue
npx tsx linear-cli.ts issue attachments KAR-123
npx tsx linear-cli.ts issue attachments KAR-123 --json

# Teams, users, documents, etc.
npx tsx linear-cli.ts team list
npx tsx linear-cli.ts user me
npx tsx linear-cli.ts document list --project <id>
```

### KS Start Project

Initialize a workflow state YAML from a Linear project.

```bash
npx tsx ks-start-project.ts <project-url> [output-path]

# Example
npx tsx ks-start-project.ts "https://linear.app/karmasuite/project/my-feature-abc123" ./state.yaml
```

This will:
1. Fetch project information from Linear
2. List all issues in the project
3. Prompt you to select PRD, TAD, Prototype, and Implementation Plan tickets
4. Generate a workflow state YAML file

### Quality checks

`quality-format.sh` (Prettier), `quality-lint.sh` (ESLint), and `quality-typecheck.sh` (tsc) run automatically on Stop and SubagentStop via `hooks/hooks.json`, and can also be run by hand:

```bash
plugins/ks/scripts/quality-format.sh
plugins/ks/scripts/quality-lint.sh
plugins/ks/scripts/quality-typecheck.sh
```

All three source `quality-files.sh`, which collects the changed `.ts`/`.tsx` files (staged + unstaged + untracked + everything on the branch vs. its base).

**`.quality-ignore`** — optional file in the target repo root that excludes paths from that set. One pattern per line, matched as a fixed substring against the repo-relative path; `#` comments and blank lines ignored:

```
# broken on main since KAR-9999, tracked separately
apps/www/src/legacy/report-builder.tsx
```

Use it only for files that are *already* failing on the main branch — otherwise a one-line comment edit pulls them into the changed set and fails the hook for whoever touched them. It suppresses real errors rather than fixing them, so keep the list short and justify every entry.

## Output Format

The generated `state.yaml` follows this structure:

```yaml
# Linear Project Information
project:
  id: "uuid"
  name: "Project Name"
  url: "https://linear.app/..."
  summary: "Project description"
  dates:
    created_at: "2026-01-01T00:00:00.000Z"
    updated_at: "2026-01-01T00:00:00.000Z"
    start_date: "2026-01-01"
  priority:
    value: 2
    name: "High"
  status:
    id: "uuid"
    name: "Planned"
  labels: []
  initiatives:
    - id: "uuid"
      name: "Initiative Name"
  lead:
    id: "uuid"
    name: "Lead Name"
  prd_ticket_id: "KAR-123"
  prototype_ticket_id: "KAR-124"
  tad_ticket_id: "KAR-125"
  implementation_plan_ticket_id: "KAR-126"

# Phase tracking
phase:
  current_phase: 0
  current_phase_state: "COMPLETED"
```
