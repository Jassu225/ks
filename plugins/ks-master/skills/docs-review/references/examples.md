# ks-docs review examples

Keep/trim/reject pairs that calibrate the reviewer. Pair 1 is a real case
(KAR-13414, discarded by the user). The others are **illustrative**: their
shape is the point, and the KarmaSuite facts in them are made up. Never cite
them as facts or compare a pending file's facts against them.

---

## 1. A bug fix written as a gotcha (real case, KAR-13414)

**REJECT** (`content/gotchas/funds-available-time-elapsed-percentage.md`, as written):

> `calculateBudgetMetrics` returns a floored value named
> `timeElapsedPercentage`; the derived FICA/MICA rows copied it, so the dotted
> line was jagged. The `TimeIndicator` clamps to 6px. Category Total used ms
> instead of days. Sources pinned to commit 4fba737e9.

Scores: product 2, reuse 1, recur 1, concise 1 → **discard**.
Why: it is the details of one bug fix: function names, a CSS value, a commit
pin. It fails reusable (one derivation in one page) and recurring (the fix is
done). The product fact underneath is worth one line, below.

**KEEP** (the product knowledge in it, as a line in the Funds Available or
milestone concept):

> Time elapsed belongs to the milestone, not the row: every Funds Available
> row in a milestone shares one time-elapsed %, counted in days. Burn Rate's
> dotted line and Underspent compare spending against it.

Scores: product 5, reuse 4, recur 4, concise 5 → **keep** (or **trim** to
this line when it arrives as a separate file).

---

## 2. A feature or page concept (illustrative)

**REJECT / TRIM**:

> `FundsAvailablePage` (`apps/web/src/pages/funds-available.tsx`) calls
> `useFundsQuery` with `staleTime: 30_000` and maps `budgetCategories` to
> `<FundsRow>`. Rows are sorted with `localeCompare`. The page was added in
> PR #812.

Scores: product 1, reuse 2, recur 2, concise 2 → **trim** if the page has
no concept yet, else **discard**.

**KEEP**:

> **Funds Available** shows a grant manager, for each milestone of a grant,
> how much of each budget category is still unspent, so they can see where
> they will run short before the milestone ends. One row per budget category;
> the totals row sums the categories.

Scores: product 5, reuse 4, recur 4, concise 5 → **keep**.

---

## 3. A decision (illustrative)

**REJECT**:

> Decision: moved the allocation query from Prisma to raw SQL in PR #1290
> because it was slow (2.3 s → 180 ms).

Scores: product 1, reuse 1, recur 1, concise 3 → **discard**. An
implementation choice with a one-time reason; it belongs in the PR.

**KEEP**:

> Decision: a refund reduces the spending of the period it refunds, not the
> period it arrives in. Why: grant reports must match what was spent in each
> period, and funders audit by period.

Scores: product 5, reuse 5, recur 4, concise 5 → **keep**. A product-behavior
rule with its reason; every feature that touches spending needs it.

---

## 4. A cross-cutting gotcha that passes (illustrative)

**KEEP**:

> Synced actuals lag the accounting system: data from QuickBooks, NetSuite
> and Sage Intacct is only as fresh as the last sync. Any feature that
> compares synced actuals with budgets must show the as-of time and must not
> imply real-time numbers.

Checks: reusable yes (every feature using synced actuals), recurring yes
(each new report or chart), not local yes (nothing in a feature's own code
says the data is stale). Scores 5/5/5/5 → **keep**.

---

## 5. A local gotcha that fails (illustrative)

**REJECT**:

> Gotcha: `formatCurrency` returns `"-"` for `null`, so check for `null`
> before calling it.

Checks: reusable no (one helper), recurring maybe, not local **no** (the
helper's code shows it in two lines) → **discard**. It belongs in a code
comment.

---

## 6. A new file that should be one line (illustrative)

**TRIM**: a new `content/domain/underspent.md` whose whole content is "A
budget category is underspent when its spending is below the time-elapsed
share of its budget."

→ **trim**: "Add to `/domain/funds-available.md`: *Underspent: spending
below the time-elapsed share of the budget.*" A one-sentence concept is a
line in the concept it belongs to, unless other concepts link to it on its
own.
