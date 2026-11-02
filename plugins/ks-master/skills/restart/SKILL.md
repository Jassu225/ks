---
name: restart
description: Gracefully restart the ks-master session - write a handoff into the master handoffs folder, record it, and replace this session with a fresh master in the same tmux pane (claude-ks-rc-restart --master). Use when context is past ~70%, after log-off, or when a restart is requested from the board. Arguments - why (context N%, log-off, requested from the board).
argument-hint: <reason>
---

# Restart the master

You hand off and get replaced by a fresh master in the same tmux pane. Reason:
`$ARGUMENTS`.

## 1. Finish or close what is running

- A Briefing run you started and have not finished (`run start` without `run
  finish`): finish it now — with its counts if the reader reported, else
  `ks-flow briefing run finish <run> --added 0 --updated 0 --failed "restart"`
  so the next pass reads the window again.
- Anything you were in the middle of with Jaswanth (a log-off walk, a
  question): note it for the handoff; don't start new work.

## 2. Write the handoff

Write it into the master handoffs folder (`$KS_MASTER_HANDOFFS`, run
`echo $KS_MASTER_HANDOFFS`) as
`YYYY-MM-DD_HH-MM-SS_<kebab-description>.md` (local time, 24-hour), using the
`/ks:create_handoff` template's sections, but save it **here**, not under a
`resources/handoffs/` folder. Capture only what is not in the store already
(items, runs, cursor and daily logs live in ks-flow; don't copy them):

- **What Happened**: since the last handoff, in 1–3 sentences.
- **Open with Jaswanth**: questions you asked him and are waiting on, things he
  asked you to do later, a log-off walk not finished (which item you were on).
- **Decisions he made** that change how you brief (a sender to treat as
  half-time, a channel or person to ignore, a wording he wants).
- **Resume Point**: the exact next action, or "Nothing open: wait for the next
  wake-up."

## 3. Restart

```bash
claude-ks-rc-restart --master --handoff <absolute path of the handoff>
```

It records the handoff in `session.json`, then ends this session in about two
seconds and starts a new master in this tmux pane. Its first message is
`/ks-master:start`, which reads your handoff first. Say one line
("Restarting: handoff <file>") and stop; do nothing after the command.

If the command fails (it prints why — for example, it can't run `ps` because
it was not the first word of the command), fix the call and run it again. Never
use `--force` yourself: that is the daemon's hard restart for a stuck master.
