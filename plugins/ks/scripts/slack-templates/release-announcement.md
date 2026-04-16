---
name: Release Announcement
description: Post to #released when a feature or fix is deployed
tone: non-technical, customer-focused
channel_id: C087VMGSD6X
---

# Release Announcement Template

Post to **#released** when a feature or fix is deployed.

**After posting**: Store the returned Slack thread reference in the workflow `state.yaml` under `slack.release_thread` (channel_id, channel_name, ts, url).

## Posting Flow

Follow these steps strictly in order. Do NOT compose the thread reply until the main message has been confirmed and posted.

### Step 1: Show Main Message

Compose the main channel message and show it to the user. **Stop and wait for user confirmation.** Do not post or proceed until the user approves.

```
:rocket: *Released: {TITLE}*

*What changed:*
{CHANGELOG_BULLETS}
```

### Step 2: Post Main Message

After the user confirms, post the main message to the channel. Save the returned `ts` for threading.

### Step 3: Show Thread Reply

Compose the thread reply and show it to the user. **Stop and wait for user confirmation.** Do not post until the user approves.

```
*Problem:*
{PROBLEM_DESCRIPTION}

{{#if REASON_DESCRIPTION}}
*Why this happened:*
{REASON_DESCRIPTION}

{{/if}}
{{#if LOOM_URL}}
*See it in action:* {LOOM_URL}

{{/if}}
For more info, please refer to {PROJECT_THREAD}
```

### Step 4: Post Thread Reply

After the user confirms, post the thread reply using the `ts` from Step 2.

> **Note:** Omit the `*See it in action:*` line entirely when no demo video is available.

## Variables

| Variable | Description | Example |
|---|---|---|
| `{TITLE}` | Short, user-facing feature/fix title | `New Expenses Now Appear at the Top of Your List` |
| `{CHANGELOG_BULLETS}` | Bullet list of what users will directly notice (use • prefix, plain language). Order by visual changes first, then functional changes. Skip implied consequences (e.g., if decimals are now supported, don't also say "calculations are now accurate"). Omit implementation details like backfills, migrations, or internal fixes — only describe what the user sees or experiences. **Litmus test:** if a bullet describes internal system behavior (processes, validation, triggers, pipelines) rather than something the user can see or do differently, rephrase it in terms of what the user experiences — or drop it if there's no user-visible effect. | `• Basis rate percentages now support decimal values (e.g., 19.5%, 33.33%)` `• The percentage display adapts to fit decimal values cleanly` |
| `{PROBLEM_DESCRIPTION}` | 1-2 sentences explaining what users were experiencing before | `When you clicked "+" to add an expense, the new row would end up somewhere in the middle of the list, making it hard to find.` |
| `{REASON_DESCRIPTION}` | Plain-language explanation of why this was happening (for bug fixes). Omit for feature releases. | `The list was being sorted before the new row was added, so it didn't appear where you'd expect.` |
| `{LOOM_URL}` | Loom demo video URL. Check the Linear ticket for an attached demo video before recording a new one. | `https://www.loom.com/share/05b47068b11343d190ae9f3d7e8603bb` |
| `{PROJECT_THREAD}` | Slack project thread URL | `https://karmasuite.slack.com/archives/C05JACKMFJB/p1769783226197199` |
