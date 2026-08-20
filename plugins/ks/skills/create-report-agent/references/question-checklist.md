# Question checklist — classified by WHEN to ask

Every question below cost real time or cells when asked late (or not at all) in the reference project. The classes are ordered: A blocks everything; F is per-run.

## A. Scoping intake — ask the user/PM before any building

- What exactly is the deliverable — the workbook only, or the assembled submission package (stitched PDFs, reference annotations)? The supporting-document PDF is usually an **input the agent reads**, not an output.
- Which month is the single complete reference month? Which file is the customer's REAL filed workbook for it — verified by internal header/report number and hash, never by folder name? (A neighbouring month's file looked complete and was a half-built draft; diffing against it produced a bogus "+1,750 error, their file doesn't tie".)
- Is the customer's filed workbook internally consistent and does it tie to the ledger? If not, **which wins?** Get it in writing. (Reference answer: ledger wins — their own Per-GL/Variance columns proved they treat GL as the control; a reimbursement grant over-claim is a compliance risk. This decision caps the achievable score and is the most consequential in the project.)
- Is the file they call "the template" actually blank? (It was their filled workbook renamed, carrying 255 figures.)
- Does the macro-enabled workbook actually contain macros? (No `vbaProject.bin` → `.xlsx` output is safe. `.xlsm` uploads are rejected by chat anyway.)
- Which grant first, and are the others structurally different (quarterly cumulative vs monthly reimbursement = separate agents)?
- Does this fund/funder require source citations, and on which tabs/columns? (Varies per org and grant.)
- Deadline / meeting date driving the first run.

## B. Ground-truth reconstruction — answer from DATA; escalate only what data can't answer

- What is the routing convention from GL account to tab — the customer's convention or the system's budget categories? Any account whose name contradicts its routing? (Keep the customer's convention; note every occurrence.)
- **Which cells are the agent's to write?** Answer by formula-aware diff of blank template vs filed workbook — never by judgement. (The customer wrote 361 cells on exactly 6 of 18 sheets.)
- Per column: template-static, derived in-workbook, sourced from a document, or the customer's private workpaper?
- Stale literals in the template (prior-year grant numbers, "DO NOT USE" notes) — and does the customer also carry them? (They may overwrite the CORRECT template value with a stale one — that's their error, don't reproduce it.)
- Do sheet names carry trailing whitespace? Is one sheet name a prefix of another? (Both true in the reference; the prefix caused a 24-cell mis-write that passed every tie-out.)
- Is the attachment tool's `fileCount` the document count? (No — count pages/documents in the package.)
- Are source documents actually in the accounting system, or in another system (Box, SharePoint) nothing is wired to?
- For every field a rule will use: does the agent's TOOL return it (check the transform, not the DB), and is it populated (a 100%-NULL column supports no rule)?

## C. Must go to the CUSTOMER before the ruleset is final — these change numbers

- Invoice-total column granularity: whole invoice or the grant's slice? One invoice backing several lines — repeat the total or split? (Their DM said one thing; their filing did the opposite. One rule has to win.)
- Where does an unsourceable split figure come from (per-seat/per-project numbers in neither ledger nor invoice)?
- One line for several bills, or split, when an allocation entry rolls up multiple invoices?
- Full bill distributed, or only the released portion, when a holding department releases variable fractions month to month?
- Rounding/residual policy: leave a one-cent shortfall visible, or force an exact tie? Is their cent a policy or a spreadsheet accident?
- Basis for ratio columns: hours or dollars, when only one is derivable from the ledger?
- Where do budgeted percentages come from and who owns updating them? What feeds "balance from previous report"?
- Label semantics: parentheticals, service dates — rebuilt monthly or copied forward?
- Optional columns (e.g. paid dates most vendors lack): attempt at all?
- Always-empty tabs: genuinely out of scope, or just quiet? A "quarterly"-headed tab inside a monthly package: QTD, month-3-only, or separate? **Park with a note naming what would have gone there — never silently skip.**
- Fixed per-vendor reference numbers, or positional numbering (which drifts when the vendor list changes)?
- Columns the funder requires that no held source can supply (hours/rate/overtime when documents aren't attached)?

Rules of engagement: search Slack DMs/tickets FIRST — answers are often already given. An open question to a customer is an implicit commitment; convert unactionable ones to disclosure statements. Record parked questions WITH the cells they cost.

## D. Data/process asks only the customer's org can fix — raise EARLY

- Attach supporting documents in the accounting system (or accept the agent reading the system where they actually live). Reference coverage: 1 usable document per 55 transactions while the team held full support in Box — the mismatch, not missing paperwork, stalled the top ask.
- Referenced attachment id with no pages → re-sync/re-upload their side.
- Fill employee-title fields so positions self-maintain.
- Fix upstream data faults surfaced by probes: a vendor field bulk-attached to 23 unrelated merchants; exclude rules marking tracked accounts untracked.
- Notify on every budget revision; the supported path is uploading the revised workbook.

## E. Per-run — the agent asks, or the operator confirms

- Which reporting month? (asked EVERY run, never assumed, never carried from a prior run)
- Which documents this month; which of last month's were unusable and why (the closing note drives next month's uploads).
- Any budget revision?

## F. Platform/infra owner — before and during runs

- Is the attachment/document service up in THIS environment? (Failed 5 consecutive runs in preview; probe before building anything that depends on it.)
- File-storage quota headroom? (Over-quota → the agent verifies a good file that never reaches storage; `uploadFiles 400`.)
- Session file cap vs the monthly document set size?
- Does the DB branch lag the environment under test? (A dev copy can't see rows written minutes ago — ask for a refresh, never poll.)

## Prerequisites gathered before Phase 1

Files: verified-blank template (versioned; scan inline strings — a restore script's inline-string labels were invisible to three audits); filed prior-month workbook; second reference month if available; approved budget document (+ which year-sheet applies); the month's supporting documents as the customer holds them, including any shared-cost allocation workbook (one such file explained an entire class of mismatches); customer's file-naming scheme (usually encodes the row references); prior agent's stored context (its pinned plan often contains the instruction that caused the complaint).

Access: correct active org (not URL); ledger read access on a current DB branch; attachment service probed; storage quota; browser automation for the paste + a HUMAN to attach files (native picker is un-automatable); stdlib-Python scoring tooling.
