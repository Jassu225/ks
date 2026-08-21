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

### Grain CLI

CLI for the [Grain public API v2](https://developers.grain.com/) — meeting recordings, transcripts, AI summaries, webhooks.

**Install:**

```bash
cd plugins/ks && ./init          # or ./init-dev
source ~/.zshrc
grain auth check                 # should print the base URL, API version, visible users
```

`./init` installs deps, builds `grain-cli.js`, puts `scripts/` on `PATH`, seeds `.env` from `.env.example` when absent, and checks for `ffmpeg`. It is idempotent — re-running never overwrites an existing `.env` or duplicates the `PATH` line. Add `GRAIN_API_TOKEN` to `.env` yourself (Personal or Workspace token from <https://grain.com/app/settings/integrations?tab=api>); the token kind decides what you can see.

**To also watch recordings** (frame extraction), install the video plugin from inside Claude Code — `./init` cannot do this, it is not a shell operation:

```
/plugin marketplace add https://github.com/jordanrendric/claude-video-vision
/plugin install claude-video-vision
/claude-video-vision:setup-video-vision
```

Its setup wizard asks for an audio backend; the choice does not matter for Grain work, since we always pass `skip_audio: true` and read Grain's own transcript. `ffmpeg` must be on `PATH` (`brew install ffmpeg`) — the MCP server shells out to it. The `video_*` tools appear once the plugin loads, which may need a session restart.

Note that the `grain-cli` skill and the `ks:grain-recording-watcher` agent only load in sessions started with the ks plugin (`claude-ks`, or via `KS_EXTRA_PLUGINS`).

```bash
# Verify the token (Grain has no whoami endpoint — this probes POST /v2/users)
./grain auth check

# Find calls
./grain recording list -s "onboarding" --after 2026-08-01 --scope external
./grain recording list -i participants,ai_summary --limit 20 --json

# One call in full, transcript, media
./grain recording get <recording-id> -i all --ai-format markdown
./grain recording transcript <recording-id> -f vtt -o call.vtt
./grain recording download <recording-id> -o call.mp4

# Archive media + transcript together, one folder per recording
./grain recording export <recording-id>                          # mp4 + vtt + metadata json
./grain recording export <id-a> <id-b> -f vtt,srt --force        # several calls, overwrite
./grain recording export <recording-id> --no-media -f txt        # transcript only
./grain recording export <recording-id> --dir ~/Archive/Grain    # one-off storage root

# Mutations
./grain recording update <recording-id> --title "Q3 kickoff"
./grain recording tag add <recording-id> customer-escalation
./grain recording share team <recording-id> <team-id>

# Webhooks and directory
./grain hook create https://example.com/hook --type recording_added -i participants
./grain hook list --state enabled
./grain user list -s luke
./grain team list
./grain meeting-type list

# OAuth2 (for distributable integrations, not for your own token).
# Client id/secret and refresh token come from .env — flags are for one-off use.
./grain oauth authorize-url --redirect-uri https://example.com/cb
./grain oauth token --code <code> --code-verifier <verifier>
./grain oauth refresh
```

`recording export` writes to `$GRAIN_STORAGE_DIR` (default `~/Documents/Grain`), one folder per recording named `<start-date>_<title-slug>_<id-prefix>/`, with the media, each requested transcript format, and the recording JSON all sharing that base name. Existing files are left alone unless `--force` — and the media existence check happens *before* the download, so a re-run never re-pulls gigabytes.

Frame extraction is **not** in this CLI: `export` puts the media and a subtitle sidecar on disk, and the [claude-video-vision](https://github.com/jordanrendric/claude-video-vision) MCP plugin reads the pixels (`video_watch` / `video_detail` on the exported `.mp4`, with `skip_audio: true` since Grain already gave you the transcript). See the `grain-cli` skill's `references/watching-recordings.md`.

Worth knowing before you script against it: reads are `POST` with the filters in a JSON body; `recording list` paginates by opaque cursor with **no server-side page size** (`--all` walks every page, `--pages`/`--limit` cap it) against a 300 req/min limit; transcripts are one extra request per recording; upload completion is reported **only** to an `upload_status` webhook; and there is no delete-recording endpoint. The `grain-cli` skill (`plugins/ks/skills/grain-cli/`) carries the full API reference and the documented gaps.

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
