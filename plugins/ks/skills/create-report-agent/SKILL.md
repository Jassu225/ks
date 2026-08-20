---
name: create-report-agent
description: Build and iterate a KarmaSuite report agent that reproduces a customer's grant report (funder workbook, billing package, cost statement) for one fund/grant. Covers intake questions, ground-truth reconstruction, ruleset authoring, the run→score→fix loop, replay validation, and prod cutover. Use when asked to create a report agent for a grant, replicate a funder report, automate a monthly/quarterly billing package, or improve an existing report agent's output.
---

# Create a Report Agent for a Grant

A report agent is **configuration, not code**: a `report_agent` row (`kind = FUND_REPORT`, scoped to a fund) whose entire behavior lives in the `agentContext` JSON — `systemPrompt` (the ruleset), `pipelinePlan`, `generationCode` (the saved build script), `inputFiles`, `goldenOutputKey`. You create one by pasting a hand-authored ruleset into a fund's Smart Reports chat, attaching input files, and clicking **"Download & save as agent"** on a clean run. No repo changes.

Everything org- and grant-specific — the template, where figures come from, whether source citations are required, rounding policy, which tabs are live — **varies per customer**. This skill's job is to make you ask the right questions at the right time and follow the proven loop, not to hand you TRC's answers. The reference project (KAR-12687) lives in the KarmaSuite repo at `workflow/jaswanth/tickets/kar-12687/resources/` and carries TWO finished agents — read either as a canonical example: **TRC/NCST** monthly reimbursement package (`v22-agent-ruleset.md`, 22 versions) and **BJA STOP** quarterly cumulative FFR (`bja-stop/`, v06, 6 versions). The second agent took 6 versions instead of 22 because the laws below were already known — that gap is this skill's whole point.

**Reference files in this skill — read them at the phase that needs them:**
- `references/question-checklist.md` — every question, classified by WHEN to ask it. Load in Phase 0 and keep open.
- `references/ruleset-anatomy.md` — what each ruleset section and hard assertion is FOR. Load before Phase 3.
- `references/iteration-protocol.md` — versioning, paste/SHA protocol, scoring instruments, replay validation. Load before Phase 4.
- `references/failure-catalog.md` — every known failure mode + countermeasure. Load before Phase 3 and re-scan when a run misbehaves.

## The five laws (learned at ~$3 + 20 min per violation)

1. **The saved script is the deliverable, not the prompt.** `generationCode` is re-mounted every turn and silently overrides new prompt rules. Every rule must be written INTO the script; the script carries a `# RULESET vNN` stamp checked by an assertion; replay means EXECUTE — artifacts conform to the script, never the reverse. Pin the gathered-data schema (a `GATHER_MANIFEST` naming every file, key, and producing query, validated at load). Unpinned schema is what forces a replay to "adapt" the script and drift.
2. **What isn't asserted isn't checked.** Rules phrased as preferences or "tells" get read and skipped (proved repeatedly: two citation-preference rewrites → no change; explicit step + assertion → 2→39 citations). Every behavioral rule = explicit action + hard assertion that RECOMPUTES off the saved file and quotes actual values. Self-reports restate; they pass while the file is broken.
3. **Never fit a rule to one observation.** The single biggest source of regressions: a rule derived from one cell/one month, shipped without walking it past every row it touches and several months of data. Record rejected rules in the changelog WITH the evidence, so they aren't reinvented. Name cells individually — category-phrased rules ("the AMOUNT cells", "empty is never static") failed four times running; closed cell lists never did.
4. **The ledger wins.** Tabs tie to the general ledger. The customer's filed workbook is ground truth for *conventions and cell ownership*, NOT for figures — reproducing their errors is a failure. This caps the achievable agreement score below 100%; state the ceiling and its composition up front. Blank-plus-note beats a guessed value; value-plus-note beats blank ("blank when uncertain" rules destroy correct answers when they finally fire).
5. **Verify, don't recall — and verify against what the AGENT can reach.** Check every rule against the exact tool-transform output the agent sees (not your SQL access), check fields are actually populated (a 100%-NULL column supports no rule), read run transcripts from the database (never diagnose from a screenshot), hash-verify every file identity before analyzing it, and match a downloaded artifact's byte size to the size the agent itself quoted before scoring it.

## Phase 0 — Intake (always first; blocks everything)

Read `references/question-checklist.md` §A and ask the user/PM:

- What is the deliverable exactly — the workbook only, or the assembled submission package? (Supporting-document PDFs are usually an INPUT the agent reads, not an output.)
- Which single month is the complete reference month, and which file is the customer's REAL filed workbook for it? Verify by internal header/hash, never by folder or filename convention — half-built drafts look complete.
- Ledger-vs-filed authority: if the customer's filed numbers disagree with the GL, which wins? Get it in writing. (Usually the ledger — their own reconciliation columns typically prove they treat GL as the control.)
- Report cadence and structure: monthly reimbursement vs quarterly cumulative are **different agents**, not parameters.
- Does the fund require source citations / a provenance column? Which tabs? (Varies per org and per grant — never assume.)
- Deadline driving the first run.

Collect the input files (checklist §"Prerequisites"): blank template (verify GENUINELY blank — "template" files are usually filled workbooks renamed; scan inline strings too), filed prior-month workbook, a second month if it exists, approved budget doc, the month's supporting documents, the customer's file-naming scheme, any prior agent's stored context.

## Phase 1 — Probes (before writing any rule)

1. **Attachment-coverage probe**: a throwaway run scoped to fund+month asking availability only ("do not build any workbook"). Record transactions vs documents actually present (`fileCount` is NOT the document count — count pages), and what fraction of the month's dollars have no document. This resets the acceptance test and the customer's expectations.
2. **Tool-output probe**: for every field a rule will reference, confirm the tool's transform actually returns it, and that the data is populated. If a needed figure is reachable by no tool (e.g. org-wide GL legs for whole-invoice totals when all tools are fund-scoped), building the tool is in scope — but check for an existing data path first.
3. **Cell-ownership derivation**: formula-aware diff of the blank template against the filed workbook → two closed lists: cells the agent WRITES, cells it READS-never-overwrites. Everything else stays exactly as shipped. Identify the customer's private workpaper columns (paid dates, Per-GL/Variance, free-text notes) — the agent must never touch them.
4. **Blind replication**: rebuild the reference month from the database alone, WITHOUT opening the customer original. Every derivable figure becomes a derivation rule; every non-derivable figure becomes an explicit gap → a customer question or a documented blank. Convergence = every residual diff *explained*, not 100% match.
5. **Environment**: attachment service working? storage quota headroom? session file cap vs the monthly document set? DB branch current? Org context = active-org selection, not the URL.

## Phase 2 — Customer questions

From the probes, assemble the question list (`references/question-checklist.md` §C–D). Rules of engagement:

- Search existing customer comms (Slack DMs, tickets) first — answers are often already there.
- An open question posed to a customer is an implicit commitment to do the work. Convert unactionable ones into **disclosure statements** instead.
- Questions that change numbers (invoice-total granularity, rounding/residual policy, ratio basis, multi-bill splits, parked tabs' period convention) must be answered or explicitly parked WITH the cells they cost recorded.
- Data asks only their org can fix (attach documents in the accounting system, fill title fields, fix vendor assignments) — raise early; they gate the top asks.

## Phase 3 — Author the ruleset

Read `references/ruleset-anatomy.md` and model on `v22-agent-ruleset.md` (monthly) or `bja-stop/`'s v06 (quarterly). Non-negotiables:

- **Three files per version** (`vNN-agent-ruleset.md` master with changelog above a paste line / `vNN-systemprompt.txt` / first-message file). Copy, never edit in place. Bump every `RULESET vNN` stamp (grep-count them). Prove regeneration by SHA round-trip.
- One source order for the whole workbook; take the first source that structurally CAN carry that cell's figure; never reconcile/average sources. Derivation order ≠ citation order — cite the artifact the funder holds.
- Every figure names a **source class**, never a value. One month's figures live in maintainer notes as "worked examples — deliberately NOT in the prompt". No prose fallback ending in "otherwise use X" where X is a plausible answer — the terminus is blank-plus-note.
- Fix defects at the cheapest layer: template surgery > prompt rules. The agent should never need to clear anything.
- Ambiguity produces coin flips, not consistent behavior: pin unpinned decisions (orderings, label forms, Source-column letters per tab) from the filed workbook; scope every "keep untouched".
- Keep the agent's duties minimal — harness verification (tie-outs, diffing) is YOUR job, not a rule. Any rule depending on a test-harness-only input is dead weight.

## Phase 4 — The run loop

Read `references/iteration-protocol.md` for the full mechanics. Shape:

paste (SHA-verified, by bytes never chars) → human attaches files → run on a FRESH thread → wipe non-progress AI memory before generation runs only, with permission, never in prod without asking → download → **byte-size check vs the agent's quoted size** → `verify.py`-style independent checker FIRST → row-aligned diff + frozen-exclusion scorer → read the transcript from the DB → attribute every changed cell to a named cause → changelog entry → next version by copy.

- Judge a change by the specific cells it targeted, never the headline score — single-run noise band is ±1–3pp, larger than most rule effects. Never claim credit for a coin flip.
- The scorer's exclusion ordering is a correctness property: defect checks (misplaced provenance column) run BEFORE workpaper exclusions, or the scorer launders damage.
- Permission gates: memory deletes, prod writes, re-runs, commits — all explicit. Iterate in a preview env; cut over to prod only with a finalized version.

## Phase 5 — Save, replay-validate, hand over

1. Clean generation run → **"Download & save as agent"** (only this persists `generationCode`; "Just download" wastes the script). The save flow REGENERATES `systemPrompt` into a short paraphrase dropping every rule — re-paste the real prompt via Agent Details and re-verify by SHA/length, then close/reopen to confirm persistence. Every save creates a **NEW agent card under the same display name** — plan the version-suffix rename and the archive of the superseded card in the same breath as the save, or the gallery accumulates identical-looking duplicates.
2. **Replay validation is a separate failure surface**: new thread, monthly documents only, steady-state memory (do NOT wipe before a replay test). Compare against the generation run. Any drift in frozen derivation/allocation/rounding = adaptation drift → tighten the manifest/assertions, not the figures.
3. Hand over: the per-run operator asks the reporting month every run, uploads the month's documents, confirms any budget revision, and reads the closing note (files used / unusable and why) to decide next month's uploads.
