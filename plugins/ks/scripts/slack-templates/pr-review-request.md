---
name: PR Review Request
description: Post to #engineering when a PR is ready for review
tone: technical, engineer-focused
channel_id: C051A3TSM5K
---

# PR Review Request Template

Post to **#engineering** when a PR is ready for review.

**After posting**: Store the returned Slack thread reference in the workflow `state.yaml` under `slack.pr_review_threads[]` (channel_id, channel_name, ts, url, and pr_url).

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
