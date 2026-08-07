---
description: Interact with Slack — read channels, send messages (with @mention encoding), inspect users and user groups, manage files, search, reactions, pins, status, and more. Triggers - slack, Slack message, send message, channel history, slack status, slack user group.
argument-hint: <action> [args...]
allowed-tools: Bash(slack:*), Read
---

# Slack CLI

Use the `slack` CLI (already in `$PATH`) to interact with Slack. All commands support `--json` / `-j` for machine-readable output. Channel and user arguments accept names or IDs.

> **Run unsandboxed.** The `slack` CLI needs network access to `slack.com`, reads `SLACK_TOKEN` from `plugins/ks/scripts/.env`, and uses `tsx` which opens a Unix IPC pipe in `/tmp`. All three are blocked in the default Claude Code sandbox (you'll see `EPERM` on the pipe or an empty-token error). Invoke `slack ...` with `dangerouslyDisableSandbox: true`, or have the user whitelist `Bash(slack:*)` outside the sandbox.

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

# Send with one or more file attachments (repeat --file for each)
slack message send general "see attached" --file ./report.pdf
slack message send general "see attached" --file ./a.pdf --file ./b.png --file ./c.csv

# Reply in a thread (use message timestamp)
slack message reply general 1234567890.123456 "Thread reply"

# Update / delete a message
slack message update general 1234567890.123456 "Updated text"
slack message delete general 1234567890.123456

# @handles in the text are encoded so they actually notify:
#   @username  -> <@U01ABCDEF>            @engineers -> <!subteam^S06UD9DDCBV|@engineers>
#   @here / @channel / @everyone -> <!here> / <!channel> / <!everyone>
slack message send general "@engineers PR is ready, cc @username"

# Keep handles as literal text (nobody gets pinged)
slack message send general "mention @username in your reply" --no-resolve-mentions
```

Mention encoding skips email addresses and mentions you already encoded yourself, and leaves unknown handles untouched. It does **not** touch `--blocks` JSON — encode mentions inline there.

### Users

```bash
# List workspace users (paginated; --limit caps the result, default 100)
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

`user list` returns every workspace **member**, which includes each installed app's bot user (badged `[bot]`) and `USLACKBOT` — on a typical workspace that is a large share of the rows. Filter with `--json` + `jq`:

```bash
# Humans only
slack user list --limit 1000 --json | jq '[.[] | select(.is_bot == false and .deleted == false and .id != "USLACKBOT")]'

# Bots and app users only
slack user list --limit 1000 --json | jq '[.[] | select(.is_bot or .is_app_user)]'
```

Apps themselves are not listed — you get an app's bot user (`U…`), never the app entity (`A…`), and a message's `bot_id` (`B…`) cannot be resolved to an app through this CLI.

### User groups (read-only)

```bash
# List groups (disabled ones hidden unless asked for)
slack usergroup list
slack usergroup list --include-disabled

# Group details — by handle, name, or ID
slack usergroup info @engineers
slack usergroup info "Engineering Team"
slack usergroup info S06UD9DDCBV

# Who is in the group (deactivated members shown as ○)
slack usergroup users @engineers
```

Read-only by design: there is no create/update/enable/disable. Change membership in Slack itself. Requires `usergroups:read`; groups are a paid-plan feature, and IdP-synced groups report `is_external`.

### Files

```bash
# Upload a file to a channel
slack file upload general ./report.pdf --title "Monthly Report"

# Upload multiple files in one message (variadic)
slack file upload general ./a.pdf ./b.png ./c.csv --comment "Q2 assets"

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
   - If a matching template exists, run `slack template view <filename>` to get its content, then fill in the template variables with the actual values from context. If the template frontmatter includes a `channel_id`, use that as the target channel for sending. If it includes a `tone` property (e.g., `tone: non-technical, product-focused`), write the message in that style.
   - If no template matches, compose the message from scratch
   - **Mentioning users**: If the message should mention or address someone (e.g., the user says "ask John…", "tell Sarah…", "ping @username…"), resolve the person's name to a Slack user ID first by running `slack user info <name> --json` and extracting the `id` field. If the lookup fails (user not found), the name may be misspelled — run `slack user list --json` and find the closest match by comparing real names and display names. Then use `<@USER_ID>` in the message text so the person gets a proper Slack mention/notification. For example, if the user says "ask Jas about the deploy", resolve "Jas" → `U01ABCDEF`, then compose the message with `<@U01ABCDEF>` in the text.
   - **Always show the user the target channel and full message content, then ask for explicit confirmation before sending.**
   - Once confirmed, use `slack message send <channel> "text"` — supports Block Kit via `--blocks`, attachments via repeatable `--file <path>`
   - **Inspecting the response (avoid duplicate posts)**: `slack message send` (and `reply` / `update`) is a mutating call. The `--json` response is long (auth metadata, file blobs, scopes). Never re-run a mutating command just to "see more output" — each call posts again. Instead:
     - Capture the full response in one go: `slack message send <channel> "text" --json > /tmp/slack_send.json 2>&1`, then `cat /tmp/slack_send.json | jq '{ok, ts, channel}'` (or read the file with the Read tool).
     - Or pipe to `head` not `tail` — the `"ok"`, `"channel"`, `"ts"` fields appear at the top of the JSON response.
     - If you suspect a send failed, verify with the non-mutating `slack channel history <channel> --limit 1` before retrying.
4. **Threading**: **Always show the user the target channel, thread, and full reply content, then ask for explicit confirmation before sending.** Once confirmed, use `slack message reply <channel> <ts> "text"`. The same "never re-run to inspect output" rule from step 3 applies.
5. **Finding users**: Use `slack user list` or `slack user info <name/email/ID>`
6. **Uploading files**: Use `slack file upload <channel> <path...>` (one or many paths) with optional `--title` (single file), `--comment`, `--thread-ts`
7. **Searching**: Use `slack search messages "query"` (requires user token)
8. **Setting status**: Use `slack status set "text"` with `--emoji` (requires user token)

## Notes

- Channel and user arguments accept names or IDs interchangeably; user group arguments accept handle, name, or `S…` ID
- User IDs start with `U`, or `W` on Enterprise Grid — both resolve
- Message timestamps (`ts`) are Slack's unique message identifiers (e.g., `1234567890.123456`)
- Emoji names work with or without colons (`:thumbsup:` or `thumbsup`)
- Search and status commands require a user token (`xoxp-`), not a bot token
- Use `--json` when you need to parse output programmatically or extract IDs/timestamps
- `--json` responses can be long (especially `message send` with attachments — includes file metadata and OAuth scopes). The `"ok"` / `"ts"` / `"channel"` fields are at the **top** of the response, so `head` works but `tail` will clip to noisy auth/scope blocks that can look like errors. Prefer redirecting to a temp file and inspecting it, or piping to `jq`. Re-running a `send` / `reply` / `update` / `delete` to "see more output" posts again — verify via `channel history` instead.
- Token is read from `SLACK_TOKEN` in `scripts/.env`
- `--json` output is clean stdout — safe to pipe straight into `jq`
