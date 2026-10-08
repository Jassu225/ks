---
description: Create a pull request (PR) with conventional commit title and standard template. Takes branch-name for which the PR needs to be created and an optional target-branch (defaults to main) for which the PR needs to be created against. Triggers - Create a PR, Create PR.
argument-hint: <branch-name> [target-branch]
allowed-tools: Bash(git:*), Bash(gh:*), Read
---

# Create Pull Request

Create a pull request for the specified branch with a conventional commit title and standardized description template.

## Arguments

- `$1` - Branch name (required)
- `$2` - Target branch (optional, defaults to `main`)

## Workflow

### 1. Extract Linear Ticket

Extract the Linear ticket number (KAR-XXX pattern) from the branch name `$1`.

- If found, use it for the "Closes" section
- If NOT found, ask the user to provide the Linear ticket number before proceeding

### 2. Ensure Branch is Pushed

Check if the branch `$1` exists on the remote:
```bash
git ls-remote --heads origin $1
```

If the branch is not on remote, push it:
```bash
git push -u origin $1
```

### 3. Gather Commit Information

Get the commits that will be in the PR (commits on `$1` not in target branch):
```bash
git log origin/${2:-main}..origin/$1 --oneline
```

Get the changed files:
```bash
git diff origin/${2:-main}...origin/$1 --name-only
```

Get detailed commit messages for changelog:
```bash
git log origin/${2:-main}..origin/$1 --pretty=format:"%s%n%b"
```

### 4. Determine Conventional Commit Type

Analyze the commits and changed files to infer the appropriate type:

- `feat` - New features, new files in feature directories, commits mentioning "add", "new", "implement"
- `fix` - Bug fixes, commits mentioning "fix", "bug", "resolve", "patch"
- `refactor` - Code restructuring, commits mentioning "refactor", "restructure", "reorganize"
- `chore` - Maintenance, config changes, dependency updates
- `docs` - Documentation changes (*.md files, comments)
- `test` - Test files (*.test.*, *.spec.*, __tests__)
- `style` - Formatting, styling changes
- `perf` - Performance improvements

### 5. Determine Scope

Analyze the changed files to determine the primary directory/module affected:

- Look at the most common parent directory among changed files
- Use meaningful module names (e.g., `api`, `components`, `hooks`, `utils`, `auth`, `db`)
- If files span multiple unrelated directories, use the most significant one based on the number of changes

### 6. Generate PR Title

Create a conventional commit formatted title:
```
type(scope): brief description
```

- The description should be derived from the branch name or primary commit message
- Keep it concise and lowercase (except for proper nouns)
- Do not end with a period

### 7. Generate Changelog

Create a changelog from the commit messages and changed files:
- Summarize the key changes made
- Group related changes together
- Be concise but informative

### 8. Create the Pull Request

Use the GitHub CLI to create the PR with this exact template format:

```bash
gh pr create --base ${2:-main} --head $1 --title "TYPE(SCOPE): DESCRIPTION" --body "BODY_CONTENT"
```

**PR Body Template:**

```markdown
## Closes

KAR-{ticket_number}

## ✅ Checklist

-   [ ] The PR title follows the [conventional-commit](https://www.conventionalcommits.org/en/v1.0.0/) convention.
-   [ ] The PR description or title contains an issue tag from Linear
-   [ ] If the PR involves visual changes, I have included screenshots of the before/after of the changes.
-   [ ] If the changes involve any new Environment Variables, I have added them on Vercel.
-   [ ] If the changes necessitate updates to the documentation, I have revised the [Notion documentation](https://www.notion.so/karmasuite/Module-Documentation-4d52c08eb7e94cd8ac3024e2d78884e1?pvs=13).
-   [ ] I have added or updated the tests related to the changes made.

---

## Changelog

{auto_generated_changelog}
```

### 9. Link Into a Stack (target branch is not `main`)

`--base <branch>` on its own is only a manual stack. GitHub treats the two PRs as unrelated and keeps offering "create a stack" on the lower PR. When `$2` is set and is not `main`, link the PRs natively:

1. Find the open PR whose head is the target branch:
   ```bash
   gh pr list --head $2 --state open --json number,url --jq '.[0]'
   ```
   If there is none, `$2` is not a PR branch (e.g. a release branch). Skip this step.
2. Check that the extension is installed: `gh extension list` should list `github/gh-stack`. If it is missing, ask the user before running `gh extension install github/gh-stack`. If they decline, skip this step and say the PRs are only manually stacked.
3. Link bottom → top by PR number:
   ```bash
   gh stack link <base-PR#> <new-PR#>
   ```
   `link` creates or updates the stack on GitHub only. It does not push, rebase, open PRs or touch local `gh stack` tracking state. If the base PR is already in a stack, pass every PR in that stack from the bottom up, then the new one, or pass the stack number first (`gh stack link <stack#> <new-PR#>`) to append.
4. If `link` fails (exit code `9` means stacked PRs are not enabled for the repo), report the error and leave the PR as a manual stack. Do not retry with other commands.

See the Stacked Pull Requests section of `/ks:gh-cli` for the rest of the `gh stack` workflow.

### 10. Output Result

After creating the PR:
- Display the PR URL
- Show the generated title
- Summarize what was included in the changelog
- If step 9 ran, show the stack (bottom → top) or why it was not linked

### 11. Record PR in Workflow State

If this PR belongs to a ks workflow (a `{project-directory-path}/state.yaml` is known from the conversation context — e.g., invoked from `/ks:project-manager` or `/ks:implement-plan`), immediately append an entry to the top-level `prs` array in that `state.yaml`:

```yaml
prs:
  - url: "https://github.com/karmasuite/karmasuite/pull/5643"
    branch: "kar-11291-improve-error-messages"
    created_at: "2026-07-05T12:00:00Z"
    review_thread: null
```

- `review_thread` starts as `null` — it gets filled in later when the PR is sent for review in Slack (see the `pr-review-request` Slack template).
- Create the `prs` array if it doesn't exist yet.
- If no workflow state.yaml is known from context, skip this step silently.

### 12. Automated Code Review

After the PR is created, suggest running `/code-review` to get automated review feedback before requesting human review. The code review checks for bugs, logic errors, and CLAUDE.md compliance.

## Important Notes

- Always verify the Linear ticket was extracted or provided before creating the PR
- If any step fails, report the error clearly and ask how to proceed
- The PR should be created as a regular PR (not draft)
