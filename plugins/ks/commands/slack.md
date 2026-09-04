---
description: Interact with Slack — read channels, send messages (with @mention encoding), inspect users and user groups, manage files, search, reactions, pins, status, and more. Triggers - slack, Slack message, send message, channel history, slack status, slack user group.
argument-hint: <action> [args...]
allowed-tools: Bash(slack:*), Read
---

# Slack CLI

Use the `slack` CLI (already in `$PATH`) to interact with Slack. All commands support `--json` / `-j` for machine-readable output. Channel and user arguments accept names or IDs.

> **The token is automatic — never supply it.** The CLI loads `SLACK_TOKEN` itself from `plugins/ks/scripts/.env`, resolved relative to the script's own location, so it works from any working directory. Just run `slack ...`. Do **not** prefix commands with `SLACK_TOKEN=…`, do not `export` it, do not `source .env` first, and do not pass a token as a flag — there is no such flag. Do not read `.env` to fetch the token either; it is a secret and the CLI already has it. If you see `Error: SLACK_TOKEN environment variable is not set`, the cause is a missing or empty entry in that `.env` file (or the sandbox blocking the read) — tell the user, rather than trying to route a token in yourself.

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

# Get message history (reactions included; --names resolves user IDs)
slack channel history general --limit 20
slack channel history general --limit 20 --names

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

# READ a thread — parent plus every reply, paginated (pass the PARENT's ts)
slack message thread general 1234567890.123456
slack message thread general 1234567890.123456 --json
# ...with user IDs (authors and reactors) resolved to display names
slack message thread general 1234567890.123456 --names

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

To read the reactions **on** a message rather than by a user, use `channel history` or
`message thread` — both carry `reactions[]` and print them under the message text. See
"Reactions are answers" in Notes.

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
- Token is read from `SLACK_TOKEN` in `scripts/.env` by the CLI itself — never supply, export, or unset it (see the note at the top). If a call fails with `token_revoked` or `invalid_auth`, **stop and tell the user**; do not attempt to work around it
- **Invoke `slack` as the leading token of the command line.** The sandbox exclusion is matched against the first word, so `slack …` runs unsandboxed but `env … slack …`, `cd /x && slack …`, and `for q in …; do slack …; done` all fall back into the sandbox, where the `npx tsx` wrapper dies on a blocked Unix socket: `Error: listen EPERM … /tmp/claude-501/tsx-501/<pid>.pipe`. One `slack` call per Bash invocation, no wrappers, no `cd &&`, no loops, no batching. Two dead ends not worth retrying: repointing `TMPDIR` (the `listen` syscall is blocked, not the path) and `node --import tsx/esm slack-cli.ts …` (clears the EPERM, then hangs — sandboxed egress to slack.com never connects)
- **`--json` key style is not uniform — check before writing a `jq` path.** Subcommands that map the response use **camelCase** (`channel list` → `numMembers`, `isPrivate`; `channel history` → `replyCount`, `threadTs`; `message thread` → `threadTs`, `isParent`, `datetime`; both carry `reactions[]` whose own keys are Slack's `name`/`count`/`users`, and the key is **absent** when a message has none), while those that pass Slack's payload straight through keep **snake_case** (`user list` → `real_name`, `is_bot`, `is_app_user`, `display_name`; `usergroup list` → `user_count`, `auto_type`, `default_channels`). `search messages` has no multi-word keys at all (`channel`, `user`, `text`, `ts`, `permalink`). Carrying a `user list` habit over to `message thread` yields silent `null`s rather than an error, which reads like missing data
- **Getting a parent `ts` for `message thread`**: `search messages` is the practical route — its `permalink` carries `?thread_ts=<parent>` when the hit is a reply, so the parent ts is right there in the URL
- **Reactions are answers.** `channel history` and `message thread` carry a message's `reactions` (`name`, `count`, `users[]`), and print them under the text in the human-readable output. A 👍 is a normal way to approve in this workspace, so a message that looks unanswered may have been answered with emoji — check `reactions` before reporting anyone as unresponsive. Pass `--names` to both commands to resolve the user IDs (message authors and reactors) to display names; it costs a full `users.list` walk, so it is opt-in. `search messages` does **not** appear to return reactions on its matches — absence there proves nothing, so re-read the message with `message thread` before concluding
- **Reading threads**: `channel history` returns top-level messages only — it gives `replyCount` but not the replies. Use `message thread <channel> <ts>` for the replies. Pass the **parent's** `ts`: a reply's `ts` returns only that one message (the command says so and prints the parent's ts to retry with). A message with no replies returns just itself
- `--json` output is clean stdout — safe to pipe straight into `jq`
