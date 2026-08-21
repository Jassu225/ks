---
date: 2026-08-21T13:57:22+05:30
git_commit: 2ba3cdc
branch: feat/grain-cli
task: Grain CLI + skill + recording-watcher agent; two competing frame-extraction backends parked on separate branches; six rounds of fixes driven by real peer-session runs
---

# Handoff: Grain CLI, and the crv-vs-video-vision decision that is still open

> Repo guidance: `CLAUDE.md`. Skill: `plugins/ks/skills/grain-cli/` (SKILL.md +
> `references/cli-reference.md`, `references/crv-output.md`). Agent:
> `plugins/ks/agents/grain-recording-watcher.md`.

## What Happened

Built a CLI for the [Grain public API v2](https://developers.grain.com/) covering every
documented endpoint, a skill documenting it, and an agent that uses both to answer
questions about meeting recordings — then spent most of the session hardening all three
against what actually broke when other sessions used them.

**The API surface** was mapped by five parallel agents reading the (single-page, no-OpenAPI)
docs; their specs are in this session's scratchpad. Notable API facts now encoded in the
skill: reads are `POST` with filters in a JSON body, list pagination is an opaque cursor with
no page-size control, transcripts cost one request per recording per format, uploads report
completion only via an `upload_status` webhook, hooks are unsigned, there is no
delete-recording endpoint, and some recordings `406` on the formatted transcript endpoints
(the CLI rebuilds those locally from the JSON transcript).

**Two frame-extraction backends were tried, and they are now on separate branches:**

- `feat/grain-cli` (this branch, 2ba3cdc) — **claude-real-video (crv)**. `recording watch`
  wraps it; `--from/--to` clips a window with ffmpeg because crv has no time-range flag;
  `--full-res` re-extracts crv's chosen timestamps at source resolution because crv
  hardcodes `scale=640:-1`; `recording frames` extracts arbitrary timestamps with
  crop/upscale because crv's dedup discards the incremental on-screen edits that carry
  meaning on a screen being typed into.
- `feat/grain-video-vision` (7703923, pushed to both remotes) — **claude-video-vision MCP**.
  Removes the video layer from the CLI entirely (-564 lines); per-segment start/end,
  resolution up to 2048, and png are native parameters, so all three workarounds disappear.

**The evidence that decided nothing yet, and the fact that reopened it:** two peer sessions
ran both paths against the same 47-minute call. cvv read spreadsheet cells verbatim at
`resolution: 2048` with no cropping, and `video_analyze`'s scene scores narrowed a window
better than a transcript guess. But **crv is actively maintained (8 commits in the two weeks
to 2026-08-18, 0 open issues, three releases in two days) while cvv's last code change was
2026-05-18 — three months ago, 17 open issues.** cvv also has two unfixed crashes: `png`
kills the server, and so does a 90-frame batch at 2048px.

**Six rounds of fixes came from peer post-mortems**, each verified against a cached call
rather than asserted. In rough order of how much they cost before being found:

- The agent completed a 16KB report, told its caller it had nothing, and acknowledged a
  stand-down while holding it — the caller redid the whole job by hand. Now: finishing means
  delivering; never ack a stand-down holding an artifact.
- `recording frames --max-dim` emitted `min(iw,2000)` with bare commas; ffmpeg read them as
  filterchain separators, every frame failed, and it printed "0 frame(s)" and **exited 0**.
  (In a JS template literal `\,` collapses to `,`; it needs `\\,`.) The flag arrived in the
  working tree from another session and `git add -A` swept it into the first commit untested.
- A report cited `frame_051.jpg @00:38:08` for a frame that was at 30:32, using a +1920s
  offset where the truth was +1770 — correct findings, unfollowable provenance. `--full-res`
  now names frames by absolute source timecode (`t00-38-08.jpg`) plus a `frame-map.tsv`.
- Silence during a 131MB download made a caller conclude the agent was dead and start a
  competing run; two runs in one folder deleted the frames behind a finished report. Now:
  progress lines every 5s, and a `.grain-lock` per recording folder.
- `--max-dim` clamped on every call and silently cut a requested `--upscale 3` to 2.86.
- Deriving crop geometry by hand cost 3–5 iterations per region, and one bad crop truncated a
  list (five entries instead of seven) which would have shipped as a wrong transcription.
  Now `--crop-in-grid`.

## Key Decisions Made

- **Skill = manual, agent = workflow driver.** Watching pulls dozens of images into context;
  the agent absorbs that and returns prose plus a report. Delegation is now the skill's first
  section and the agent's description claims the job, after a session drove the CLI inline
  twice — both times because the guidance sat at line 64 where it was never read.
- **Secrets are env-only.** No command takes a token as an argument, including the OAuth
  client secret and refresh token.
- **crv's value is its selection, not its manifest.** A peer verified a run against the
  frames: scene-change selection caught a four-line enumeration typed into a sheet and
  deleted 25 seconds later — invisible to 60s uniform sampling. The manifest, meanwhile,
  failed at the alignment it exists for. Timecoded filenames replace what it was for.
- **`watch` maps, `frames` reads.** Of 180 frames a watch kept, only ~23 fell inside a
  15-minute screen share; webcam tiles change more than a spreadsheet being typed into.
- **Never trust figures from the transcript.** Grain rendered on-screen `6000 salaries` as
  "$6,000 salary" and `7010` as "710"; a caller relayed the corrupted figures downstream.
- **MCP for discovery, CLI for media.** A Grain MCP (`search_in_transcripts`, `list_meetings`)
  beat everything for "which day was this discussed" and corrected the user's premise.
- **Refused the stdio JSON-RPC workaround.** When the video MCP tools were absent from a
  subagent, driving the server directly was rejected: it reimplements a handshake against a
  shifting interface and routes around the permission surface. The real cause was our own
  `tools:` allowlist excluding `mcp__*`.

## Deviations from Plan

The migration to claude-video-vision was completed and committed as asked, then the
maintenance data reopened the question — hence two branches instead of one. Nothing was
reverted; both paths are intact and pushed.

## Uncommitted Changes

None. `feat/grain-cli` is at `2ba3cdc` with a clean tree; `dist/` (gitignored) is rebuilt.

## Known Issues

- **The backend choice is genuinely open.** crv = maintained upstream + better selection +
  three local workarounds; cvv = nicer API + two unfixed crashes + a dormant repo. Neither
  branch is merged to `main`.
- **Three code paths have never executed:** the `.grain-lock` refusal, the `$TMPDIR`
  findings fallback, and the `crv-out…-2` side-step. Two deliberate concurrent watches on the
  cached recording would settle the first and third cheaply.
- **`--crop-in-grid` has only ever run against one 1280x720 source.** The width probe is
  correct by inspection but unverified on a 1920 or portrait recording.
- **`~/Documents/Grain` is not writable from a sandboxed session** (the agent falls back to
  `$TMPDIR/grain-findings/`). Add it to `sandbox.filesystem.write.allowOnly` if that matters.
- **`feat/grain-cli` is unpushed** — only `feat/grain-video-vision` reached the remotes.
- Report front matter should carry cell/field coordinates for spreadsheet content; a run
  produced correct contents with no cell addresses because its crops excluded the gutters.

## Resume Point

1. **Decide the backend.** Read this handoff's evidence, then either merge `feat/grain-cli`
   or revive `feat/grain-video-vision`. My recommendation: keep crv and file two upstream
   issues — a time-range flag and a configurable frame width — on a repo with zero backlog
   that shipped three releases in two days. That would delete `--from/--to` clipping and
   `--full-res` from our side entirely. Draft them from the reproductions in this handoff.
2. **Push this branch**: `git push -u origin feat/grain-cli && git push jassu feat/grain-cli`,
   then open a PR (no `Closes KAR-XXX` — this is the plugin monorepo, not a KarmaSuite project).
3. **Settle the three untested paths** if you want them trusted: start two `grain recording
   watch` runs on `eb542359-ab12-4c67-a6db-e70935172cab` concurrently and confirm the second
   refuses with the holder's pid, then that a killed run's stale lock auto-clears.
4. **Verify `--crop-in-grid` on a non-720p recording** — any 1920-wide call will do; the
   factor should print `(1920÷480)` = 4.0.
5. Open question worth one experiment: whether crv's `MANIFEST.txt` frame↔speech timeline is
   worth anything now that filenames carry absolute timecodes. Nobody has judged it post-fix.
