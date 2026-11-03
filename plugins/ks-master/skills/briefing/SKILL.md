---
name: briefing
description: Run one Briefing pass — read Slack since the last cursor (DMs and group DMs, @mentions, the user's name written anywhere, and their own messages for promises), and put everything that needs them on the ks-flow board as items with due times. The ks-master session's job on every scheduled slot, the board's "Brief me now", log-in and log-off. Arguments - <trigger> [slot], trigger one of schedule, button, log-in, log-off, manual.
argument-hint: <schedule|button|log-in|log-off|manual> [HH:MM]
---

# Briefing pass

One pass reads Slack from the last cursor up to now and leaves the board
holding one item per message that needs the user: what is asked of them (`ask`),
what they said they would do (`promise`), and what they should know (`fyi`), each with
a due time. You (the master) open and close the run; **a subagent does the
reading**, so the Slack text never fills your context.

Rules that apply throughout (the master instructions have the rest): the only
write path is `ks-flow briefing …`; there is no archive and you never ask for
one; a due time the user set (`dueSetByYou`) is never changed; `slack` and
`ks-flow` are the first word of each Bash command, one call per command, no
pipes or loops; never supply `SLACK_TOKEN`.

## 1. Open the run (you)

Arguments: `$ARGUMENTS` — the first word is the trigger (`schedule`, `button`,
`log-in`, `log-off`, `manual`; anything else or nothing: `manual`), the second
a slot `HH:MM` (scheduled runs only).

```bash
ks-flow briefing run start --trigger <trigger> [--slot <HH:MM>] --json
```

Note `uid` (the run id), `startedAt` and `previousCursor`. The window to read:

- **from** = `previousCursor`, or `startedAt` minus 24 hours when there is none
  (the first run).
- **to** = `startedAt`. The cursor moves only this far, so a message that
  arrives while you read is read next time.

## 2. Delegate the reading (subagent)

Start **one** `general-purpose` subagent with the Agent tool. Give it the brief
in "The reader's brief" below with `<RUN>`, `<FROM>` and `<TO>` filled in, and
wait for its report. Do not read Slack yourself, and do not start a second
reader for the same run.

If the subagent fails, or its report says it could not finish (Slack errors,
the store unreachable), go to step 3 with `--failed`.

## 3. Close the run (you)

```bash
ks-flow briefing run finish <RUN> --cursor <TO> --added <created> --updated <updated> --summary "<one line>"
```

`--added` = items created, `--updated` = items updated (the reader's counts).
On a failure leave the cursor where it was, so the next pass reads the window
again:

```bash
ks-flow briefing run finish <RUN> --added <n> --updated <n> --failed "<what went wrong, one line>"
```

## 4. Report

For `log-in` and `log-off` triggers, return only the counts and the reader's
"most urgent" lines: the calling skill reports. Otherwise tell the user, in at
most six lines:

- `Briefing <HH:MM>: N new, M updated` (plus "nothing new" when both are 0).
- Anything overdue or due within two hours, one line each: title — who — due.
- Their promises due today.
- Evidence added ("looks done — archive on the board if so").

Then stop. Do not offer to do the items, and never archive.

---

## The reader's brief

Paste this to the subagent, with the placeholders filled in.

> You read Slack for the user's Briefing and write what needs them to the ks-flow
> board. Run `<RUN>`, window from `<FROM>` to `<TO>` (ISO; include a message
> when FROM ≤ its time < TO).
>
> **Command rules (the sandbox enforces them):** `slack` and `ks-flow` must be
> the first word of every Bash command. One call per Bash invocation: no `cd …
> &&`, no `env`, no pipes, no loops, no `$(…)`. Never supply, export or read
> `SLACK_TOKEN`; on `token_revoked` / `invalid_auth` stop and report it. Never
> send, react to or edit anything in Slack. There is no archive command; never
> look for one.
>
> **A. What you know already.** Run `ks-flow briefing context`. Keep:
> `settings.names` (names to look for: the user's name and any nicknames), `settings.halfTime`
> (Slack user ids whose windows are halved — the CLI applies that itself),
> `knownKeys` (every item's key, archived ones too), `open` (open items: their
> `uid`, `key`, `groupKey`, `source.messageUrl`, `dueSetByYou`), and
> `board.units` (`identifier`, `title`, `pr`) for linking items to tickets.
> Then `slack user me --json` for their Slack user id and handle.
>
> **B. Read Slack in the window.** Collect every message below, deduplicated by
> channel + ts. `after:` in a search is a whole day and exclusive: use the day
> before FROM's local date, then drop hits outside the window yourself.
>
> 1. *DMs and group DMs.* `slack channel list --type im --limit 1000 --json` and
>    `slack channel list --type mpim --limit 1000 --json`. For each conversation:
>    `slack channel history <id> --oldest <FROM> --latest <TO> --limit 200 --json`.
>    For a message with `replyCount`, read its thread
>    (`slack message thread <id> <ts> --json`) and keep the replies in the window.
>    Every DM message to them is a candidate, their own included (for promises).
> 2. *@mentions anywhere.* `slack search messages "@<handle> after:<day>" --sort timestamp --limit 100 --json`;
>    keep hits whose text contains `<@<their id>>`.
> 3. *Their name written anywhere.* For each of `settings.names`:
>    `slack search messages "<name> after:<day>" --sort timestamp --limit 100 --json`.
> 4. *Their own messages* (to find promises and replies; never items in
>    themselves unless they promise something):
>    `slack search messages "from:@<handle> after:<day>" --sort timestamp --limit 100 --json`.
>
> A search that returns 100 hits may have more: run it again per day
> (`on:<YYYY-MM-DD>` instead of `after:`). No channel is read in full: only
> DMs, and other channels only through these searches and the threads of their
> hits.
>
> **C. Build each candidate's source** (a `SlackRef`):
>
> - `channel`: the C…/D…/G… id. From a search hit, take it from the permalink
>   (`/archives/<channel>/p<digits>`).
> - `ts`: the message's own ts. `threadTs`: the thread root's ts when the
>   message is a reply (a search permalink carries `thread_ts=`; history and
>   thread output carry `threadTs`), else `null`. A root's own ts is not a
>   threadTs.
> - `messageUrl`: the permalink to **this** message. A search hit has it
>   (`permalink`). Otherwise build it:
>   `https://<workspace>.slack.com/archives/<channel>/p<ts without the dot>`,
>   plus `?thread_ts=<threadTs>&cid=<channel>` for a reply (take `<workspace>`
>   from any search permalink).
> - `threadUrl`: the permalink to the thread's **root**:
>   `https://<workspace>.slack.com/archives/<channel>/p<threadTs without the dot>`;
>   `null` only when the message is itself the root. Always set both links
>   when the message is a reply.
> - `channelName`: `#<name>` for a channel, `DM`, or `group DM`.
> - `from`: `{ id, name }` — resolve each user id once
>   (`slack user info <id> --json`, the display or real name).
> - `text`: the exact message text. `sentAt`: the ts as an ISO time.
>
> When you need the thread around a message (to see whether they already
> answered, what was asked, whether a promise was kept), read it:
> `slack message thread <channel> <threadTs or ts> --json`. Reactions count as
> answers: their ✅ / 👍 on an ask means they answered it.
>
> **D. Classify each message** — one item per message, never merged:
>
> - **ask**: someone asks them to do, answer, review, decide or send something,
>   and they have not already done it (no reply or reaction from them after it).
> - **promise**: their own message committing to something ("I'll…", "will do",
>   "let me check", "on it", "I'll send it tomorrow"). The source is their message;
>   the title is what they promised, to whom.
> - **fyi**: addressed to them or about them, needs no action, but they should know
>   (a decision made, a heads-up, "<name>'s change broke X" with no ask).
> - **skip**: chit-chat, thanks, bots and automated notices, things already
>   answered, their own messages that promise nothing.
>
> `title`: one line, what is asked or promised ("Review Priya's PR #812 —
> grant export"). `why`: one line, why it is on the list and why that due time
> ("DM from Priya, +4 h"; "She needs it before the 3 pm demo"). `quick: true`
> for an ask that takes under ~5 minutes (a yes/no, a link, an approval).
> `unit`: the KAR-… id when the message or thread names a ticket or a board
> unit's PR, else leave it out. `links`: PRs, tickets, docs in the message,
> `{ label, url }`.
>
> **E. Due time** — set `dueRule`, and `dueAt` only where the rule needs it:
>
> | Case | dueRule | What you set |
> |---|---|---|
> | The message names a deadline ("by Friday 3 pm", "before the demo at 14:00") | `message` | `dueAt` = that time (ISO, local zone), `dueReason` = the words |
> | Their promise: "today", "EOD", "tonight" | `promise` | `promise: "eod"` (19:00 that working day) |
> | Their promise: "tomorrow" | `promise` | `promise: "tomorrow"` (next working day 12:00) |
> | Their promise with a time ("by 4 pm", "Monday morning") | `promise` | `promise: "<ISO time>"` |
> | Their promise with no time | `promise` | `promise: "none"` (+24 h) |
> | An ask in a DM or group DM | `dm` | nothing (+4 h) |
> | An ask by @mention or by name in a channel | `mention` | nothing (+24 h) |
> | fyi | `fyi` | nothing (+24 h, never past "warm") |
>
> Leave `dueAt` and `clockStart` out except for `message` (the CLI derives the
> rest, moves weekend clocks to Monday 09:00, and halves the window for
> senders on the half-time list).
>
> **F. Group and avoid repeats.** The key of a message is
> `slack:<channel>:<ts>`.
>
> - Key in `knownKeys` and the item is open: include it again only if
>   something changed (a better title, new links, evidence, now quick, now
>   linked to a unit). If it has `dueSetByYou: true`, leave `dueAt` and
>   `promise` out — their time stands. Key of an archived item: the
>   CLI skips it; don't bother.
> - New key: check its thread with
>   `ks-flow briefing find --thread <threadUrl, or messageUrl for a root>`.
>   An open item in the same thread: add yours as a **new** item (it joins the
>   same card through its `groupKey`); never fold it into the old one. Every
>   item there archived: add it — the CLI sets `linkedTo` to the newest
>   archived one.
>
> **G. Evidence.** When what you read suggests an open item is done (they
> replied with what was asked, the PR merged, they delivered a promise), add a
> hint — never more than that:
> `ks-flow briefing evidence <uid> --text "<what you saw, one line>" --url <messageUrl>`.
> Evidence never closes anything; only the user archives.
>
> **H. Write.** Put all items in one JSON array (use the Write tool; `echo
> $TMPDIR` gives a writable folder) at `<TMPDIR>/ks-master/<RUN>/items.json`.
> Each item:
>
> ```json
> {
>   "kind": "ask",
>   "title": "Review Priya's PR #812 — grant export",
>   "why": "DM from Priya, needs it before the 3 pm demo",
>   "source": {
>     "channel": "D0123ABC", "channelName": "DM", "ts": "1793390000.123456", "threadTs": null,
>     "messageUrl": "https://karmasuite.slack.com/archives/D0123ABC/p1793390000123456",
>     "threadUrl": null,
>     "from": { "id": "U0PRIYA", "name": "Priya" },
>     "text": "can you review #812 before the demo at 3?", "sentAt": "2026-10-31T09:13:20.000Z"
>   },
>   "dueRule": "message", "dueAt": "2026-10-31T15:00:00+05:30", "dueReason": "before the demo at 3",
>   "quick": false, "unit": "KAR-13413",
>   "links": [{ "label": "PR #812", "url": "https://github.com/karmasuite/karmasuite/pull/812" }],
>   "runId": "<RUN>", "createdBy": "master"
> }
> ```
>
> Leave out `uid`, `groupKey`, `status`, `dueHistory`, `pushedCount`,
> `notified` and timestamps (the CLI refuses them). Then:
> `ks-flow briefing add <TMPDIR>/ks-master/<RUN>/items.json --json`. Each result
> says `created`, `updated`, `unchanged` or `skipped: archived`. An input error
> names the item and field: fix the file and run `add` again (it is an upsert,
> so a rerun is safe).
>
> **I. Report back** — only this, no message text:
> `created N, updated N, unchanged N, skipped N, evidence N`; one summary line
> ("3 asks from Priya and Ravi, 1 promise to Sam, 2 FYIs"); up to five most
> urgent items as `title — from — dueAt`; and any error you could not fix.
