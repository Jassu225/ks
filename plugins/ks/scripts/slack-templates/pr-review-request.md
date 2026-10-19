---
name: PR Review Request
description: Post to #engineering when a PR is ready for review
tone: technical, engineer-focused
channel_id: C051A3TSM5K
---

# PR Review Request Template

Post to **#engineering** when a PR is ready for review.

**After posting** (Step 2, the main message): Update the workflow `state.yaml` — find the entry in the top-level `prs[]` array whose `url` matches `{PR_URL}` and set its `review_thread`:

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

If no matching `prs[]` entry exists (PR was created outside the workflow), append a new entry (`url`, `branch`, `created_at`, `review_thread` — the shape enforced by the state schemas) with `url` set to `{PR_URL}` and the `review_thread` filled in. Never write `slack.pr_review_threads[]` — that key has been removed from the schemas. It may still exist in older state files (entries shaped `{channel_id, channel_name, ts, url, pr_url}` with the PR link in `pr_url`); read it only as a fallback and migrate the data to `prs[]` on the next write.

## Posting Flow

The message goes out in two parts: the main message in the channel, and the changes as a reply in its thread. Follow these steps in order. Do NOT compose the thread reply until the main message has been confirmed and posted.

**Send both parts with `--no-unfurl`** unless the user asks for link previews. The PR and project-thread links would otherwise expand into large GitHub and Slack previews. Previews can't be turned on after posting, only removed. With screenshots or other files attached, previews can't be turned off: tell the user the links will unfurl, and on their confirmation send with `--file` and without `--no-unfurl`.

### Step 1: Show Main Message

Compose the main channel message and show it to the user. **Stop and wait for user confirmation.** Do not post or proceed until the user approves.

```
Hey team! :eyes: PR up for review:

*{PR_TITLE}*

{PR_URL}

Project thread: {PROJECT_THREAD}

Would appreciate a review when you get a chance. Thanks! :pray:
```

### Step 2: Post Main Message

After the user confirms, post the main message to the channel:

```
slack message send C051A3TSM5K "<main message>" --no-unfurl
```

Save the returned `ts`: the thread reply goes under it, and it is the `review_thread` recorded in `state.yaml` (see **After posting**).

### Step 3: Show Thread Reply

Compose the thread reply and show it to the user. **Stop and wait for user confirmation.** Do not post until the user approves.

```
Changes:
{CHANGELOG_BULLETS}
```

### Step 4: Post Thread Reply

After the user confirms, post the thread reply using the `ts` from Step 2:

```
slack message reply C051A3TSM5K <ts> "<thread reply>" --no-unfurl
```

## Variables

| Variable | Description | Example |
|---|---|---|
| `{PR_TITLE}` | Conventional commit PR title | `fix(issue-groups): (KAR-11291) improve error messages` |
| `{PR_URL}` | GitHub PR URL | `https://github.com/karmasuite/karmasuite/pull/5643` |
| `{CHANGELOG_BULLETS}` | Bullet list of key changes (functional/behavioral only — do NOT add test-coverage bullets) | `• Improved issue group labels...` |
| `{PROJECT_THREAD}` | Slack project thread URL from `state.yaml` | `https://karmasuite.slack.com/archives/C05JACKMFJB/p1769783226197199` |
