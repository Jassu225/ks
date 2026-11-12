---
name: test-video
description: Test a web app change in the browser with the agent-browser MCP tools and record the run as a short review video, with a title card before each check, PASS/FAIL banners, still stretches cut, and MP4 chapter markers. Use when asked to test a change in the browser, record a test run, or make a video of a flow.
---

# Test video

Run browser checks with the agent-browser MCP tools
(`mcp__plugin_ks-browser_agent-browser__agent_browser_*`, called `ab_*`
below) and turn the recording into a review video the user can watch fast:
title cards mark each check, still stretches play 8x faster, and the video's
chapter list jumps straight to each check.

This skill's folder holds two scripts:
- `scripts/title-card.js`: defines `window.__ksVideo`; the MCP server loads
  it into every page (`AGENT_BROWSER_INIT_SCRIPTS`).
- `scripts/finish-video.mjs`: cuts the raw recordings, joins parts, and adds
  the chapters and transcript.

## 1. Plan the checks

List the checks before recording: for each, a short title ("Filter by ENA"),
what you do, and what you expect to see. Each check is one chapter. Keep them
on one origin (the app's URL): chapters are kept in the page's
`localStorage`.

Output folder: `<checkout>/.ks-test-runs/<ticket number>/` (`KAR-13284`; with
no ticket, `YYYY-MM-DD_HH-MM-SS`), created with `mkdir -p`. If it already
holds an earlier run, ask the user whether to replace it or keep it (then use
`<ticket number>-2`, …). Use absolute paths in every tool call. Only if the
user asks for the files somewhere outside the checkout: still write them
here (the shell can't write outside it), and give them a `cp` command at the
end.

## 2. Open the app and sign in (not recorded)

The browser is agent-browser's own (a clean profile), **hidden by default**.
Tell the user so before you start, and offer a visible window if they want to
watch: `ab_close`, then `ab_open` with `extraArgs: ["--headed"]`. The saved
sign-in carries over either way. The sign-in is saved for this checkout, so
the user signs in once per checkout.

1. `ab_open` the app's URL. If the app is signed in, go on.
2. If it shows a sign-in page:
   - **A local address** (`localhost`, `127.0.0.1`): sign in with a local test
     user from the project's seed or example config files. Never a real
     account.
   - **Any other address** (a PR preview, staging): the user signs in
     themselves. `ab_close`, then `ab_open` the same URL with
     `extraArgs: ["--headed"]` so a window shows, and ask the user to sign in
     in that window and tell you when they're done. Never type their
     credentials. Then `ab_close` (this saves the sign-in) and `ab_open` the
     URL again.
3. Stay on the app under test: no other sites, and no changes to data the
   checks don't need.
4. A page stuck loading for a long time (a cold preview) gets one reload
   before you treat it as a failure; note it in the transcript.

Then go to the page where the first check starts.

## 3. Check the title cards, and whether eval waits

1. `ab_eval` `typeof __ksVideo` should return `"object"`. If it returns
   `"undefined"` (the server was started some other way), `ab_eval` the
   file's whole text after each navigation instead.
2. `ab_eval` `__ksVideo.hold(1500)`. If it returns `"held 1500 ms"` after
   about 1.5 s, eval waits for promises: below, a card's wait goes in the same
   eval (`__ksVideo.hold(6000)` last). If it returns at once, follow each card
   or verdict eval with `ab_wait_ms` 6000 instead.

**Keep tool output small.** `ab_batch` echoes every command and its lifecycle
in its result (10–30 KB for a few notes). Put a card, its notes and its wait
in one `ab_eval` script, not a batch. Use `ab_batch` for runs of actions, with
`omitCommand: true`.

## 4. Record

Start the recording and mark its start in **one** batch, so the chapter
times line up with the video, then show the opening card:

```json
{ "omitCommand": true, "commands": [
  ["record", "start", "<dir>/raw.webm", "--fps", "24", "--cursor"],
  ["eval", "__ksVideo.start()"]
] }
```

```js
__ksVideo.card("Comments column in Fund DD", "5 checks · PR preview", 6000, "KAR-123 · Browser test");
__ksVideo.hold(6000)
```

Don't pass `--contact-sheet`: when its frame analysis falls behind,
agent-browser drops the whole recording.

Keep one recording under about 10 minutes. For a longer test, record in parts
(`raw-1.webm`, `raw-2.webm`, …): each part starts with the batch above (its
own `__ksVideo.start()`) and ends with step 5's first two steps, saving its
own `chapters-1.json`, `chapters-2.json`, …

### Narrate as you test

Each note shows in the recording as a caption (white text in a black box at
the bottom of the page) for its reading time, and goes into the video's
transcript (a VTT file) with the cards and verdicts. The card already says
what the check is and what to expect; the notes only **describe the steps**:
where you are and what you click or type, then what you observed.

- `__ksVideo.note(text)` adds a caption. Only two kinds of note:
  - **A step**, before the action it describes: the page and what you click
    or type. "Fund DD, City of Miami CDBG: double-click Alarcon's Comment
    cell." "Type 'Hiring delayed to Jan'." "Click outside the grid to save."
  - **Observed**, once at the end of the check, after you've read the value
    and checked it: "Observed: comment saved, spinner shown, editor closed."
- **No explanation:** no test case, expected result, setup, reasoning or
  corrections in notes. Never write an Observed note before you've read the
  value; if you can't confirm something, leave it out and say so in your
  report.
- **Concise:** about 80 characters per note; product language (pages,
  buttons, rows, values), no selectors, refs or code.
- Captions sit at the bottom of the page and move to the top while the
  pointer or the field being typed in is in the bottom 30%. A note written
  while one is still up joins it as a second line. They're part of the
  video, so if a result you verify sits at the bottom with no pointer near
  it, scroll it higher up before the Observed note.

### Each check

1. **Title card**, one `ab_eval`:
   ```js
   __ksVideo.card("Filter by ENA", "Only the 6 ENA rows remain", 6000, "Check 3 of 5");
   __ksVideo.hold(6000)
   ```
   Card arguments: title (what's tested), subtitle (what should happen, with
   numbers when there are any), duration in ms (6000 for every card), step
   label ("Check 3 of 5").
2. **Do the check.** Batch actions whose outcome you can predict (see
   Driving the app). Put a step note right before each action:
   `["eval", "__ksVideo.note(\"Expense Actuals: open the Fund filter, choose ENA.\")"]`.
3. **Verify**, reading the actual values, then one Observed note:
   `__ksVideo.note("Observed: 6 rows, all ENA; total $12,400.")`.
4. **Verdict banner**, one `ab_eval`:
   ```js
   __ksVideo.verdict(true, "6 ENA rows shown, total matches");
   __ksVideo.hold(6000)
   ```
   Use `false` and say what went wrong when it fails. Keep going with the next
   check unless the failure blocks it.

Card and note text is in the video and its transcript: no credentials,
tokens or customer data (use the test data's names and amounts).

## Driving the app

- **What the viewer sees:** while recording, every real click shows a brief
  yellow click mark (Loom style), two for a double-click, and a field filled
  without a click gets one too. Only real pointer actions show up, so drive
  the app with them.
- **Clicks:** `ab_click` (and `["dblclick", "<selector>"]` in a batch) send
  real pointer events. Never
  `element.click()` in eval: apps often ignore it (an AG Grid cell won't open
  its drawer).
- **Replacing text:** `ab_fill`. Select-all then `type` can insert before the
  old text instead of replacing it.
- **Coordinates:** screenshots are in device pixels (2× on a Retina window);
  mouse and scroll coordinates are CSS pixels. Divide by
  `window.devicePixelRatio`.
- **Snapshots:** keep them scoped: `interactive: true`, a `selector`, a
  `depth`, `compact: true`. On grid-heavy pages never take a full-page
  snapshot (an AG Grid page can return 100+ KB); read cell values with an
  `ab_eval` that returns a small JSON of just what you need.
- **Grids:** AG Grid draws only the rows and columns in view. Scroll its
  viewport first (eval on `.ag-body-viewport` `scrollTop` or
  `.ag-body-horizontal-scroll-viewport` `scrollLeft`), then read or click.
- **Long waits** (a background job, a slow refresh): wait for the condition,
  not a fixed time. If eval waits for promises (step 3):
  `__ksVideo.until(() => document.querySelector(".ag-row") !== null, 180000)`,
  with the tool's `timeoutMs` set above that timeout (it defaults to
  120000). Otherwise `ab_wait_for_text` or `ab_wait_for_selector` with
  `waitTimeoutMs`.

## 5. Finish

1. `ab_eval` `__ksVideo.stop(); __ksVideo.chapters()` (turns the pointer
   highlight off) and write the JSON it returns to
   `<dir>/chapters.json` (`chapters-N.json` for part N).
2. `ab_record_stop`.
3. Run:
   ```bash
   node <this skill's folder>/scripts/finish-video.mjs <dir>/raw.webm --chapters <dir>/chapters.json
   ```
   For parts, list them all with one `--chapters` each, in order; they're
   joined into one review video with continuous chapters:
   ```bash
   node <this skill's folder>/scripts/finish-video.mjs <dir>/raw-1.webm <dir>/raw-2.webm --chapters <dir>/chapters-1.json --chapters <dir>/chapters-2.json
   ```
   It writes `<dir>/raw-review.mp4` (`--out` to change it) with its chapters
   (the captions are already in the picture), writes the transcript beside it as
   `<dir>/raw-review.vtt`, and prints the video's length and each chapter's
   start time. `--still-speedup N` changes how much faster still stretches
   play (default 8).
4. Write `<dir>/report.md`: one row per check with its title, PASS/FAIL, what
   you saw, and its start time in the review video.

## 6. Report back

Give the review video's path, the transcript's path and the checks table.
Say which checks failed and what you saw. The user opens the video in
QuickTime, IINA or VLC, where the chapters show in the chapter list. `open` is
blocked in the sandbox, so give the path, don't open it.
