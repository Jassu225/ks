---
name: Release Announcement
description: Post to #released when a feature or fix is deployed
channel_id: C087VMGSD6X
---

# Release Announcement Template

Post to **#released** when a feature or fix is deployed.

## Template

```
:rocket: *Released: {TITLE}*

*Problem:* {PROBLEM_DESCRIPTION}

*What changed:*
{CHANGELOG_BULLETS}

*Demo:* {LOOM_URL}
```

## Variables

| Variable | Description | Example |
|---|---|---|
| `{TITLE}` | Short feature/fix title | `Pin Newly Created Expenses to Top of Grid` |
| `{PROBLEM_DESCRIPTION}` | 1-2 sentence description of the problem that was solved | `When users clicked "+" to manually add an expense, the new expense got buried in the middle of the list.` |
| `{CHANGELOG_BULLETS}` | Bullet list of key changes (use • prefix) | `• Newly created expenses now pin to the top of the grid` |
| `{LOOM_URL}` | Loom demo video URL | `https://www.loom.com/share/05b47068b11343d190ae9f3d7e8603bb` |
