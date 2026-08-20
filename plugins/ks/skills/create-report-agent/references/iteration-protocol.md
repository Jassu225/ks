# Iteration protocol — versioning, paste, scoring, replay

## Versioning (copy, never edit in place)

Three files per version:

| File | What | Produced by |
|---|---|---|
| `vNN-agent-ruleset.md` | THE MASTER — maintainer notes + changelog above a `▼ PASTE BELOW ▼` line; binding prompt below | hand-edited (the only file anyone edits) |
| `vNN-systemprompt.txt` | the systemPrompt | everything below the paste line, verbatim |
| `new-agent-first-message-vNN.txt` | composer paste | fixed run preamble + systemprompt verbatim |

Making vN+1: `cp` the master (in-place editing destroyed three versions' notes, reconstructed only because prompts survived) → add changelog entry on TOP → bump EVERY `RULESET vNN` stamp (grep-count; a missed stamp makes the agent self-validate against the wrong ruleset) → regenerate both artifacts → **prove the round-trip by SHA-256**. Gotcha: the paste header is followed by a blank line; concatenating without it slices one line late and drops the title — a 52-char shortfall invisible without the hash. When compressing/editing a ruleset, prove the edit lossless by extracting load-bearing tokens (cell refs, accounts, filenames, amounts, FAIL counts) before/after.

Changelog records **rejected rules with the evidence that killed them** — the defense against a future session "helpfully" reinventing them.

## Paste protocol

- `pbcopy < first-message.txt` needs sandbox disabled (sandboxed pbcopy yields an empty clipboard silently). Verify `pbpaste | shasum -a 256` matches.
- Click the composer BY COORDINATE (ref-clicks leave focus on BODY; the paste silently no-ops). `cmd+v` has failed (once inserting 68 box-drawing chars); the robust path is in-page `navigator.clipboard.readText()` + React native value setter, guarded on expected length AND a marker string.
- **Verify by SHA-256 or bytes, never characters** — multi-byte UTF-8 makes bytes ≠ chars legitimately (a 295 "shortfall" that reads exactly like truncation is usually just this). In-page: `new TextEncoder().encode(el.value).length`, and hash via `crypto.subtle.digest`.
- Screenshot the composer for user sign-off before send.
- **A human attaches the files** — the paperclip opens a native picker automation cannot drive. Verify the attached file's NAME (the UI truncates; two templates can share a byte size).
- **Never close the tab** (kills the run and discards paste + uploads — twice). Switching tabs is safe.
- Fresh thread per generation run; a thread with a terminal run RE-PLANS instead of replaying.
- Memory hygiene: wipe non-progress AI memory before GENERATION runs only (durable memory rebuilds stale rules and deleted figures — it did so twice in one run); NEVER before a replay test (replay must see steady-state memory); NEVER in prod without asking. Stop any in-flight run first — memory is org-scoped and a running job rewrites it mid-wipe.
- Parallel A/B runs: memory is (org, user, kind)-scoped, so two simultaneous runs read each other's — requires continuous deletion or serialization.

## Watching a run

- `report_generation` rows exist ONLY after "Download & save as agent" — never a completion signal. Judge from step ticks / message growth.
- Streaming appends grow one row in place — count-based watchers go blind; `*complete*` matches "Step 1 complete".
- Catch clarifying questions by query signature/length, not by polling for completion.
- In-run clarifying questions: pre-highlighted defaults can be backwards, and pinning the answer in the ruleset (removing the question) is usually the right fix.

## Scoring

Instruments (stdlib-only Python; reference implementations in `workflow/jaswanth/tickets/kar-12687/resources/tooling/`):

1. **Independent verifier first** (`verify.py` pattern): seconds against the downloaded file; checks identity cells on exactly-named sheets, tie-outs, provenance-column placement, citation coverage per cell, scaffold seating, recomputed rounding, cell ownership vs blank template. It catches what the agent's own assertions cannot — those compare its figures only to each other. Verifier design traps (each was a real bug): a check that only WARNS lets defects pass for versions; a bare `return` on a missing cell disables a whole check; the xlsx reader returns strings so `isinstance(v, float)` makes a check vacuous; body-row scans must exclude total rows; package availability is run-level so citation counting spans the whole workbook.
2. **Cell diff + scorer** (`cellDiff.py` → `score2.py` pattern): denominator written INTO the diff JSON (it shifts run to run; a hardcoded constant silently makes runs incomparable). Frozen exclusion set (customer workpaper columns, free-text notes, recalc artifacts, blank≡0.00 both ways). **Exclusion ordering is a correctness property**: defect checks (misplaced provenance column) run BEFORE workpaper exclusions, else the scorer REWARDS overwriting the customer's columns (a real run reported 95.66%, true figure 93.35%).
3. **Row-aligned diff** (`rowAlignDiff.py` pattern) when the customer said row order doesn't matter: match body rows by identity before comparing, feed the SAME scorer so exclusions stay identical. "Rows realigned: none" is itself diagnostic (proves duplication, not displacement).

Reading scores:

- **Byte-size check before any scoring**: match the downloaded file's size to the size the agent itself quoted. A mismatch = the UI served a stale/partial save (burned a run: 93.94% reported vs true ~95.93%).
- Single-run noise band is ±1–3pp — larger than most rule effects. Judge a change by the SPECIFIC cells it targeted. Two versions differing by one provably-neutral rule differed by 2.8pp of unrelated noise.
- Never claim credit for a coin flip that landed your way (unpinned orderings flip per run).
- **Name the denominator convention beside every score.** Agent-touched-cells and union-of-populated-cells produce very different numbers for the same artifact; a score quoted without its convention is not comparable to anything, including your own earlier runs.
- 100% is not the goal: the ledger-vs-filed gap is a permanent, correct residual. State the ceiling (~95.7–96% in the reference) and its composition.
- Deliberate non-matches are successes — matching the customer's error cells is FAILURE.
- Diagnose from the run transcript read from the DATABASE, never from on-screen summaries (three wrong root-causes came from screenshots).

## Save + prod cutover

- **"Download & save as agent"**, never "Just download", on the run you want to keep — only the former persists `generationCode`. (Ten runs' scripts were lost to "Just download".)
- The save flow runs an LLM extractor that REGENERATES `systemPrompt` into a ~5.6k paraphrase dropping every specific rule → re-paste the hand-authored prompt via Agent Details, re-verify by SHA/length.
- Prod mutations go through the app's own save path, never hand-inserted SQL (the app maintains invariants a raw INSERT misses). SQL is a repair tool for verified drift only, with permission.
- Iterate in preview (own Neon branch, prod-copy data); cut to prod with a finalized version. But know preview's weak spots (attachment service, storage quota) — some acceptance criteria are only measurable in prod.
- Deploy-before-run: a rule referencing a new tool field can't run until the code is deployed in THAT environment.

## Replay validation (separate failure surface — always do it)

After saving: NEW thread, monthly documents only, steady-state memory. Compare against the generation run. The reference replay lost 2.5pp entirely to **script-adaptation drift**: its own gathering produced differently-keyed JSON, the agent "adapted" the saved script, per-member arithmetic drifted a cent each into a forbidden exact tie — and its restating assertion blessed it. Countermeasures now standard: GATHER_MANIFEST pins the artifact schema; replay = execute (validation failure ⇒ fix the artifacts, never the script); frozen derivation/allocation/rounding; assertions recompute off the saved file.

## Cost calibration

Generation run ≈ $3 / 15–20 min; replay ≈ $1.80 / 11 min. A restarted run can 4× that. Every run needs the human for attachments — batch questions so runs aren't wasted.
