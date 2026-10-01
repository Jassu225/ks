---
date: 2026-10-01T15:43:32+05:30
git_commit: c0209c4
branch: main
task: gh-cli stacked PRs; Linear CLI cycles, manual order, relations, description files
---

# Handoff: gh stack Reference + Linear CLI Cycles, Manual Order and Relations

> See docs/product-overview.md for product context, docs/tech-stack.md for dependencies, and CLAUDE.md for dev guidance.

## What Happened

Four requests, all landing in `plugins/ks`.

1. **gh-cli stacked PRs.** The user linked
   <https://docs.github.com/en/pull-requests/how-tos/stacked-pull-requests>.
   That page is only an index. The 12 subpages were read as markdown through
   `https://docs.github.com/api/article/body?pathname=/en/pull-requests/...`.
   `commands/gh-cli.md` gained a "Stacked Pull Requests" section:
   - The model (rules and CI are evaluated against the stack's trunk; merges go
     bottom-up and all-or-nothing; history must be linear; server-side rebases
     are unsigned).
   - Setup, then create, view and navigate, fixing a lower layer, rebase and
     sync, `modify` and `unstack`, and merge.
   - Exit codes, Actions `github.event.pull_request.stack` metadata, and the raw
     `PUT .../merge-async` call.
   - Workflow rule 12 (read freely; confirm pushes, rewrites and merges; hand the
     interactive-only `modify` and `switch` to the user with `!`).
   - Under Merge & State, a warning that `gh pr merge` and `--auto` cannot merge
     stacked PRs.

2. **The user's cycle in manual order.** `linear issue list` had no cycle filter
   and did not expose `sortOrder`, so two options were added:
   - `--cycle current|next|previous|<number>|<id>`.
   - `--sort manual|created|updated`, sorted client-side, so only the fetched
     page is ordered.

   JSON output now also carries `cycle` and `sortOrder`.

3. **Peer session (KAR-13060) asked for relations.**
   - `issue relate <id> <others...> --type related|blocks|blocked-by|duplicate`.
     `blocked-by` is stored as the inverse `blocks`.
   - `issue unrelate <id> <others...>` deletes relations in either direction.
   - `issue create --related <ids...>`.
   - `issue get` always lists relations. Inverse relations read as
     `blocked-by` / `duplicated-by`.
   - `--description-file <path|->` on `issue create|update`.

4. **Same peer asked for cycle membership and manual position.**
   - `--cycle` on `issue create|update`. `update` also accepts `none`.
   - `--position first|last`, `--after <id>` and `--before <id>`.
   - `issue get` prints the cycle, and its JSON adds `cycle` and `sortOrder`.

Docs: `commands/linear.md` (Quick Reference, plus workflow items 3, 5, 6 and 7),
`scripts/README.md`, `RELEASES.md` (first entry since 2026-04-01),
`commands/prd-to-linear-tickets.md` (`--description-file` and `--estimate`, and
`relate --type blocks` for dependent Features), and the gh-cli row in
`CLAUDE.md`.

## Verification

- `tsc --noEmit` is clean.
- **Verified live:**
  - `issue list --cycle current --sort manual`: the user's 11 cycle-175 issues
    in their manual order.
  - `issue get KAR-13060`: Relations (2).
  - `issue get KAR-13082`: Cycle 175.
  - `issue relate KAR-13082 KAR-13083`: run by the peer.
  - `issue update KAR-13082|KAR-13083 --cycle 176 --position last`: run by the
    peer. Cycle 176 in manual order now ends …KAR-11734, KAR-13082, KAR-13083.
- **Not verified live:** `unrelate`, `create --related`, `--description-file`,
  `--after`/`--before`, and `--cycle none`.
- The gh-cli GraphQL `stackEntry` query is not verified. `gh` cannot reach
  api.github.com from the sandbox (`x509: OSStatus -26276`). The field names
  were taken from the GraphQL reference page. The `gh-stack` extension is not
  installed; `gh` is 2.101.0, and 2.90 or later is required.

## Key Decisions Made

- **Manual order is `Issue.sortOrder`** (ascending = top). `prioritySortOrder`
  belongs to priority-ordered views and `subIssueSortOrder` to a parent's
  sub-issue list. Confirmed by the user's cycle list matching their board.
- **`first`/`last` are relative to the issue's resulting cycle**, falling back to
  its project, then its team, and computed across every issue in that scope (not
  just the assignee's). The new value is max+1000 or min−1000. `--after`/`--before`
  take the midpoint of the two neighbours.
- **Extended the CLI rather than calling the API**, as CLAUDE.md requires. This
  meant changes to a shared tool mid-task, each time driven by a concrete request.
- **No `--body-file` for comments.** Comment bodies are positional, so adding one
  would change every comment command's signature. Deferred.
- **The sandbox exclusion matches the first word only.** `cd … && linear …` fails
  with `listen EPERM` (CLAUDE.md already says this for `slack`; `linear` is the
  same). In docs, pass `--description-file` a literal absolute path, not `$TMPDIR/...`.

## Uncommitted Changes

None. Committed in two commits (gh-cli stacked PRs; Linear CLI and docs) plus
this handoff, pushed to `jassu` and then force-pushed to `origin`.

## Known Issues

- `--sort` orders only the fetched page (`--limit`, default 50).
- `--position` fetches every issue in the scope (paged by 250). Without a cycle
  or project it falls back to the whole team, which is slow for a big team.
- `issue update --state <name>` silently ignores an unknown state name. This
  predates this session.
- `quality-format.sh` / `quality-typecheck.sh` fail in this repo (`prettier` not
  found; `apps/www/.tsconfig.quality-check.json` missing). They target the
  karmasuite app layout.
- Carried over: `ks-start-project.ts:523` still recreates `state.yaml`
  unconditionally.

## Resume Point

Nothing is blocked. Options:

- Live-test the untested Linear paths on throwaway issues:
  `issue unrelate`, `create --related`, `--description-file -` (stdin),
  `--after`/`--before`, and `--cycle none`.
- Validate the gh `stackEntry` query outside the sandbox:
  `! gh api graphql -f query='{repository(owner:"karmasuite",name:"ks"){pullRequests(last:1){nodes{number stackEntry{position stack{number size baseRefName}}}}}}'`
- The deferred `ks-start-project.ts` state preservation (mirror
  `loadExistingState` / `mergeWithExistingState` from `ks-start-ticket.ts`).
