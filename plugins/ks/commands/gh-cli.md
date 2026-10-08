---
description: Interact with GitHub — create / view PRs, manage comments, resolve review threads, check CI status, work with stacked PRs (gh stack), and more. Triggers - gh, github, pull request, PR, PR comments, review threads, CI checks, stacked PRs, PR stack, gh stack.
argument-hint: <action> [args...]
allowed-tools: Bash(gh:*), Bash(git:*), Read
---

# GitHub CLI

Use the `gh` CLI to interact with GitHub. Most PR commands accept a PR number, URL, or branch name. When no PR number is given, `gh` defaults to the PR associated with the current branch.

## Quick Reference

### View

```bash
# View PR details (current branch or by number)
gh pr view
gh pr view 123

# View with conversation comments
gh pr view 123 --comments

# View in web browser
gh pr view 123 --web

# View specific fields as JSON
gh pr view 123 --json title,state,body,reviews,statusCheckRollup

# View all available JSON fields
gh pr view 123 --json title
```

### List

```bash
# List open PRs
gh pr list

# List with filters
gh pr list --state merged --limit 10
gh pr list --author @me
gh pr list --label bug
gh pr list --search "review:required"
gh pr list --base main
gh pr list --head feature-branch
```

### Create

> **Important:** When creating PRs in this repo, always follow the `/ks:create_pr` command workflow — it enforces conventional commit titles, Linear ticket references (Closes KAR-XXX), and the KarmaSuite PR body template. The `gh pr create` reference below is for understanding the CLI flags.

```bash
# Create PR (interactive — prompts for title and body)
gh pr create

# Create with title and body
gh pr create --title "feat(scope): description" --body "PR body here"

# Create draft PR
gh pr create --draft --title "wip: feature" --body "Work in progress"

# Create against a specific base branch
gh pr create --base develop --head feature-branch --title "Title" --body "Body"

# Auto-fill title/body from commits
gh pr create --fill

# Add reviewers and labels
gh pr create --title "Title" --body "Body" --reviewer user1,user2 --label bug

# Read body from file
gh pr create --title "Title" --body-file pr-body.md
```

### Comments

```bash
# View PR conversation (general comments)
gh pr view 123 --comments

# Add a general comment to a PR
gh pr comment 123 --body "Comment text here"

# Edit your last comment on a PR
gh pr comment 123 --edit-last --body "Updated comment"

# Delete your last comment on a PR
gh pr comment 123 --delete-last --yes

# View inline review comments (on code lines)
gh api repos/{owner}/{repo}/pulls/123/comments

# Reply to an inline review comment
gh api repos/{owner}/{repo}/pulls/123/comments/{comment_id}/replies \
  -f body="Reply text here"
```

### Reviews

```bash
# Approve a PR
gh pr review 123 --approve

# Approve with comment
gh pr review 123 --approve --body "Looks good!"

# Request changes
gh pr review 123 --request-changes --body "Please fix the error handling"

# Leave a review comment (without approve/reject)
gh pr review 123 --comment --body "Minor suggestions inline"

# View reviews on a PR as JSON
gh pr view 123 --json reviews
```

### CI Checks

```bash
# View CI check status
gh pr checks 123

# Watch checks until they complete
gh pr checks 123 --watch

# View checks as JSON
gh pr view 123 --json statusCheckRollup
```

### Review Threads

```bash
# List review threads with resolution status
gh api graphql -f query='
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            comments(first: 10) {
              nodes {
                body
                author { login }
                createdAt
              }
            }
          }
        }
      }
    }
  }
' -f owner='{owner}' -f repo='{repo}' -F number=123

# Resolve a review thread
gh api graphql -f query='
  mutation($threadId: ID!) {
    resolveReviewThread(input: {threadId: $threadId}) {
      thread { isResolved }
    }
  }
' -f threadId='THREAD_NODE_ID'

# Unresolve a review thread
gh api graphql -f query='
  mutation($threadId: ID!) {
    unresolveReviewThread(input: {threadId: $threadId}) {
      thread { isResolved }
    }
  }
' -f threadId='THREAD_NODE_ID'
```

### Merge & State

```bash
# Merge a PR (auto-selects merge method)
gh pr merge 123

# Merge with specific strategy
gh pr merge 123 --squash
gh pr merge 123 --rebase
gh pr merge 123 --merge

# Merge and delete branch
gh pr merge 123 --squash --delete-branch

# Close a PR without merging
gh pr close 123

# Reopen a closed PR
gh pr reopen 123

# Mark as ready for review (remove draft status)
gh pr ready 123
```

> **Stacked PRs:** `gh pr merge` and `gh pr merge --auto` do not work on a PR that belongs to a stack. GitHub merges stacks only through the asynchronous merge API, and auto-merge is not supported for stacks. Use `gh stack merge` instead (see [Stacked Pull Requests](#stacked-pull-requests)).

### Diff

```bash
# View the PR diff
gh pr diff 123

# View diff for current branch PR
gh pr diff
```

### Stacked Pull Requests

A stack is a chain of PRs in **one repository**: the bottom PR targets the trunk (usually `main`), and each PR above it targets the branch of the PR below. Each PR shows only its own layer's diff. GitHub calls the feature a public preview. Docs: <https://docs.github.com/en/pull-requests/how-tos/stacked-pull-requests>.

```text
   ┌── feat/frontend     → PR #3 (base: feat/api-endpoints)  ← top
  ┌── feat/api-endpoints → PR #2 (base: feat/auth-layer)
 ┌── feat/auth-layer     → PR #1 (base: main)               ← bottom
main (trunk)
```

How GitHub treats a stack:

- **Rules and CI use the stack's trunk.** Every PR, including mid-stack PRs, is evaluated as if it targeted the trunk: required reviews, required checks, CODEOWNERS and code scanning. Actions workflows on `pull_request` targeting `main` run for every PR in the stack.
- **Merges go bottom-up.** Merging a PR also merges every unmerged PR below it, as one all-or-nothing operation. PRs above it stay open and are rebased onto the trunk. A mid-stack PR cannot merge alone. Merging the top PR merges the whole stack.
- **History must be linear before anything merges.** When a lower branch changes or the trunk moves ahead, the stack must be rebased first, with `gh stack rebase` or the **Rebase stack** button in the merge box.
- **Server-side rebases are not signed.** If the repo requires signed commits, rebase locally with `gh stack rebase`.
- **Not supported:** cross-fork stacks, auto-merge, `gh pr merge` (it uses the legacy synchronous merge), and GitHub Desktop. Merge queues are supported, and the stack enters the queue in order.
- **Closing a mid-stack PR blocks every PR above it.** To replace that PR, unstack and then re-create the stack.

#### Setup

```bash
# Requires gh >= 2.90.0 and git >= 2.20
gh extension install github/gh-stack
gh extension list            # confirm github/gh-stack is listed
```

If a `gh stack` command fails with `unknown command "stack"`, the extension is missing. Ask the user before installing it. Exit code `9` means stacked PRs are not enabled for the repository.

#### Create

> **Important:** Creating PRs in this repo still goes through `/ks:create_pr`, so titles, the `Closes KAR-XXX` reference and the body template stay consistent. Two ways to combine that with stacks:
> - Run `/ks:create_pr` for each layer, with `--base` set to the branch below, then link the PRs with `gh stack link`.
> - Run `gh stack submit`, then bring each new PR's title and body in line with `/ks:create_pr` (`gh pr edit <n> --title ... --body-file ...`).
>
> `gh pr create --base <branch>` alone is **not** a native stack. GitHub sees two unrelated PRs and keeps offering "create a stack" on the lower one. `gh stack link` turns them into a stack without pushing, rebasing or opening duplicate PRs. `/ks:create_pr` does this itself when its target branch has an open PR.

**Splitting a PR into a code PR and a stacked tests PR.** Commit the tests' removal on the code branch first, then cut the tests branch from that commit and re-add the tests there (`git revert <removal-commit>`). A tests branch cut before the removal commit has the same content as its merge base with the code branch, so GitHub shows an empty diff. Then open the PR with `/ks:create_pr <tests-branch> <code-branch>`, which links the two PRs.

```bash
# Start a stack (creates and checks out the first branch on top of the trunk)
gh stack init feat/auth-layer
gh stack init --base release/1.2 feat/auth-layer   # non-default trunk
gh stack init feat/a feat/b feat/c                 # adopt existing branches, create missing ones

# Add the next layer on top (must be on the top branch)
gh stack add feat/api-endpoints
gh stack add -Am "Add login endpoint"              # stage all, commit, auto-name the branch
gh stack add -um "Fix auth bug" fix-layer          # tracked files only, explicit branch name

# Push every branch, then create or update the PRs and link them as a stack
gh stack submit                # interactive editor (TTY)
gh stack submit --auto         # no editor, generated titles, new PRs open as drafts
gh stack submit --auto --open  # same, but PRs open ready for review

# Link branches or PRs you already have into a stack (bottom → top), with no local tracking
gh stack link feat/a feat/b feat/c
gh stack link 10 20 30
gh stack link 7 48 feat/ui     # append to existing stack #7
gh stack link --base develop --open feat-a feat-b
```

`submit` and `link` both push branches and create PRs, so they are **outward-facing**: show the user the branches, base chain and PR titles first, and get confirmation. When an agent runs them (no TTY), use `--auto`, or `submit` falls back to non-interactive mode anyway.

#### View & navigate

```bash
gh stack view                 # full-screen in a TTY, static output otherwise
gh stack view --short         # one line per branch
gh stack view --json          # machine-readable; prefer this when parsing

gh stack checkout 42          # by PR number, stack number, PR URL, or branch; pulls a remote stack locally
gh stack up [n] / gh stack down [n]
gh stack top / gh stack bottom / gh stack trunk
# gh stack switch — interactive picker, needs a TTY; agents use checkout instead
```

Stack membership of a PR (read-only GraphQL; `gh pr view --json` has no stack field):

```bash
gh api graphql -f query='
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        stackEntry {
          position
          stack {
            number
            size
            baseRefName
            entries(first: 50) {
              nodes { position pullRequest { number title state headRefName baseRefName url } }
            }
          }
        }
      }
    }
  }
' -f owner='{owner}' -f repo='{repo}' -F number=123
```

`stackEntry` is `null` when the PR is not in a stack. Position `1` is the bottom PR. REST PR resources carry the same data in a `stack` object (`number`, `size`, `position`, `base.ref`, `base.sha`):

```bash
gh api repos/{owner}/{repo}/pulls/123 --jq '.stack'
```

#### Change a lower layer / address review feedback

Make each fix on the branch that owns the change, then cascade it upward:

```bash
gh stack checkout feat/auth-layer    # or: gh stack down
git add . && git commit -m "fix: ..."
gh stack rebase --upstack            # rebase the branches above onto the fix
gh stack push                        # --force-with-lease per branch; does not touch PRs
gh stack top                         # return to where you were
```

#### Rebase & sync

```bash
gh stack rebase                 # fetch, then cascade-rebase every branch from the trunk up
gh stack rebase --downstack     # trunk → current branch only
gh stack rebase --upstack       # current branch → top only
gh stack rebase --no-trunk      # branches onto each other only, no fetch, trunk left alone
gh stack rebase --continue      # after resolving conflicts and running `git add`
gh stack rebase --abort         # restore every branch to its pre-rebase state

gh stack sync                   # fetch, ff trunk, rebase if trunk moved, push, sync PR state, link stack
gh stack sync --prune           # also delete local branches of merged PRs
```

- `sync` never opens PRs; only `submit` does. When `sync` hits a conflict, it restores every branch, so run `gh stack rebase` to resolve the conflict and then `gh stack push`.
- When the local and remote stacks have diverged, `sync` prompts in a TTY. In a non-interactive shell it aborts without pushing and still exits 0. Check its output, don't trust the exit code.
- `gh stack init` turns on `git rerere`, so conflict resolutions are remembered across rebases.

#### Restructure

`gh stack modify` is an **interactive TUI** with these keys: `x` drop, `d`/`u` fold down/up, `i`/`I` insert below/above, `r` rename, Shift+↑/↓ reorder, `z` undo, Ctrl+S apply. An agent cannot drive it, so hand it to the user with `! gh stack modify`. It needs a clean tree, no rebase in progress, no PR queued, and linear history. After it runs, `gh stack submit` replaces the stack on GitHub. Recover with `gh stack modify --continue` or `gh stack modify --abort`.

The non-interactive alternative: run `gh stack unstack`, fix the branches with git, then run `gh stack init <branches...>` (it adopts existing branches) and `gh stack submit`.

```bash
gh stack unstack           # dissolve the active stack on GitHub and remove local tracking (alias: delete)
gh stack unstack 7         # by stack number, from anywhere
gh stack unstack --local   # local tracking only
```

Merged and queued PRs cannot be unstacked. A stack that still holds them stays on GitHub with those PRs in it.

#### Merge

```bash
gh stack merge                    # active stack; interactive pick of how far to merge, method, confirm
gh stack merge 42                 # merge everything up to and including PR #42
gh stack merge 7                  # stack #7, no checkout needed
gh stack merge 42 --yes --squash  # non-interactive (also --merge, --rebase, --merge-method <m>)
```

- Only basic state is checked up front: each PR must be open and not a draft. Branch protection is evaluated when the merge runs, and requirements cannot be bypassed.
- With a merge queue, the stack is enqueued instead, and merge-method flags are ignored. A PR ejected from the queue takes every PR above it with it.
- If a merge fails partway, the PRs below the failure stay merged, and the failed PR and everything above it stay open. Fix the failure, then retry.
- Once every PR in a stack has merged, the stack is closed. The next `gh stack submit` starts a new stack.

The raw API equivalent is the async merge. It includes all open downstack PRs, returns `202` with a UUID, and you poll that UUID for `merged`, `enqueued` or `failed`:

```bash
gh api -X PUT repos/{owner}/{repo}/pulls/123/merge-async \
  -f merge_method=squash -f merge_action=default   # default | direct_merge | merge_queue
gh api repos/{owner}/{repo}/pulls/123/merge-async/{uuid}
```

#### Exit codes

`0` ok · `1` generic error · `2` not in a stack / stack not found · `3` rebase conflict · `4` GitHub API failure · `5` bad args · `6` branch is in multiple stacks (pass a stack or PR number) · `7` rebase already in progress · `8` stack locked by another process · `9` stacked PRs not enabled for the repo · `10` modify interrupted (`gh stack modify --abort`)

#### CI metadata

In Actions, `github.event.pull_request.stack` is present only for stacked PRs. Its fields are `number`, `size`, `position` (1 = bottom), `base.ref` and `base.sha`. To run expensive jobs once per stack, gate on the top PR (`stack.position == stack.size`) or on the lowest unmerged PR (`stack.base.ref == pull_request.base.ref`).

## Workflow

When the user asks to interact with GitHub:

1. **Viewing a PR**: Use `gh pr view <number>` for details. Add `--comments` for conversation, `--json reviews` for reviews, or `--json statusCheckRollup` for CI status.
2. **Listing PRs**: Use `gh pr list` with appropriate filters (`--state`, `--author @me`, `--label`, `--search`).
3. **Creating a PR**: Always use `/ks:create_pr` which enforces the KarmaSuite PR conventions (conventional commit title, Linear ticket, checklist template). Do not use raw `gh pr create` for PR creation in this repo.
4. **Reading comments**: Use `gh pr view <number> --comments` for general conversation. Use `gh api repos/{owner}/{repo}/pulls/{number}/comments` for inline review comments on code.
5. **Adding a comment**: **Always show the user the target PR and full comment text, then ask for explicit confirmation before posting.** Once confirmed, use `gh pr comment <number> --body "text"`.
6. **Replying to a review comment**: First fetch review comments to identify the comment ID. **Always show the user the original comment being replied to and the full reply text, then ask for explicit confirmation before posting.** Once confirmed, use `gh api repos/{owner}/{repo}/pulls/{number}/comments/{id}/replies -f body="text"`.
7. **Reviewing a PR**: **Always show the user the review type (approve/request-changes/comment) and body text, then ask for explicit confirmation before submitting.** Once confirmed, use `gh pr review <number>` with the appropriate flag.
8. **Checking CI status**: Use `gh pr checks <number>` to view check status. Use `--watch` to wait for completion.
9. **Managing review threads**: Use the GraphQL query to list threads and their resolution status. **Always confirm with the user before resolving or unresolving a thread.**
10. **Merging a PR**: **Always show the user the PR title, merge strategy, and whether the branch will be deleted, then ask for explicit confirmation before merging.**
11. **Closing/reopening**: **Always confirm with the user before closing or reopening a PR.** Closing a mid-stack PR blocks every PR above it, so say so if the PR is stacked.
12. **Stacked PRs**: Check `gh extension list` for `github/gh-stack` first. If it is missing, ask before installing.
    - **Read freely**: `gh stack view --json` for a local stack, or the `stackEntry` GraphQL query for any PR. Before merging, closing or retargeting a PR, check whether it is stacked.
    - **Confirm with the user first**: `submit`, `link`, `push`, `sync`, `rebase`, `unstack` and `merge` all push, rewrite or merge branches. Show what will change: branches, base chain, which PRs merge and the merge method.
    - **Hand interactive-only commands to the user** (`! gh stack modify`, `! gh stack switch`). In a non-interactive shell, pass `--auto` to `submit` and `--yes` to `merge`, but only after the user has confirmed.
    - **Merge stacks with `gh stack merge`**, never `gh pr merge`.

## Notes

- When no PR number is specified, `gh` commands default to the PR associated with the current branch.
- GitHub has two types of PR comments: *general comments* (on the conversation tab) and *review comments* (inline on code). Use `gh pr view --comments` for the former and `gh api` for the latter.
- The `{owner}` and `{repo}` placeholders in API calls can be inferred from the current git remote. Use `gh repo view --json owner,name` to get them.
- Review thread IDs for resolve/unresolve mutations are the `id` field from the GraphQL `reviewThreads` query — they are node IDs, not numeric.
- For PR creation, always use `/ks:create_pr` which handles conventional commit formatting, Linear ticket extraction, and the KarmaSuite PR body template.
- Use `--json` with `gh pr view` when you need to parse output programmatically or extract specific fields.
- Stacked PRs are a GitHub public preview, so flags may change. If a `gh stack` flag shown here is rejected, check `gh stack <cmd> --help` before retrying.
- For a stacked PR, `baseRefName` is the branch directly below it. The stack's trunk is `stackEntry.stack.baseRefName` (GraphQL) or `.stack.base.ref` (REST).
