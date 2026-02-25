---
description: Interact with Slack — read channels, send messages, manage files, search, reactions, pins, status, and more. Triggers - slack, Slack message, send message, channel history, slack status.
argument-hint: <action> [args...]
allowed-tools: Bash(slack:*), Read
---

# Slack CLI

Use the `slack` CLI (already in `$PATH`) to interact with Slack. All commands support `--json` / `-j` for machine-readable output. Channel and user arguments accept names or IDs.

## Quick Reference

### Channels

```bash
# List channels (includes private with --include-private)
slack channel list --limit 20
slack channel list --include-private

# Get channel info (by name or ID)
slack channel info general
slack channel info C01ABCDEF

# Get message history
slack channel history general --limit 20

# Create, archive
slack channel create my-channel --private
slack channel archive old-channel

# Invite / remove users
slack channel invite general @username
slack channel kick general @username

# Set topic / purpose
slack channel set-topic general "New topic"
slack channel set-purpose general "Channel purpose"
```

### Messages

```bash
# Send a message
slack message send general "Hello world"

# Send with Block Kit (JSON string)
slack message send general "fallback text" --blocks '[{"type":"section","text":{"type":"mrkdwn","text":"*Bold*"}}]'

# Reply in a thread (use message timestamp)
slack message reply general 1234567890.123456 "Thread reply"

# Update / delete a message
slack message update general 1234567890.123456 "Updated text"
slack message delete general 1234567890.123456
```

### Users

```bash
# List workspace users
slack user list --limit 50

# Get user info (by name, email, or ID)
slack user info @username
slack user info user@example.com
slack user info U01ABCDEF

# Get user presence
slack user presence @username

# Current authenticated user
slack user me
```

### Files

```bash
# Upload a file to a channel
slack file upload general ./report.pdf --title "Monthly Report"

# List files (with filters)
slack file list --channel general --limit 10
slack file list --user @username

# Get file info / delete
slack file info F01ABCDEF
slack file delete F01ABCDEF
```

### Reactions

```bash
# Add / remove a reaction (colons optional)
slack reaction add general 1234567890.123456 thumbsup
slack reaction remove general 1234567890.123456 :thumbsup:

# List reactions by a user
slack reaction list @username --limit 20
```

### Search (requires user token xoxp-)

```bash
# Search messages
slack search messages "quarterly report"
slack search messages "from:@username in:#general" --sort timestamp

# Search files
slack search files "budget spreadsheet" --sort timestamp --sort-dir desc
```

### Pins

```bash
# Pin / unpin a message
slack pin add general 1234567890.123456
slack pin remove general 1234567890.123456

# List pinned items
slack pin list general
```

### Status (requires user token xoxp-)

```bash
# Set your status (with optional emoji and expiration)
slack status set "In a meeting" --emoji :calendar: --expiration "2026-02-20T17:00:00Z"

# Clear your status
slack status clear
```

### Emoji

```bash
# List custom workspace emoji
slack emoji list
```

### Templates

```bash
# List available message templates (shows name, description, filename)
slack template list

# View a specific template (with or without .md extension)
slack template view pr-review-request
```

## Workflow

When the user asks to interact with Slack:

1. **Reading channels**: Use `slack channel list` to find channels, `slack channel info <name>` for details
2. **Reading messages**: Use `slack channel history <channel>` to get recent messages
3. **Sending messages**:
   - First, run `slack template list` to check for a relevant template
   - If a matching template exists, run `slack template view <filename>` to get its content, then fill in the template variables with the actual values from context
   - If no template matches, compose the message from scratch
   - **Always show the user the target channel and full message content, then ask for explicit confirmation before sending.**
   - Once confirmed, use `slack message send <channel> "text"` — supports Block Kit via `--blocks`
4. **Threading**: **Always show the user the target channel, thread, and full reply content, then ask for explicit confirmation before sending.** Once confirmed, use `slack message reply <channel> <ts> "text"`
5. **Finding users**: Use `slack user list` or `slack user info <name/email/ID>`
6. **Uploading files**: Use `slack file upload <channel> <path>` with optional `--title`
7. **Searching**: Use `slack search messages "query"` (requires user token)
8. **Setting status**: Use `slack status set "text"` with `--emoji` (requires user token)

## Notes

- Channel and user arguments accept names or IDs interchangeably
- Message timestamps (`ts`) are Slack's unique message identifiers (e.g., `1234567890.123456`)
- Emoji names work with or without colons (`:thumbsup:` or `thumbsup`)
- Search and status commands require a user token (`xoxp-`), not a bot token
- Use `--json` when you need to parse output programmatically or extract IDs/timestamps
- Token is read from `SLACK_TOKEN` in `c-scripts/.env`
