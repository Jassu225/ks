---
description: Deploy to production — runs pre-deploy diff, posts to Slack engineering channel, then deploys. Triggers - deploy, deploy to prod, production deploy.
allowed-tools: Bash(pre-deploy.sh:*), Bash(deploy.sh:*), Bash(slack:*), Read
---

# Deploy to Production

Run the full deploy workflow: generate commit diff, post to Slack, and deploy.

## Workflow

### 1. Run Pre-Deploy

Run the pre-deploy script to get the list of commits in `main` that are not yet in `live`:

```bash
pre-deploy.sh
```

Capture the commit diff output (the numbered list of commits between the `======` separator lines).

If there are no commits to deploy, inform the user and stop.

### 2. Confirm with User

Show the commit diff to the user and ask for explicit confirmation before posting to Slack and deploying. Do NOT proceed until the user approves.

### 3. Post to Slack

Use the `slack` CLI to send a message to the `engineering` channel. The message should use this format:

```
*Deploy to PROD*

{commit_diff}
```

Where `{commit_diff}` is the numbered commit list from pre-deploy.

```bash
slack message send engineering "MESSAGE"
```

### 4. Deploy

After the Slack message is sent, run the deploy script:

```bash
deploy.sh
```

### 5. Output Result

Report the deployment result to the user:
- Number of commits deployed
- Confirmation that the Slack message was posted
- Any errors encountered

## Important Notes

- If pre-deploy shows no commits to deploy, stop and inform the user — do not post to Slack or deploy.
- If the Slack message fails, ask the user whether to proceed with the deploy anyway.
- If the deploy script fails, report the error clearly.
