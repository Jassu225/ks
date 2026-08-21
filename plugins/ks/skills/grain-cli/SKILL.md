---
name: grain-cli
description: Work with Grain meeting recordings through the `grain` CLI (plugins/ks/scripts/grain-cli.ts). **If the request involves watching a recording — what was on screen, what a demo showed, what happened in a call — delegate to the `ks:grain-recording-watcher` agent instead of running the CLI inline.** Everything else, drive the CLI directly: list and search calls, read transcripts and AI summaries/action items, download/export media and subtitles, see what was on screen (export, then the claude-video-vision MCP), tag and share recordings, and manage webhooks. Trigger whenever Grain is mentioned at all, or on any of: list/find/search Grain recordings or calls (by date, day, title, team, meeting type, internal vs external); a named meeting, sync, standup, demo, onboarding, customer or sales call to look up; get a transcript, meeting notes, summary, action items, attendees, or highlights of a call; what was said or shown/screen-shared in a meeting; download, export, archive, or sync recordings to disk; watch, view, or analyze a call's video, slides, or keyframes; clip a time range of a call; upload a recording; tag, share, unshare, or rename a recording; set up or inspect a Grain webhook; or a grain.com link, share URL, or recording id.
---

# The `grain` CLI

`grain` is this plugin's CLI for Grain meeting recordings, at `plugins/ks/scripts/grain-cli.ts`. Invoke it as `grain <command>` (the `./init` script puts `plugins/ks/scripts/` on `PATH`), or `npx tsx plugins/ks/scripts/grain-cli.ts <command>` if `PATH` isn't set up.

**References:** `references/cli-reference.md` for the exhaustive per-command flag list, JSON output shapes, request counts, and exit behavior. `references/watching-recordings.md` for the seam between this CLI and the claude-video-vision MCP server, which owns all frame extraction — read it before any visual analysis. This file is the working guide.

## First: is this a watching request?

**If the answer requires looking at the video — what was on screen, what a demo showed, what a diagram said, "watch this call and tell me X" — stop and delegate to the `ks:grain-recording-watcher` agent.** Do not start running commands. Watching means pulling dozens of frames into context as images. The agent absorbs that cost in its own context and returns an answer plus a written report; done inline, it floods this conversation and leaves no report behind.

It runs headless and **cannot ask the user anything**, so settle the ambiguity first — which recording, whose conversation, a window or the whole call — then pass the recording id (or everything known about the call) plus the actual question. If it still can't proceed it returns `NEEDS INPUT` with options rather than guessing, because a wrong guess costs a large download and minutes of processing.

**It pauses before spending anything.** Once it has read the transcript and derived a window, it returns an `AWAITING APPROVAL` block — the recording, the window and why, whether the media is already local, and the expected frame/sheet count — then waits. Relay that to the user, and send the answer back with `SendMessage` to the same agent (`"go"`, or a different window). Do not re-spawn it: it still holds the transcript and window, and a fresh agent would re-derive both. Pass an explicit pre-authorisation in the initial prompt ("user has pre-approved the watch") only when the user has already agreed to the cost.

Drive the CLI inline for everything else — listing, searching, transcripts, summaries, action items, export, tags, sharing, webhooks — and for a genuine one-off where the user explicitly wants the frames in this conversation. The playbook below is what the agent follows, and what you follow on the rare occasion you don't delegate.

## First run

`cd plugins/ks && ./init` (idempotent) installs deps, builds the CLI, puts `scripts/` on `PATH`, and seeds `.env`. Then `source ~/.zshrc` and check with `grain auth check`.

Watching recordings additionally needs the video plugin, which `./init` cannot install — it is a Claude Code operation, not a shell one:

```
/plugin marketplace add https://github.com/jordanrendric/claude-video-vision
/plugin install claude-video-vision
/claude-video-vision:setup-video-vision
```

plus `ffmpeg` on `PATH`. Its wizard's audio-backend choice is irrelevant here — we always pass `skip_audio: true` — and its frame-resolution answer is just a default that per-call `resolution` overrides. The `video_*` tools appear once the plugin loads, sometimes only after a session restart. Everything except watching works without it.

Secrets come from `plugins/ks/scripts/.env` — **no command accepts a token as an argument**, so nothing sensitive reaches shell history or `ps`:

```bash
GRAIN_API_TOKEN=...                     # required
# GRAIN_STORAGE_DIR=~/Documents/Grain   # where `recording export` writes (default)
# GRAIN_OAUTH_CLIENT_ID= / _SECRET= / GRAIN_OAUTH_REFRESH_TOKEN=   # oauth commands only
```

Then `grain auth check` — it prints the base URL, API version, and visible-user count. Run it before anything else when a command misbehaves; a wrong *kind* of token is the most common cause:

| Token in `.env` | Sees | Commands that need it |
|---|---|---|
| Personal access token | what that one user sees | `recording list --attendance …`, `-i private_notes` |
| Workspace access token | all workspace data | `recording upload --user-id …` |

Using the other kind doesn't warn — it errors or silently returns less. `grain user list`, `grain team list`, and `grain meeting-type list` are how you get the ids that other commands take.

## Commands

| Goal | Command |
|---|---|
| Find calls | `grain recording list [-s <title>] [--after 2026-08-01] [--before …] [--scope external] [--team <id>] [--meeting-type <id>] [--attendance hosted\|attended]` |
| Add detail to a list | `grain recording list -i participants,ai_summary --limit 20` |
| One call, everything | `grain recording get <id> -i all --ai-format markdown` |
| Transcript to stdout or file | `grain recording transcript <id> [-f json\|txt\|vtt\|srt] [-o file]` |
| Media file | `grain recording download <id> [-o call.mp4]` |
| **Archive media + transcript** | `grain recording export <id...> [-f vtt,srt] [--no-media] [--dir <path>] [--force]` |
| **See what was on screen** | `grain recording export <id>`, then hand the file to the claude-video-vision MCP (see below) |
| Add a recording | `grain recording upload call.mp4 [--user-id <uuid>]` |
| Rename | `grain recording update <id> --title "…"` |
| Tags | `grain recording tag add <id> <tag>` · `grain recording tag rm <id> <tag>` |
| Share / revoke | `grain recording share user\|team <id> <target-id>` · `grain recording unshare user\|team <id> <target-id>` |
| Webhooks | `grain hook create <url> --type <event> [-i …]` · `grain hook list [--state enabled]` · `grain hook delete <id>` |
| Directory lookups | `grain user list [-s name]` · `grain team list` · `grain meeting-type list` |
| Token check | `grain auth check` |
| OAuth (distributable integrations only) | `grain oauth authorize-url --redirect-uri …` → `grain oauth token --code … --code-verifier …` → `grain oauth refresh` |

`--help` works at every level (`grain recording export --help`).

## If a Grain MCP is also available

Some sessions have a Grain MCP (`list_meetings`, `search_in_transcripts`, `fetch_meeting_transcript`) alongside this CLI. They are complementary, not competing:

- **MCP for discovery, search, and reading** — date-bounded meeting lists, and full-text search across transcripts, which this CLI cannot do (Grain's API offers title matching only, no transcript search).
- **CLI for anything with media** — `watch`, `frames`, `export`, `download`, `upload`, plus tagging, sharing, and webhooks. The MCP has no video or frame capability at all.

Two MCP traps worth knowing: a `title_search` filter silently under-returns, so never conclude "no such meeting exists" from a filtered list — drop the filter and page the date range instead; and `search_in_transcripts` groups its results under a **`recording`** key, not `meeting`.

## Playbook: "find the call where X happened, watch it, tell me what you learned"

This is the most common request, and the order matters — **never download media first.** Transcripts are one cheap request with no bytes; media is hundreds of megabytes and frame extraction takes minutes. Read first, narrow, then extract only the stretch that matters.

**1 — Locate the call.** Filter by date and title, and disambiguate on participants rather than guessing:

```bash
grain recording list --after 2026-08-10 --before 2026-08-11 -s "engineering sync" --all -j \
  | jq -r '.recordings[] | "\(.id) \(.start_datetime) \(.duration_ms/60000|floor)min \(.title)"'
```

If several match, add `-i participants` and pick the one whose attendees fit the question. Say which you picked and why. (Heads-up: the date-bound flags map onto a Grain filter whose semantics are documented inconsistently — verify the returned dates are what you asked for before trusting the set.)

**2 — Read the transcript and find the time range.** Grain's transcript carries per-segment `start`/`end` in **milliseconds** plus speaker names, which is everything needed to convert a fuzzy ask ("near the end", "where John and I discussed the wrapper") into a concrete window:

```bash
grain recording transcript <id> -f json -j > /tmp/t.json

# skim the tail when the ask says "at the end of the call"
jq -r '.[] | "\(.start/1000|floor)s \(.speaker): \(.text)"' /tmp/t.json | tail -40

# bound a window from a topic match, 15s of padding either side
jq -r '[.[] | select(.text|test("wrapper|budgeting";"i"))]
       | "from=\((first.start/1000|floor) - 15 | if . < 0 then 0 else . end)s to=\((last.end/1000|ceil) + 15)s matches=\(length)"' /tmp/t.json

# or "the last stretch between these two people" — bound by speaker within the tail
jq -r '[.[] | select(.start > 2400000) | select(.speaker|test("Jonathan|Jaswanth";"i"))]
       | "from=\((first.start/1000|floor) - 15 | if . < 0 then 0 else . end)s to=\((last.end/1000|ceil) + 15)s"' /tmp/t.json
```

Sanity-check the window before spending on it: a topic regex that matches across the whole call (`matches=15` spread over 20 minutes) means the window is too wide to be useful — tighten the pattern or intersect it with a speaker or a time bound.

Speaker names come from Grain and are usually full names, so match given names loosely (`John` → `Jonathan Allen`). Padding matters: the on-screen artefact being discussed often appears a few seconds before or after the words.

**3 — Export, then extract that window.**

```bash
grain recording export <id>                       # media + sidecar + metadata, idempotent
ls "<recording folder>"/*.srt 2>/dev/null         # sidecar present → skip_audio: true
# then video_watch on the exported .mp4:
#   start_time "00:39:40", end_time "00:47:33", fps 5, resolution 2048,
#   frame_format "jpeg", skip_audio true
```

Convert your second-based bounds to `HH:MM:SS`. They are source-video times against the exported file, so nothing needs offsetting afterwards.

**4 — Read the frames against the transcript, then answer.** The transcript says what was claimed; the frames say what was actually on screen. Read a few well-chosen frames rather than everything the extraction returned (`view_sample` caps that), and confirm their timestamps fall inside the window you asked for. In the answer:

- cite timestamps from the manifest, in source-video time
- distinguish what was **said** from what was **shown** — the visual half is the whole reason for watching rather than just reading the transcript
- state what was decided or left open, not just what was mentioned
- if the visuals don't resolve the question, say so and name what you'd need (a different window, a denser `--scene`, the full call)

**When to skip `watch` entirely:** if the answer is purely verbal — a decision, a commitment, a date — the transcript alone answers it, and `grain recording get <id> -i ai_summary,ai_action_items` is cheaper still. Reach for `watch` when the question is about something on screen: a deck, a demo, a UI, a diagram, an error, a spreadsheet.

## Two flags to know everywhere

**`-j/--json`** — every command takes it. Human output is for reading; `-j` is what you parse. Always use it before piping:

```bash
grain recording list --after 2026-08-01 -j | jq -r '.recordings[] | "\(.start_datetime) \(.title) \(.id)"'
```

**`-i/--include <keys...>`** — on `list`, `get`, `export`, and `hook create`. Keys: `highlights`, `participants`, `ai_summary`, `ai_action_items`, `private_notes`, `calendar_event`, `hubspot`, `screenshares`, or `all`. Comma- or space-separated. Anything not requested is **absent from the response**, so `.ai_summary` reading as null usually means you forgot the flag. `all` deliberately omits `private_notes` (personal-token only) — ask for it by name. AI template sections are separate: `--ai-sections "Next Steps,Risks" --ai-format markdown`.

## `recording export` — the archiver

```bash
grain recording export <id>                        # → media + .vtt + metadata json
grain recording export <id-a> <id-b> -f vtt,srt    # several calls, two subtitle formats
grain recording export <id> --no-media -f txt      # transcript only
grain recording export <id> --dir ~/Archive/Grain  # one-off root, overrides GRAIN_STORAGE_DIR
grain recording export <id> --force                # overwrite instead of skipping
```

Layout — one folder per recording under the storage root, all files sharing the folder's base name:

```
~/Documents/Grain/
└── 2026-08-14_all-hands-q3-kickoff_pppp6666/
    ├── 2026-08-14_all-hands-q3-kickoff_pppp6666.mp4
    ├── 2026-08-14_all-hands-q3-kickoff_pppp6666.vtt
    └── 2026-08-14_all-hands-q3-kickoff_pppp6666.json   # the recording object; --no-metadata skips
```

`-f json` writes the transcript as `<base>.transcript.json`, so it never collides with the `<base>.json` metadata sidecar. Other formats are plain `<base>.<format>`.

Date first so the archive sorts chronologically, id prefix last so same-titled calls never collide. Storage root resolves `--dir` → `$GRAIN_STORAGE_DIR` → `~/Documents/Grain`.

**Re-runs are cheap and idempotent.** Existing files are skipped (`=` in the output) unless `--force`, and the media existence check happens *before* the download, so repeating an export never re-pulls the video. That makes it a sync:

```bash
grain recording list --after 2026-07-01 --all -j | jq -r '.recordings[].id' | xargs grain recording export -f vtt
```

Enrich the sidecar JSON with the same include flags: `grain recording export <id> -i participants,ai_summary,ai_action_items`.

## Watching a call: export, then the video MCP

> Reminder: this is the inline path. Unless the user asked you to work in this conversation, hand watching requests to `ks:grain-recording-watcher`.

This CLI has **no video capability** — no frame extraction, no ffmpeg, no clipping. Visual analysis belongs to the [claude-video-vision](https://github.com/jordanrendric/claude-video-vision) MCP server (`video_info`, `video_analyze`, `video_watch`, `video_detail`), which ships its own `video-perception` skill for the extraction workflow.

The division: **`grain` gets the recording and the transcript onto disk; the MCP reads the pixels.**

```bash
grain recording export <id>              # media + .srt + metadata, one folder, idempotent
grain recording transcript <id> -f json -j   # ms timestamps + speaker names → pick the window
# then: video_detail on the exported .mp4 with segments: [{start, end, fps, resolution}]
```

Four things that matter, all covered in `references/watching-recordings.md`:

- **Narrow the window from Grain's transcript**, not by scanning video. One cheap API call, real speaker names, millisecond bounds.
- **Ask for `resolution: 2048`** whenever the answer is text on a shared screen — explicitly, on every call. Stored defaults in `~/.claude-video-vision/config.json` apply only when you omit the parameter, and a general-purpose default (512, or even 1024) makes a spreadsheet unreadable. At 2048 a live Google Sheet reads verbatim with no cropping.
- **Never request `frame_format: "png"` — it crashes the MCP server** (connection closes mid-call, looks like a dead plugin). JPEG at the same resolution is fine, and is already the config default.
- **Use a high per-segment `fps` on a screen being edited.** The incremental edits are the content; sparse sampling drops exactly the moments that carry meaning. Dense over a narrow window beats sparse over the whole call.
- **Pass `skip_audio: true` when a `.srt`/`.vtt` sidecar exists** — the normal case after `export`. The MCP does *not* check for one; it transcribes unconditionally, redoing work Grain already did better (real speaker names vs `[SPEAKER_XX]`). Only leave audio on when the folder genuinely has no sidecar, and flag the machine transcription in the report.

Segments are expressed against the exported file in **source-video time**, so no offset arithmetic — timestamps you cite match what someone scrubbing the recording in Grain sees.

If the plugin isn't installed (`/plugin install claude-video-vision`), you cannot watch anything. Say so rather than improvising a frame pipeline.

## Cost and pagination

`recording list` returns **one page** by default. `--all` walks the cursor to the end, `--pages N` caps pages, `--limit N` caps results (trimmed client-side — the API has no page-size parameter, so `--limit` does not reduce requests).

Grain allows **300 requests/minute**. The CLI waits out `Retry-After` and retries a 429 up to 3 times, printing each wait. Budget before a big sweep:

- `recording list` → 1 request per page, however many recordings that page holds
- `recording transcript` → 1 request, per recording per format
- `recording export` → 1 metadata + 1 media + 1 per transcript format, **per recording**

So exporting 100 recordings with `-f vtt,srt` is ~400 requests: run it, but expect the CLI to pause on rate limits.

## When something goes wrong

- `Error: GRAIN_API_TOKEN environment variable is not set` — the `.env` slot is empty; the message includes the token URL.
- `Grain API error 401` — token revoked, or the wrong kind for that flag. Confirm with `grain auth check`.
- `Grain API error 4xx` + raw body — Grain documents no error schema, so the CLI prints the status and the body verbatim. Read it; don't infer.
- `Grain returned 406 for .<format>` — not a failure. The formatted transcript endpoint refused, so the file was rebuilt from the JSON transcript. Output is identical in content.
- `Network error calling <method> <url>` — DNS/proxy/sandbox, not Grain. In a sandboxed session, `api.grain.com` must be reachable.
- `Rate limited (429). Waiting Ns…` — expected on sweeps, not a failure.
- Validation happens before any request: unknown `-i` key, bad `-f` format, a tag with spaces (Grain allows letters/digits/dashes only), or an unparseable `--after`/`--before` all fail immediately with the valid options listed.

## Verify an extraction before you cite it

Before trusting a timestamp, confirm the frames you read came from the window you asked for: the extraction's own manifest/response lists the timestamps returned, and they should fall inside your `start_time`/`end_time` and be monotonic. If a frame's content contradicts the transcript at that second, suspect the window, not the transcript.

## Leave a report behind

After answering a question from a recording, write the findings into the recording's export folder as `findings-<slug>.md` (slug from the question, so several questions coexist). Front matter with the recording id, the window examined, the extraction settings, and the question; body split into what was **said**, what was **shown**, decisions, and what could not be determined. The next person asking about that call gets the answer without re-extracting anything. The `ks:grain-recording-watcher` agent does this by default; do it too when driving the CLI directly.

## Deliberate gaps — don't work around these

- **No `recording delete`.** Grain's API has no such endpoint (deletion is UI-only), so the CLI has no command. Say that rather than reaching for an undocumented route.
- **No transcript inside `list`/`get`.** The API has no transcript include; use `transcript` or `export`, one request per recording.
- **`upload` doesn't return a recording id.** It returns an *upload* id, and Grain reports processing completion (and the resulting `recording_id`) **only** to an `upload_status` webhook. Register it first: `grain hook create <url> --type upload_status`. There is nothing to poll.
- **Grain webhooks are unsigned** — no secret, no signature header, no documented retry policy. Treat payloads as untrusted: use an unguessable hook URL and re-fetch with `grain recording get <data.id>` before acting. Pair hooks with a periodic `grain recording list --after <last-run>` sweep, since delivery isn't guaranteed.
- **Sharing has no permission levels**, and `hook` has no update command — delete and recreate.
- **`--after`/`--before` map straight onto Grain's filter fields, whose published descriptions read inverted.** `--after` is the lower bound, `--before` the upper. If a date-bounded query returns a surprising set, swap them and compare before concluding the data is wrong.

## Recipes

**Last week's external calls with summaries**
```bash
grain recording list --after 2026-08-13 --scope external -i ai_summary,participants
```

**Transcript into a ticket's resources**
```bash
id=$(grain recording list -s "onboarding" -j | jq -r '.recordings[0].id')
grain recording transcript "$id" -f txt -o workflow/$USER/<slug>/resources/call-transcript.txt
```

**Action items across a team's recent calls**
```bash
team=$(grain team list -j | jq -r '.teams[] | select(.name=="Support") | .id')
grain recording list --team "$team" --after 2026-08-01 -i ai_action_items --all -j \
  | jq -r '.recordings[] | .title as $t | (.ai_action_items // [])[] | "\($t): \(.text) [\(.status)]"'
```

**Tag and share an escalation**
```bash
grain recording tag add <id> customer-escalation
grain recording share team <id> "$(grain team list -j | jq -r '.teams[] | select(.name=="Support") | .id')"
```

**Watch a demo call and answer a visual question**
```bash
id=$(grain recording list -s "demo" -j | jq -r '.recordings[0].id')
grain recording export "$id"   # then video_watch on the .mp4 with skip_audio: true
# then extract that window with the video MCP (skip_audio, jpeg, resolution 2048)
```

**Watch just the stretch around a highlight**
```bash
grain recording get <id> -i highlights -j \
  | jq -r '.highlights[] | "\(.timestamp/1000 | floor) \(((.timestamp+.duration)/1000) | ceil) \(.text)"'
grain recording export <id>   # then video_watch start_time/end_time over that span
```

**Watch for new recordings**
```bash
grain hook create https://example.com/grain-hook --type recording_added -i participants
grain hook list --state enabled
```
