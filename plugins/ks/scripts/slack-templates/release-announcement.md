---
name: Release Announcement
description: Post to #released when a feature or fix is deployed
tone: non-technical, product-focused
channel_id: C087VMGSD6X
---

# Release Announcement Template

Post to **#released** when a feature or fix is deployed.

**After posting**: Store the returned Slack thread reference in the workflow `state.yaml` under `slack.release_thread` (channel_id, channel_name, ts, url).

## Template

```
:rocket: *Released: {TITLE}*

*Problem:* {PROBLEM_DESCRIPTION}

*What changed:*
{CHANGELOG_BULLETS}

*Demo:* {LOOM_URL}

For more info, please refer to {PROJECT_THREAD}
```

## Variables

| Variable | Description | Example |
|---|---|---|
| `{TITLE}` | Short feature/fix title | `Pin Newly Created Expenses to Top of Grid` |
| `{PROBLEM_DESCRIPTION}` | 1-2 sentence description of the problem that was solved | `When users clicked "+" to manually add an expense, the new expense got buried in the middle of the list.` |
| `{CHANGELOG_BULLETS}` | Bullet list of key changes (use • prefix) | `• Newly created expenses now pin to the top of the grid` |
| `{LOOM_URL}` | Loom demo video URL | `https://www.loom.com/share/05b47068b11343d190ae9f3d7e8603bb` |
| `{PROJECT_THREAD}` | Slack project thread URL | `https://karmasuite.slack.com/archives/C05JACKMFJB/p1769783226197199` |
