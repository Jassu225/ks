---
name: PR Review Request
description: Post to #engineering when a PR is ready for review
tone: technical, engineer-focused
channel_id: C051A3TSM5K
---

# PR Review Request Template

Post to **#engineering** when a PR is ready for review.

**After posting**: Update the workflow `state.yaml` — find the entry in the top-level `prs[]` array whose `url` matches `{PR_URL}` and set its `review_thread`:

```yaml
prs:
  - url: "https://github.com/karmasuite/karmasuite/pull/5643"
    # ... existing fields written at PR creation ...
    review_thread:
      channel_id: "C051A3TSM5K"
      channel_name: "engineering"
      ts: "1772719401.182549"
      url: "https://karmasuite.slack.com/archives/C051A3TSM5K/p1772719401182549"
```

If no matching `prs[]` entry exists (PR was created outside the workflow), append a new entry with `url` set to `{PR_URL}` and the `review_thread` filled in. (Legacy state files may have `slack.pr_review_threads[]` — that key is deprecated; write new data to `prs[]` only.)

## Template

```
Hey team! :eyes: PR up for review:

*{PR_TITLE}*

{PR_URL}

Changes:
{CHANGELOG_BULLETS}

Project thread: {PROJECT_THREAD}

Would appreciate a review when you get a chance. Thanks! :pray:
```

## Variables

| Variable | Description | Example |
|---|---|---|
| `{PR_TITLE}` | Conventional commit PR title | `fix(issue-groups): (KAR-11291) improve error messages` |
| `{PR_URL}` | GitHub PR URL | `https://github.com/karmasuite/karmasuite/pull/5643` |
| `{CHANGELOG_BULLETS}` | Bullet list of key changes (functional/behavioral only — do NOT add test-coverage bullets) | `• Improved issue group labels...` |
| `{PROJECT_THREAD}` | Slack project thread URL from `state.yaml` | `https://karmasuite.slack.com/archives/C05JACKMFJB/p1769783226197199` |
