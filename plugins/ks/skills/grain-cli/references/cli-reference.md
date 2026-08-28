# `grain` CLI — complete command reference

Operator's reference for driving `plugins/ks/scripts/grain-cli.ts`. Every command, every flag, the exact JSON shape it emits, and how many API requests it costs. Invoke as `grain <command>` or `npx tsx plugins/ks/scripts/grain-cli.ts <command>`.

## Global behavior

- **Auth:** `GRAIN_API_TOKEN` (or `GRAIN_TOKEN`) from `plugins/ks/scripts/.env`. No flag accepts a token.
- **`-j/--json`** on every command. Human output is decorated and line-oriented; `-j` is stable and parseable. Parse only `-j`.
- **Exit codes:** `0` success; `1` for every failure (missing token, validation error, HTTP error, network error). Errors go to **stderr**, data to **stdout** — so `cmd -j 2>/dev/null | jq` is safe.
- **Rate limiting:** on `429` the CLI sleeps `Retry-After` seconds and retries, up to 3 attempts, logging each wait to stderr. Limit is 300 requests/minute.
- **Validation before I/O:** bad include key, bad transcript format, malformed date, and invalid tag are rejected before any request is sent, with the valid values printed.
- **Env:** `GRAIN_STORAGE_DIR` (export root, default `~/Documents/Grain`), `GRAIN_CRV_BIN` (claude-real-video binary, default `crv`), `GRAIN_API_VERSION` (default `2025-10-31`), `GRAIN_API_BASE_URL` (default `https://api.grain.com`), `GRAIN_OAUTH_CLIENT_ID`, `GRAIN_OAUTH_CLIENT_SECRET`, `GRAIN_OAUTH_REFRESH_TOKEN`.

### Shared include flags

Accepted by `recording list`, `recording get`, `recording export`, and `hook create` (recording events only).

| Flag | Values | Notes |
|---|---|---|
| `-i, --include <keys...>` | `highlights`, `participants`, `ai_summary`, `ai_action_items`, `private_notes`, `calendar_event`, `hubspot`, `screenshares`, `all` | Comma- or space-separated. Unrequested fields are **absent**, not null. `all` omits `private_notes` (personal-token only). Unknown key → exit 1. |
| `--ai-sections <titles>` | comma-separated section titles | Case-insensitive title match. Implies AI template sections are returned. |
| `--ai-format <format>` | `json` (default), `markdown`, `text` | Shape of each section's `data`. Section types are not enumerated by Grain — inspect with `-j` before parsing. |

---

## `recording list`

`grain recording list [filters] [include] [paging] [-j]`

| Flag | Effect |
|---|---|
| `-s, --search <text>` | Title substring match (titles only — there is no transcript search) |
| `--after <date>` | Lower bound. `YYYY-MM-DD` or ISO8601; a bare date becomes `T00:00:00Z` |
| `--before <date>` | Upper bound, same parsing |
| `--attendance <hosted\|attended>` | **Personal token only** |
| `--scope <internal\|external>` | Participant scope |
| `--team <uuid>` | From `grain team list` |
| `--meeting-type <uuid>` | From `grain meeting-type list` |
| `--cursor <cursor>` | Resume from a cursor a previous run printed |
| `--all` | Follow the cursor to the last page |
| `--pages <n>` | At most N pages (default 1) |
| `-l, --limit <n>` | Stop after N recordings — **trimmed client-side**, does not reduce requests |

Ordering is newest-first and not controllable.

**JSON:** `{ "recordings": [Recording...], "cursor": string|null }`. A non-null `cursor` means more pages; human output prints the resume hint.

**Cost:** 1 request per page. Page size is server-chosen; there is no page-size parameter.

**Recording object keys always present:** `id`, `title`, `start_datetime`, `end_datetime`, `duration_ms`, `media_type` (`audio|transcript|video`), `source` (`aircall|local_capture|meet|teams|upload|webex|zoom|other`), `share_state` (`public|workspace|restricted`, read-only), `url`, `thumbnail_url`, `tags[]`, `teams[]`, `recorders[]`, `meeting_type`. Everything else is include-gated: `participants[]`, `highlights[]`, `ai_summary.text`, `ai_action_items[]` (`text`, `status`, `timestamp`, `assignee`), `ai_template_sections[]` (`title`, `data`), `private_notes.text`, `calendar_event`, `hubspot`, `screenshares[]`.

---

## `recording get`

`grain recording get <recording-id> [include] [-j]`

**JSON:** a bare Recording object (not wrapped). **Cost:** 1 request. Human output additionally renders the AI summary, action items, template sections, private notes, highlights, screenshares, calendar, and HubSpot blocks when included.

---

## `recording window`

`grain recording window <recording-id> [-s <names>] [-m <regex>] [-p <seconds>] [--after <tc>] [--before <tc>] [-j]`

Derives a watch window from the transcript — **1 request, no media**. The step that most needs doing before spending anything, and the one that was previously improvised with ad-hoc jq on every run.

| Flag | Default | Effect |
|---|---|---|
| `-s, --speakers <names>` | – | Comma-separated, loose substring match (`"Jon,Jaswanth"` matches `Jonathan Allen`) |
| `-m, --match <regex>` | – | Keep only segments whose text matches, case-insensitive |
| `-p, --pad <seconds>` | `15` | Padding either side — on-screen artefacts appear before and after the words |
| `--after` / `--before <tc>` | – | Restrict the search to part of the call |

Human output gives the suggested `--from/--to` in both seconds and `HH:MM:SS`, the matching segment count, **the transcript line at each boundary** as evidence, and a speaker tally for the whole recording. JSON adds `from_sec`, `to_sec`, `span_sec`, `matched_segments`, `first_match`, `last_match`, and `speakers`.

Read the boundary lines before extracting: a boundary that reads like small talk means the window is too wide, and a match on the very last segment means it is probably too narrow.

## `recording transcript`

`grain recording transcript <recording-id> [-f json|txt|vtt|srt] [-o <file>] [-j]`

| Flag | Effect |
|---|---|
| `-f, --format` | Default `json`. `txt` = `Speaker: text` lines, `vtt` = WebVTT, `srt` = SubRip |
| `-o, --output <file>` | Write to file instead of stdout; prints the byte size |
| `-j, --json` | `format=json` only: emit the raw segment array |

**JSON (format=json):** `[{ start (ms), end (ms), text, speaker, participant_id }]`. Without `-j`, segments print as `mm:ss Speaker: text`.

**406 fallback:** some recordings return `406 Not Acceptable` on `.vtt`/`.srt`/`.txt` while the JSON transcript works. The CLI detects that, fetches the JSON segments, and builds the requested format locally (`Speaker: text` cues, millisecond-accurate stamps), warning on stderr. Costs 2 requests instead of 1. Never treat a 406 here as "this recording has no transcript".

**Cost:** 1 request per recording **per format**. An empty array means the transcript isn't ready.

---

## `recording download`

`grain recording download <recording-id> [-o <file>]`

Writes the media file; default name `grain-<recording-id>.<ext>`. Extension is derived from `content-disposition`, else `content-type` (`mp4`/`mov`/`mp3`/`m4a`). Follows the storage redirect. No `-j`. **Cost:** 1 request. Prefer `recording export` unless you specifically want a single loose file.

---

## `recording export`

`grain recording export <recording-id...> [-d <dir>] [-f <formats>] [--no-media] [--no-metadata] [--force] [include] [-j]`

The archiver: media + transcript(s) + sidecar JSON, one folder per recording.

| Flag | Default | Effect |
|---|---|---|
| `-d, --dir <path>` | `$GRAIN_STORAGE_DIR`, else `~/Documents/Grain` | Storage root for this run; `~` is expanded |
| `-f, --formats <list>` | `vtt` | Comma-separated from `json,txt,vtt,srt` |
| `--no-media` | media included | Transcripts only |
| `--no-metadata` | JSON written | Skip the recording-object sidecar |
| `--force` | skip existing | Overwrite files that already exist |

**Folder:** `<root>/<start-date>_<title-slug>_<id-prefix>/`, e.g. `2026-08-14_all-hands-q3-kickoff_pppp6666/`. Slug is Unicode-normalized, non-alphanumerics collapsed to `-`, lowercased, capped at 60 chars (`untitled` when empty); date is `no-date` when the recording has no start time; id prefix is the first UUID group.

**Files:** all share the folder name as base — `<base>.<media-ext>`, `<base>.<format>` per transcript format, `<base>.json` for the recording object (enriched by include flags). `-f json` is written as `<base>.transcript.json` so it cannot overwrite the metadata sidecar.

**Idempotency:** existing files are skipped and reported as `= <name> (exists — pass --force to overwrite)`. The media check tests every possible extension **before** fetching, so a re-run costs no media bytes. Safe to use as a sync loop.

**JSON:** `{ "storageRoot": string, "recordings": [{ "id", "title", "folder", "files": [names written], "skipped": [names skipped] }] }`

**Cost per recording:** 1 metadata + 1 media (unless `--no-media`) + 1 per transcript format. Accepts many ids and processes them sequentially.

---

## `recording watch`

`grain recording watch <recording-id...> [-w <text>] [-d <dir>] [-o <dir>] [-f <formats>] [--max-frames <n>] [--scene <n>] [--fps-floor <n>] [--crv-args "<flags>"] [--crv <bin>] [--skip-export] [--force] [include] [-j]`

Runs `export` (media forced on), then invokes [claude-real-video](https://github.com/HUANGCHIHHUNGLeo/claude-real-video) on the downloaded file so its keyframes and transcript can be read. Use for questions whose answer is on screen rather than in the words.

| Flag | Default | Effect |
|---|---|---|
| `-w, --why <text>` | – | Forwarded as crv `--why`; orients the manifest around your question |
| `-d, --dir <path>` | `$GRAIN_STORAGE_DIR`, else `~/Documents/Grain` | Export storage root |
| `-o, --out <path>` | `<recording folder>/crv-out` | crv output directory |
| `-f, --formats <list>` | `vtt` | Transcript sidecars written by the export step |
| `--max-frames <n>` | crv's 150 | Hard cap on frames |
| `--scene <n>` | crv's 0.30 | Scene sensitivity; lower = more frames |
| `--fps-floor <n>` | crv's 1.0 | At least one frame every N seconds |
| `--from <timecode>` | – | Analyze only from this point; passed to crv as `--from` |
| `--to <timecode>` | – | Analyze only up to this point; passed to crv as `--to`. Either bound may be omitted |
| `--no-grid` | grid on | Skip crv's 3×3 contact sheets (they are requested by default — fewer images to read) |
| `--full-res` | off | Probe the source width with `ffprobe` and pass it as crv `--frame-width` |
| `--frame-width <px>` | crv's 640 | crv `--frame-width`; wins over `--full-res` |
| `--crv-args "<flags>"` | – | Space-split and appended verbatim (e.g. `"--report --keep-audio"`) |
| `--crv <binary>` | `$GRAIN_CRV_BIN`, else `crv` | Executable to run |
| `--skip-export` | off | Reuse an already-exported folder; fails if no media is there |
| `--force` | off | Re-download and overwrite export files |

**Preconditions:** `crv` **0.10.1 or newer** and `ffmpeg`/`ffprobe` on `PATH`. Missing `crv` exits 1 with `pip install "claude-real-video[whisper]"`; a missing `ffmpeg` surfaces as a crv failure. crv's exit status is propagated.

The version gate has two halves. `--frame-width`/`--from` (0.10.0) are sniffed out of `crv --help`. 0.10.1 added no flag — it fixed behaviour `watch` now depends on — so the version is read from the installed distribution: the resolved launcher's shebang names its interpreter, and that interpreter is asked for `importlib.metadata.version('claude-real-video')`. Below 0.10.1 exits 1 with an upgrade hint. A launcher that is not a Python console script prints a warning naming both symptoms and continues.

**Transcript reuse:** the export step writes `<base>.vtt` next to `<base>.mp4` with an identical stem, which is the sidecar crv prefers over transcribing — so Whisper never runs and no flag is required. The human output states which path was taken. If you need crv's own `--no-transcribe` (visual-only, audio untouched), pass it through `--crv-args "--no-transcribe"`.

**Time windows:** `--from`/`--to` accept seconds (`90`), `mm:ss` (`12:30`), or `hh:mm:ss(.ms)`. Omitting `--to` runs to the end of the file and slugs as `end`. The analysis goes to `crv-out_<from>_<to>/`, so windowed and full passes coexist. **Reported timestamps are source timecodes in every window** — crv shifts them back onto the source clock, so no offset arithmetic is ever needed.

Both bounds go straight to crv, and the media is never cut. Through 0.10.0 `--to` silently discarded every frame timestamp (`-t` was an output-side limit, so `showinfo` logged more frames than ffmpeg wrote and `frames.json` was never written), which this CLI worked around with a stream-copied `<base>_head_<to>.<ext>` head clip — ~100MB per bounded run. crv 0.10.1 moved `-t` to the input side (upstream #19/#21) and the clip is gone.

**The sidecar transcript is windowed too** (0.10.1, upstream #20/#23): the exported Grain transcript is clipped to `--from`/`--to`, and its cue times stay on the source clock — `--from 9 --to 21` over a 30s sidecar yields only the 9–21s cues, starting at `9.0`. Verified on 0.10.1.

**Analysis output** (in the crv directory): `MANIFEST.txt` (frame index with timestamps + transcript — read first), `grids/*.jpg` (3×3 contact sheets), `transcript.txt`, `frames/*.jpg`, `frames.json`, plus `frame-map.tsv` and `grid-map.tsv` written by this CLI. With `--full-res`/`--frame-width`, `frames-by-time/` hardlinks the same frames under absolute source timecodes (`t00-38-08.jpg`; colliding seconds carry milliseconds). Human output ends with those paths; the transcript path falls back to the exported sidecar when crv wrote none.

**JSON:** `{ "watched": [{ "id", "title", "folder", "media", "transcript", "analysis" }] }`. Passing `-j` silences crv's own stdout.

**Cost:** identical Grain requests to `export` (1 metadata + 1 media + 1 per format, per recording, none when `--skip-export`), plus local CPU in crv. Recordings are processed sequentially.

**Output contract:** see `crv-output.md` in this folder for every file crv writes, the frame-selection rules, and the manifest layout.

**Reading the result:** `MANIFEST.txt` → `grids/` contact sheets → individual `frames/` only where detail is needed, citing timestamps. The manifest's `--- timeline ---` already places each frame inside the speech span containing it (and marks `(no speech)` gaps), so frame-to-transcript alignment needs no work on your side. Loading every file in `frames/` defeats the dedup that makes this cheap.

**Sizing:** with `--max-frames` unset, crv keeps `clamp(150, duration_seconds × 1.5, 600)` frames — a 47-minute call hits the 600 ceiling (67 grids). crv also copies the input to `crv-out/source.mp4`, so budget ~2× the media size on disk.

---

## `recording frames`

`grain recording frames <recording-id> [--at <list>] [--every <n>] [--from <tc>] [--to <tc>] [--crop <W:H:X:Y>] [--crop-in-grid <W:H:X:Y>] [--grid-cell-width <px>] [--upscale <n>] [--max-dim <px>] [-d <dir>] [-o <dir>] [--force] [-j]`

Arbitrary-timestamp extraction at source resolution — the escape hatch from crv's dedup, and where **every legible read of on-screen text comes from**.

| Flag | Default | Effect |
|---|---|---|
| `--at <list>` | – | Comma-separated source timecodes (`2286`, `0:38:06`) |
| `--every <n>` | – | Sample every N seconds across `--from`/`--to`, ignoring dedup entirely |
| `--from` / `--to <tc>` | 0 / end | Range for `--every` |
| `--crop <W:H:X:Y>` | – | ffmpeg crop, in **source pixels** |
| `--crop-in-grid <W:H:X:Y>` | – | Crop measured **inside a contact-sheet cell**, scaled to source for you. Use this after eyeballing a grid — deriving the factor by hand cost one run 3–5 iterations per region, and a bad crop silently truncated a list into a wrong transcription |
| `--grid-cell-width <px>` | `480` | Cell width the `--crop-in-grid` numbers came from |
| `--upscale <n>` | – | Lanczos factor after cropping — what makes small text readable |
| `--max-dim <px>` | `2000` | Clamp the long edge; `0` disables. Claude rejects images over 2000px per side once a request holds more than 20. A clamp that eats into a requested `--upscale` now names the effective factor (`--upscale 3` on a 700px crop → 2.86) |
| `--force` | off | Overwrite existing frames. Note that a skip is silent (`N already present`), so a partial no-op is possible without `--force` |

**Filenames** are source timecodes plus a crop/upscale fingerprint — `t00-38-06_c459x299x560x149_x3.jpg`. The timecode means citations need no offset arithmetic; the fingerprint means two different crops of one moment can't overwrite each other, which previously happened mid-run under `--force` and invalidated citations silently.

**Cost:** 1 metadata request + media (if not already exported) + one local ffmpeg seek per timestamp. No Grain requests for the extraction itself. Exits 1 if every frame fails.

**Keep the gutters.** Cropping to the content alone discards the coordinate system — a run read a spreadsheet correctly and couldn't cite a single cell, because row numbers and column letters sat outside every crop.

## `recording upload`

`grain recording upload <file> [-u <user-id>] [-j]`

Two-step under the hood: requests a presigned ticket, then PUTs the raw bytes. Rejects anything that isn't `.mov`/`.mp4`/`.mp3`/`.m4a` before uploading, and aborts if the file exceeds the `max_upload_bytes` the ticket reports.

`-u, --user-id <uuid>` sets the owner and is **required with a workspace token** (get it from `grain user list`).

**JSON:** `{ "uuid", "filename", "bytes", "uploaded": true }` — `uuid` is the **upload** id, not a recording id. Grain reports processing completion and the resulting `recording_id` **only** to an `upload_status` webhook; nothing can be polled. Register the hook before uploading.

**Cost:** 2 requests (1 API + 1 unauthenticated PUT to the presigned URL).

---

## `recording update`

`grain recording update <recording-id> -t "<title>" [-j]`

`--title` is required and is the only writable field — tags, sharing, and share-state have their own commands or are read-only. **JSON:** `{ "success": true }`. Nothing echoes the new state; re-fetch with `recording get`. **Cost:** 1 request.

---

## `recording tag`

```
grain recording tag add <recording-id> <tag> [-j]
grain recording tag remove|rm <recording-id> <tag> [-j]
```

Tags must match `letters/digits, dash-separated, no leading dash` (Unicode letters allowed, spaces and underscores not) — checked client-side before the request. `rm` percent-encodes the tag into the path. **JSON:** `{ "success": true }`. **Cost:** 1 request. Duplicate-add and missing-remove behavior is unspecified by Grain.

---

## `recording share` / `recording unshare`

```
grain recording share   user <recording-id> <user-id>   [-j]
grain recording share   team <recording-id> <team-id>   [-j]
grain recording unshare user <recording-id> <user-id>   [-j]
grain recording unshare team <recording-id> <team-id>   [-j]
```

Boolean grants — there are no roles or permission levels, and one target per call. Ids come from `grain user list` / `grain team list`. `share team` sends the id in the body and retries the path form on 404/405, because Grain documents both. **JSON:** `{ "success": true }`. **Cost:** 1 request (2 on the team fallback path). There is no way to list which individual users a recording is shared with.

---

## `hook create`

`grain hook create <hook-url> -t <type> [--transcript] [--speakers] [include] [-j]`

`-t, --type` is required, one of: `recording_added`, `recording_updated`, `recording_deleted`, `highlight_added`, `highlight_updated`, `highlight_deleted`, `story_added`, `story_updated`, `story_deleted`, `upload_status`.

Include handling by type: recording events take the shared include flags; `highlight_added`/`highlight_updated` take `--transcript`/`--speakers`; the rest take none.

**Grain probes `hook-url` at creation and the endpoint must answer 2xx** or creation fails. **JSON:** `{ id, enabled, hook_url, hook_type, include, inserted_at }`. **Cost:** 1 request.

Delivery payload is `{ type, user_id, data }`. Only the recording-event `data` shape is documented; highlight, story, `*_deleted`, and `upload_status` payloads are unspecified — log raw bodies first. **Payloads are unsigned**: no secret, no signature header, no documented retry or timeout. Verify by re-fetching `grain recording get <data.id>`, and reconcile with a periodic `grain recording list --after <last-run>`.

---

## `hook list` / `hook delete`

```
grain hook list [-t <type>] [--state enabled|disabled] [-j]
grain hook delete|rm <hook-id> [-j]
```

`hook list` JSON is a bare array of hook objects (no pagination exists). `hook delete` returns `{ "success": true }`. **Cost:** 1 request each. There is no update command — delete and recreate, which yields a new id.

---

## Directory commands

```
grain user list [-s <text>] [-j]     # JSON: [{ id, name, email }] — filter is client-side, name or email
grain team list [-j]                 # JSON: [{ id, name }]
grain meeting-type list [-j]         # JSON: [{ id, name, scope }]
```

1 request each, unpaginated. These are the only source of the ids that `--team`, `--meeting-type`, `--user-id`, and the share commands take. Grain exposes no roles and no team membership, so a user's team cannot be looked up.

---

## `auth check`

`grain auth check [-j]`

Grain has no whoami endpoint, so this probes the user list. **JSON:** `{ ok: true, apiVersion, baseUrl, visibleUsers }`. A `401` here means the token is bad; a low `visibleUsers` on a token you expected to be workspace-wide means it's actually personal. **Cost:** 1 request.

---

## OAuth commands

Only for building an integration other Grain users authorize. For your own automation use a token in `.env` instead. Client id/secret and refresh token default to `GRAIN_OAUTH_CLIENT_ID` / `GRAIN_OAUTH_CLIENT_SECRET` / `GRAIN_OAUTH_REFRESH_TOKEN`; the flags are one-off overrides. Missing values fail with the env var name.

```
grain oauth authorize-url --redirect-uri <uri> [--client-id <id>] [--code-verifier <v>] [--state <s>] [-j]
grain oauth token --code <code> [--client-id <id>] [--client-secret <s>] [--code-verifier <v>] [-j]
grain oauth refresh [--refresh-token <t>] [--client-id <id>] [--client-secret <s>] [-j]
```

`authorize-url` generates a PKCE verifier/challenge pair locally (S256) and prints the URL plus the verifier you must keep — **JSON:** `{ url, code_verifier, code_challenge }`. No network call. `--state` is sent for CSRF protection even though Grain doesn't document it.

`token` and `refresh` both hit the token endpoint (1 request, JSON body, no auth headers) and emit `{ token_type, access_token, refresh_token?, expires_in? }`. **Refresh rotates the refresh token — persist the newest one.** A response without `expires_in` means a legacy client whose token never expires.

---

## Command → endpoint map

For debugging an unexpected response or a raw-body error message.

| Command | Endpoint |
|---|---|
| `recording list` | `POST /v2/recordings` |
| `recording window` | `GET /v2/recordings/:id/transcript` |
| `recording frames` | `POST /v2/recordings/:id` + `GET …/download` (once), then local ffmpeg |
| `recording get`, `export`/`watch` (metadata) | `POST /v2/recordings/:id` |
| `recording transcript`, `export`/`watch` (transcripts) | `GET /v2/recordings/:id/transcript[.txt\|.vtt\|.srt]` |
| `recording download`, `export`/`watch` (media) | `GET /v2/recordings/:id/download` |
| `recording upload` | `POST /v2/recordings/upload` then `PUT <presigned url>` |
| `recording update` | `PATCH /v2/recordings/:id` |
| `recording tag add` / `rm` | `PUT /v2/recordings/:id/tags` / `DELETE /v2/recordings/:id/tags/:tag` |
| `recording share user` / `unshare user` | `PUT /v2/recordings/:id/users` / `DELETE /v2/recordings/:id/users/:user_id` |
| `recording share team` / `unshare team` | `PUT /v2/recordings/:id/teams` (fallback `/teams/:team_id`) / `DELETE /v2/recordings/:id/teams/:team_id` |
| `hook create` / `list` / `delete` | `POST /v2/hooks/create` / `POST /v2/hooks` / `DELETE /v2/hooks/:hook_id` |
| `user list` / `team list` / `meeting-type list` / `auth check` | `POST /v2/users` / `POST /v2/teams` / `POST /v2/meeting_types` / `POST /v2/users` |
| `oauth token` / `refresh` | `POST /oauth2/token` |

All paths are under `https://api.grain.com/_/public-api`. Reads are POST with the filters in a JSON body, which is why an error body may reference a POST on a URL that looks like a plain resource.

## No command exists for

Deleting a recording (Grain has no endpoint — UI only), updating a hook (delete and recreate), changing `share_state`, listing per-user shares, searching transcripts, polling upload status, or listing highlights standalone. If asked for one of these, say it isn't available rather than improvising a request.
