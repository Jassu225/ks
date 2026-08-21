# `grain` CLI — complete command reference

Operator's reference for driving `plugins/ks/scripts/grain-cli.ts`. Every command, every flag, the exact JSON shape it emits, and how many API requests it costs. Invoke as `grain <command>` or `npx tsx plugins/ks/scripts/grain-cli.ts <command>`.

## Global behavior

- **Auth:** `GRAIN_API_TOKEN` (or `GRAIN_TOKEN`) from `plugins/ks/scripts/.env`. No flag accepts a token.
- **`-j/--json`** on every command. Human output is decorated and line-oriented; `-j` is stable and parseable. Parse only `-j`.
- **Exit codes:** `0` success; `1` for every failure (missing token, validation error, HTTP error, network error). Errors go to **stderr**, data to **stdout** — so `cmd -j 2>/dev/null | jq` is safe.
- **Rate limiting:** on `429` the CLI sleeps `Retry-After` seconds and retries, up to 3 attempts, logging each wait to stderr. Limit is 300 requests/minute.
- **Validation before I/O:** bad include key, bad transcript format, malformed date, and invalid tag are rejected before any request is sent, with the valid values printed.
- **Env:** `GRAIN_STORAGE_DIR` (export root, default `~/Documents/Grain`), `GRAIN_API_VERSION` (default `2025-10-31`), `GRAIN_API_BASE_URL` (default `https://api.grain.com`), `GRAIN_OAUTH_CLIENT_ID`, `GRAIN_OAUTH_CLIENT_SECRET`, `GRAIN_OAUTH_REFRESH_TOKEN`.

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

## Watching (frames) — not this CLI

Frame extraction lives in the **claude-video-vision** MCP server (`video_info`, `video_analyze`, `video_watch`, `video_detail`), not here. The CLI's job ends at `export`: media plus subtitle sidecar plus metadata on disk. See `watching-recordings.md` for the seam, including the two settings that matter most for meeting recordings (`skip_audio: true`, and a high `resolution` with `frame_format: "png"` for on-screen text).

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
| `recording get`, `export` (metadata) | `POST /v2/recordings/:id` |
| `recording transcript`, `export` (transcripts) | `GET /v2/recordings/:id/transcript[.txt\|.vtt\|.srt]` |
| `recording download`, `export` (media) | `GET /v2/recordings/:id/download` |
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
