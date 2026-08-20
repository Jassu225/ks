# Failure catalog — every known failure mode and its countermeasure

Scan this before authoring rules, and again whenever a run misbehaves. Grouped by layer.

## Ruleset-authoring failures

| Failure | Countermeasure |
|---|---|
| Rule fitted to one observation / one month / one cell (branch that would file $0.00 in months with different pool releases; truncation rule that fixed one cell, broke two) | Check against every row it governs + several months before shipping; verify the ROW MAPPING before deriving from a single cell; record rejected rules in the changelog with evidence |
| Rule phrased as preference / "tell" | Explicit step + hard assertion. Preference-shaped citation rules were skipped twice with zero effect; step+assertion took citations 2→39 |
| Rule against data the agent can't reach (transform drops the field; 100%-NULL hierarchy column; "first free column" unevaluable from inputs) | Verify against the exact TOOL output and live data before writing; build the missing tool if the rule is right |
| Category-phrased rule ("the AMOUNT cells", "empty is never static", "the Voucher dates") | Name cells individually; derive ownership by formula-aware diff of blank template vs filed workbook (failed 4×; closed lists never failed) |
| Prose fallback "otherwise use X" where X is plausible | Terminus is blank-plus-note; a guess must never be a rung |
| "Leave blank when uncertain" rules | Value + reason, never blank — an unfired blanking rule hides its blast radius; when it finally fires it destroys correct answers |
| New assertion contradicting an existing rule (vendor-match vs seating; identity cells vs sheets the customer ships blank) | Walk every new assertion past the rules it interacts with |
| One month's figures hardcoded in the prompt | Maintainer-notes "worked examples — deliberately NOT in the prompt" |
| Ruleset/prompt drift between the master doc and the deployed agent | Single master file with paste-line; boolean probes against BOTH copies; SHA the deployed prompt |
| Version stamp bumped in some locations only | grep-count the stamp; assertion validates it |
| Test-harness-only inputs referenced by production rules ("compare against her workbook") | Any rule depending on an input absent in production is dead weight and risks stale-file poisoning |
| Reconciliation/tripwire duties assigned to the agent | Harness verifies; the agent builds. Keep agent duties to a bare precedence ladder |
| Derivation order conflated with citation order | Derivation wants the source that can carry the figure; citation wants the artifact the funder holds |

## Agent-runtime failures

| Failure | Countermeasure |
|---|---|
| Saved `generationCode` silently overriding new prompt rules (re-mounted every turn) | Rules INTO the script; stamp + audit; rewrite-from-document on mismatch, never patch |
| Durable AI memory resurrecting deleted figures and inverted rules (rebuilt twice in one run) | Memory demoted to non-source in §1a; pre-generation wipe (with permission; never prod unasked; stop in-flight runs first — memory is org-scoped) |
| A SIBLING agent's memory seeding a systematic rule override (a same-org invoice agent's fund-record sourcing beat the pinned routing table for a whole run; §1a's generic memory demotion did not hold) | Renounce the specific wrong source BY NAME in the ruleset ("the fund's account-mapping table is NOT a routing source"), not just "memory is not a source" |
| Replay adaptation drift (differently-keyed gather artifacts → script "adapted" → cent-level arithmetic drift → forbidden tie blessed by a restating assertion) | GATHER_MANIFEST with load-time validation; replay = EXECUTE; frozen derivation/allocation/rounding; recomputing assertions |
| Assertions restating instead of recomputing ("B23 = 750,000 ✓" with no sheet holding it; "scaffold-in-place" with 24 broken cells) | Recompute off the saved file; quote per row; the run transcript is CLAIMS, the artifact is evidence |
| Sheet resolved by prefix (identity block written to the instructions sheet twice, all tie-outs passing) | Exact-key resolution; stop on 0/>1; print resolved sheet per write; assert the decoy sheet is empty |
| Agent rewrote its own plumbing (exact matcher → fuzzy score, 61 cells) | Assertion requiring before/after report if matching logic changes |
| Scaffold rows duplicated from ambiguous "keep untouched" | "The scaffold rows ARE the rows you fill"; quote every scaffold row + figure |
| Wrote into customer workpaper columns / onto sheets they ship blank | Closed write-list; per-tab pinned provenance column; scorer COUNTS (not excludes) misplaced provenance |
| Citation lookup at wrong granularity (searched the index for the cell's own total → false "not itemised" ×7) | Decompose into ledger legs before lookup; assert legs ≠ cells on instalment tabs |
| Ladder stopped at rung 1 (every blank cited "no document"; ledger rung never ran) | "No attachment is the REASON to run rung 2"; blank notes must name both attempts |
| Multi-bill spread undetectable from one entry | Mandatory other-entries query, reported even when empty |
| Agent stopped to ask for a file it already held (glob filename defeated the substring classifier → file never re-fed) | Literal filenames in scripts; precedence ladder ends in restore-file; "asking the user is not one of the options" |
| Clarifying question with backwards pre-highlighted default | Pin the answer in the ruleset; remove the question |
| Coin-flip decisions (pair orderings, label forms) polluting every score comparison | Pin from the filed workbook |
| Cached label strings stale after recalculation; styles stamped by the writing library | Repair ALL generations of references; carry existing style ids; format-fidelity report |
| Step titled "verify"/"reconcile" forced read-only + step-capped by the platform | Only the genuine final check uses those words |

## Infrastructure / operational failures

| Failure | Countermeasure |
|---|---|
| Session file cap ("Cannot add more than 16 files") | Classifier + dedupe-aware supersede landed in platform code; still watch the planner path on replays |
| Attachment/document service down (5 runs, 3 different error strings) | Probe the environment BEFORE building; some acceptance criteria are prod-only |
| Storage quota exceeded → output saves 400 while the agent verifies a good file | Check quota before run campaigns |
| Mid-flight run restart → partial save served as the artifact | **Byte-size check vs the agent's own quoted size before scoring — always** |
| "Save as agent" regenerating the prompt into a paraphrase | Re-paste + SHA-verify after every save |
| Save built from the newest artifact, not the chosen one | Watch for the "not the most recent file" dialog |
| Every save creating a NEW agent card under the same display name → indistinguishable gallery duplicates | Rename the new card with a `- vNN` suffix and archive the superseded one in the same breath as the save (prod mutation — ask first) |
| Code-sandbox outage mid-run | Survivable, not fatal: the agent checkpoints, refuses to fabricate, re-queries. Budget wall-clock for it — a clean run thread ran 81–114 min |
| `report_generation` rows absent unless saved | Not a completion signal; watch step ticks/message growth |
| Clipboard: sandboxed pbcopy silently empty; clipboard mutated between check and paste; focus on BODY | Unsandboxed pbcopy + pbpaste hash; coordinate clicks; in-page setter with length+marker guard |
| Char-vs-byte count "truncation" false alarm | SHA or bytes, never chars |
| Closed tab discarding paste + uploads | Never close; switching is safe |
| `.xlsm` rejected by chat upload | Convert (drop VBA part, fix content type + relationship); expect revisions to arrive as `.xlsm` again |
| Pinned plan carrying month-specific vendor data (93k chars) | Never carry a pinned plan to a fresh agent |
| Dev/preview DB branch lagging | Ask for refresh; never poll for state you just triggered |
| Prod data regressions (fund deleted/re-created un-coding expenses; vendor field bulk-attached to 23 merchants; exclude rules mis-marking accounts) | Verify the fund's data is intact BEFORE a run (does a fund-scoped April query return the expected rows?); read both vendor+description fields; never auto-correct silently |
| Wrong org context via URL navigation | Org = Clerk active-org; switch via the app's switcher |

## Template-construction failures (self-inflicted)

| Failure | Countermeasure |
|---|---|
| "Template" was the customer's filled workbook renamed (255 figures) | Verify blankness cell-by-cell; version the blank template; delete superseded copies |
| Blanking script cleared every cell with a `<v>` — shared strings store text that way → 38 labels erased | Clear only numbers/dates, never text |
| Restore script wrote labels as inline strings — invisible to color/position/figure audits | Template audits must scan inline strings (the customer's file has zero; any inline string is your fingerprint) |
| Clearing a header doesn't retire a column (formulas beneath propagate) | Remove the formulas, not just the header |
| Lazy `<xf…>` regex truncating at nested `<alignment/>` → workbook Excel can't open | Greedy element extraction + integrity check: zip test, all XML parses, zero value/formula diffs |

## Scoring-instrument failures

| Failure | Countermeasure |
|---|---|
| Exclusion ordering laundering a defect (run rewarded for overwriting workpaper) | Defect checks BEFORE exclusions |
| Address-based diff punishing correct rows in different positions | Identity-keyed row alignment feeding the SAME scorer |
| Hardcoded denominator making runs incomparable | Denominator written into the diff JSON |
| Warn-only checks passing real defects for versions | Real FAILs with exit status |
| String-typed cell values making `isinstance(float)` checks vacuous | Know your reader's types |
| Counting citation strings instead of per-cell coverage → fictitious 3-version regression | Count what the rule governs |
| Diagnosing from screenshots/summaries | Read the transcript from the database |
| Trusting inherited findings from handoffs without re-verifying | Re-verify before building rules on them |
| **Shared-formula misread**: `<f t="shared" si=…/>` with EMPTY text IS a formula; a text-based classifier calls it a literal (a phantom "38 literal→formula" regression chased across 3 runs and 4 fix attempts by two agents) | Compare `<f>` NODE presence/counts, never `f.text` |
| Two campaigns quoting the same-looking score off different denominators (agent-touched-cells vs union) | Name the denominator convention beside every score; never compare across conventions |
