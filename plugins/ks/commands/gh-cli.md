---
description: Interact with GitHub — create / view PRs, manage comments, resolve review threads, check CI status, and more. Triggers - gh, github, pull request, PR, PR comments, review threads, CI checks.
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

### Diff

```bash
# View the PR diff
gh pr diff 123

# View diff for current branch PR
gh pr diff
```

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
11. **Closing/reopening**: **Always confirm with the user before closing or reopening a PR.**

## Notes

- When no PR number is specified, `gh` commands default to the PR associated with the current branch.
- GitHub has two types of PR comments: *general comments* (on the conversation tab) and *review comments* (inline on code). Use `gh pr view --comments` for the former and `gh api` for the latter.
- The `{owner}` and `{repo}` placeholders in API calls can be inferred from the current git remote. Use `gh repo view --json owner,name` to get them.
- Review thread IDs for resolve/unresolve mutations are the `id` field from the GraphQL `reviewThreads` query — they are node IDs, not numeric.
- For PR creation, always use `/ks:create_pr` which handles conventional commit formatting, Linear ticket extraction, and the KarmaSuite PR body template.
- Use `--json` with `gh pr view` when you need to parse output programmatically or extract specific fields.
