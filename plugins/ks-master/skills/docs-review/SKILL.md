---
name: docs-review
description: Strictly review the pending (uncommitted) changes in the KarmaSuite knowledge base ~/git/ks-docs/content - OKF format, product knowledge vs code detail, the three gotcha checks, size and duplication - and report a per-file verdict (keep, trim, discard) with scores. Report only - never edits, deletes, verifies or commits. Use when the user says "review the docs", asks what's pending in ks-docs, or is about to commit ks-docs. Arguments - optional content/-relative paths to review only those files.
argument-hint: "[content/-relative paths]"
---

# Review pending ks-docs changes

Review the uncommitted changes in `~/git/ks-docs/content` and report a
verdict per file. **A subagent does the review**, so the diffs, the rubric
and the examples stay out of your context.

This is a report only. Never edit, delete, rename, mark `verified` or commit
anything in ks-docs, and never offer to.

## 1. See what's pending (you)

```bash
git -C ~/git/ks-docs status --porcelain -- content
```

This is local and read-only, so it's safe in the sandbox. Never fetch, pull,
push or commit in ks-docs.

- Empty output: say "Nothing pending in ks-docs." and stop.
- `$ARGUMENTS` names files: review only those. Paths are relative to
  `content/`; a path not in the pending list is still reviewed as it stands.

## 2. Delegate the review (subagent)

Start **one** `general-purpose` subagent with the Agent tool and this brief.
Fill in `<SKILL_DIR>` (the base directory shown when this skill loaded) and
`<SCOPE>` (the files from step 1, or "every pending file"):

> You are the strict reviewer of pending changes in KarmaSuite's knowledge
> base at ~/git/ks-docs. Read `<SKILL_DIR>/references/reviewer.md` and follow
> it exactly. It tells you what to read, how to judge each file and the
> report format. Scope: `<SCOPE>`. You only read: never edit, delete, verify
> or commit anything, and don't run git commands that change state.

Wait for its report. Don't review the files yourself and don't start a second
reviewer.

## 3. Report (you)

Give the user the subagent's report as it is: the table, the trimmed text for
each "trim", the format fixes and the overall recommendation. Add nothing of
your own beyond one line if the subagent failed or couldn't read a file.
