# Ruleset anatomy — what each section and assertion is FOR

The section numbers below follow the reference ruleset (`workflow/jaswanth/tickets/kar-12687/resources/v22-agent-ruleset.md`; the quarterly sibling is `bja-stop/`'s v06). Your grant's ruleset will differ in content but should cover every JOB listed here. The master file keeps maintainer notes + full changelog (including **rejected rules and why**) ABOVE a `▼ PASTE EVERYTHING BELOW ▼` line; the binding prompt below it.

## Sections

| § | Job (org-agnostic) |
|---|---|
| **§1 Identity & period** | Pin the grant's immutable coordinates (fund, donor id, GL project, funder, grant year) and period arithmetic. Force the agent to ASK which month; never carry a prior run's period/roster/figures. |
| **§1a Script is the deliverable** | The saved script — not the prompt — produces the workbook month after month. Every rule written into the code; `# RULESET vNN` stamp; audit + rewrite-don't-patch on stamp mismatch; durable memory demoted to non-source ("this document outranks it absolutely; note what you found and ignored"); `GATHER_MANIFEST` pins the gathered-data contract (files, keys, producing queries; load-time validation exits naming the exact missing key — no `.get()` defaults); replay = EXECUTE, artifacts conform to the script, derivation/allocation/rounding FROZEN. |
| **§2 Template** | Blank template as a saved, literally-named input. A figure already present = wrong file, STOP (never clear). Closed list of writable cells; closed list of read-only template cells; fully-static sheets named. Never reproduce the customer's own errors. Exact-key sheet resolution (no prefix/fuzzy; stop on 0 or >1; print resolved name before writing). Never touch number formats/styles. |
| **§2a Secondary reference doc** | A persistent reference (e.g. approved budget workbook) as the SOLE source of figures existing nowhere else. Precedence: uploaded-this-run > kept table in script (a cache with stated origin) > restorable saved copy > system query. Ban stopping to ask for it. |
| **§2b Source order** | ONE order for the whole workbook (document package → org-wide GL → fund-scoped actuals → blank). Take the first source that structurally CAN carry that cell's figure (a share-level source can never supply a whole-invoice total). Never reconcile/average sources. |
| **§3 Account→tab routing** | The CUSTOMER's routing convention, as a closed account list. Unlisted account → visible gap + note, never judgement. The list may filter nothing today — it's a tripwire, not a filter. No tab excluded. |
| **§4-family Per-tab rules** | Per tab: row selection, identity columns, the ledger figure (reversals included), which columns are the customer's workpaper (untouchable), document-sourced columns and how to read them (header-matched, last revision, signed copy wins), mutually exclusive bases never mixed. |
| **§5-type Apportionment** | Rounding rule (e.g. round-half-up per member then sum), an arithmetic anchor forcing all shares + sum into a note, explicit ban on closing the residual cent, "check the outcome, not your intention". |
| **§6-type Scaffold seating** | The template's budgeted rows ARE the rows to fill; deterministic match order (account → identity → unit-rate divisibility, identity beats divisibility); label preservation; never append a row the scaffold already names. |
| **§7-type Derivation ladders** | Per hard column: an executable ladder (attachment → entry-level GL legs with paging → …) whose terminus is blank-plus-note, NEVER a guess. Treat ledger vendor fields as unverified (read description too; disclose disagreement). Pin ambiguous splits from the filed workbook. |
| **§8-family Backup documentation** | Mandatory package download every run; index structure; id caveats (`fileCount` ≠ documents); cross-check index totals; thin coverage is EXPECTED, never invent. Chat-uploaded documents rank ahead of the system package; filename→row binding; report files used/unusable. |
| **§9-type Cover form** | Identity/header cells written every run; cross-sheet formula totals for EVERY row including always-zero ones (a hardcoded zero can't follow a tab that wakes up); prior-period columns re-derived from the ledger each run, never copied from a prior filing; disagreements reported, not resolved. |
| **§10 Finish + assertions** | Mechanical finish (recalculate → repair cached label strings across ALL generations → page setup/print areas → save → read-only tie-out → format-fidelity check), then the hard assertions. |
| **§11 Never invent** | Enumerated blank-plus-note list; ban on back-solving from a total; carve-out: a ratio of two independently-sourced columns is not invention. |
| **§12 Provenance column** | If the customer wants citations: one canonical format; build-the-index-map as an explicit step; decompose a cell into ledger legs BEFORE lookup (an index prints one line per ledger row, never your total); "not located" is a verdict about a leg; Source column letter pinned PER TAB (never "first free column" — unevaluable); per-tab closed list of which cells get notes (mechanical test: literal → note, formula → none); excluded from print areas. |

## Hard assertions — the pattern

Assertions run against the **finished, saved, recalculated file** and report PASS/FAIL with actual values. They are the final authority over the script audit and the agent's own narration. Design rules, each learned from a failure:

1. **Recompute, never restate.** An assertion that repeats the build's own output blessed a forbidden exact tie as "zero shortfall". Recompute each figure off the saved file, compare cell-by-cell, name the basis.
2. **Quote, don't summarize.** "Scaffold-in-place ✓" passed while 24 cells sat on the wrong sheet. Require per-row quoting; summary claims explicitly do not satisfy.
3. **Make "I didn't check" detectable.** A required query must be REPORTED even when empty ("no other entries" is valid but must be stated). A blank whose note names only rung 1 proves the ladder stopped early — FAIL.
4. **Count the right unit.** Count ledger legs, not cells (a tab whose leg count equals its cell count on an instalment tab is itself a FAIL); count coverage per cell, not citation strings.
5. **Stamp check** (`RULESET vNN` in the script's first line) is the only detector of "this workbook came from rules that are not these". The stamp appears in ~4 prompt locations; grep-count on every version bump.
6. **Walk every new assertion past the rules it interacts with.** An assertion fitted to one failure (vendor-must-match-row) directly contradicted the seating rule and zeroed legitimate rows. Nothing compares them unless you do.
7. **Assert absence too**: identity cells NOT on the decoy sheet; no Source column on tabs without figures; customer workpaper columns untouched; date cells still numeric serials after label repair.

## Authoring style that survived 20 versions

- Concise imperatives + FAIL conditions; cut narrative/rationale and examples (the shortest version carried the most rules).
- Name cells individually. Category phrases ("the AMOUNT cells", "cells the template ships empty") failed four times; closed lists derived by diffing never failed.
- One month's figures belong in maintainer notes ("worked examples — evidence only, deliberately NOT in the prompt"), never in the binding text.
- Fix defects at the cheapest layer: template surgery beats a prompt rule; a fixed tool beats a rule that works around it; a pinned answer beats a clarifying question with a guessable default.
- The plan-step placement of a duty is not load-bearing — the assertion is. Agents legitimately fold work into existing steps.
- Prefer formulas over literals for anything that is arithmetic on other cells; then "literal → note, formula → none" makes the citation rule mechanical.
