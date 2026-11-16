# ks-browser

Browser testing for KarmaSuite sessions. Loaded only on demand:

```bash
claude-ks-test            # same as: claude-ks --local-plugin ks-browser
```

## What's in it

- **agent-browser MCP server** (`.mcp.json` → `scripts/agent-browser-mcp`):
  [agent-browser](https://agent-browser.dev) (Vercel Labs, Apache-2.0), pinned
  to `0.41.2` and run with `npx`. It drives Chrome over CDP with compact
  accessibility snapshots and `@eN` refs, which take far fewer tokens than full
  page dumps. Tools are `mcp__plugin_ks-browser_agent-browser__agent_browser_*`.
  - **One browser per checkout:** the MCP server script (`scripts/agent-browser-mcp`) sets `AGENT_BROWSER_SESSION`
    to `ks-<checkout folder>` (a long folder name is cut to 15 characters
    plus a hash, because agent-browser's socket path is capped at 103
    bytes), so ticket sessions testing in parallel never share a browser or
    tabs.
  - **Tool profiles:** `core,debug,state,tabs` (navigation and interaction,
    recording and `batch`, saved sign-in state, tabs). Override with
    `KS_BROWSER_TOOLS`.
  - **Window size:** 1512×982 (a 14" MacBook Pro screen, in points), hidden
    or visible. Set `KS_BROWSER_WINDOW=WxH` to override.
  - **Browser:** agent-browser launches its own Chrome (found from your
    installed one) with a clean profile, hidden by default. None of your
    Chrome profiles, accounts or tabs are reachable from it, and it never
    attaches to your running Chrome.
  - **A saved sign-in per checkout:** the launcher sets
    `AGENT_BROWSER_RESTORE=karmasuite`, so agent-browser saves the browser's
    cookies and storage under `~/.agent-browser/namespaces/ks-browser/` and
    loads them on every launch. agent-browser joins that name with the
    session's, so each checkout keeps its own. The first time a non-local app
    (a PR preview, staging) asks for a sign-in, the skill reopens the browser
    in a visible window and you sign in yourself; the agent never types your
    credentials. On a local address it signs in with a seed test user.
    - The saved file is encrypted (AES-256-GCM) with a key the launcher keeps
      in your login Keychain ("ks-browser agent-browser sign-in key"),
      generated on first use. Without the key the server doesn't start, so a
      sign-in is never saved in plain text. An
      `AGENT_BROWSER_ENCRYPTION_KEY` already set wins.
    - agent-browser deletes saved sign-ins after 30 days; Clerk may end the
      session sooner, and then you sign in again.
    - Cookies belong to one address, so each PR preview may need its own
      first sign-in.
- **`test-video` skill:** tests a change in the browser and records it as a
  review video:
  - a title card before each check, 6 s: the page blurs behind a rounded
    charcoal card with a step label, title and subtitle (`scripts/title-card.js`,
    which the launcher loads into every page through
    `AGENT_BROWSER_INIT_SCRIPTS`, so it survives navigation);
  - Loom-style click marks while recording: every real press shows a
    yellow circle that fades in, grows (ease-out) and fades out in 0.7 s,
    two for a double-click, and a field filled without a click gets one too.
    The pointer itself is agent-browser's `--cursor`;
  - a PASS/FAIL banner after each check, 6 s: a charcoal pill near the top
    with a green check or red cross, over the page left sharp so the result
    stays visible;
  - `scripts/finish-video.mjs` cuts the still stretches (the agent thinking
    between actions) so they play 8x faster, writes one MP4 chapter per
    check, and joins a long test recorded in parts into one video with
    continuous chapters;
  - captions of the steps: each `__ksVideo.note(...)` says which page and
    what is clicked or typed, and one "Observed:" note ends each check (no
    explanations; the card already says what's tested and expected). They
    show as white text in one black box near the bottom of the page, two
    lines at most, drawn by the page itself (this ffmpeg can't burn in
    subtitles). The video plays at real speed while each is read (15
    characters a second, 2–12 s);
  - a WebVTT transcript of the cards, steps, observations and verdicts,
    beside the video for reading and search (not embedded, so nothing shows
    twice);
  - a `report.md` with one row per check.

  Title cards keep moving (a shrinking progress bar), so the cut leaves them
  whole.

## Requirements

- Node 24+ (agent-browser's requirement).
- `ffmpeg` and `ffprobe` on `PATH`, with `libvpx` and `libx264`
  (`brew install ffmpeg`). Used for recording and for `finish-video.mjs`.

## Output

The `test-video` skill writes to `<checkout>/.ks-test-runs/<ticket number>/`
(a timestamp when there's no ticket), which is in the karmasuite checkout's
`.git/info/exclude`. `finish-video.mjs` runs in the sandboxed shell, which
can't write outside the checkout, so a request for another location gets a
`cp` command at the end.

```
raw.webm                 the raw recording (agent-browser, 24 fps)
chapters.json            title cards and verdicts with their times
raw-review.mp4           the review video: stills cut, chapters added, captions in the picture
raw-review.vtt           the transcript: title cards, the agent's notes and verdicts, timed to the review video
report.md                one row per check: PASS/FAIL, what was seen, time in the video
```

agent-browser's `--contact-sheet` is not used: when its frame analysis falls
behind (seen on a 13-minute, 3024×1722 recording), `record stop` fails and
the whole video is lost.
