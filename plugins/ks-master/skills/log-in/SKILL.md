---
name: log-in
description: Start Jaswanth's working day - a catch-up Briefing pass, then what is overdue, hot and promised for today, a roll call of his Claude sessions from the ks-flow board, and one ordered plan for the day, saved to the day's log. Use when he says log in, good morning, start my day, or runs /ks-master:log-in.
argument-hint: (no arguments)
---

# Log in

The start of the day: catch up on Slack, show what is owed, see where every
session stands, and agree one ordered plan. Short, scannable output: he reads
it on his phone too.

## 1. Catch up

Run the Briefing pass with the `log-in` trigger: follow `/ks-master:briefing`
with arguments `log-in`. It returns counts and the most urgent lines; keep them.

## 2. Read the board

```bash
ks-flow briefing context
```

From it, work out each open item's **stage** (the board's rule):
`elapsed = (now − clockStart) / (dueAt − clockStart)`; `overdue` when
`now ≥ dueAt`, `hot` at ≥ 0.8, `warm` at ≥ 0.5, else `calm`; an `fyi` item never
goes past `warm`. Items with the same `groupKey` are one card: the card takes
its worst stage.

## 3. Report

In this order, one line per entry, nothing empty shown:

1. **Catch-up**: `Slack since <cursor time>: N new, M updated`.
2. **Overdue** — title — who — how late (`2 h late`) — link.
3. **Hot** — title — who — due time.
4. **Promises due today** (kind `promise`, `dueAt` today) — to whom.
5. **Quick replies** (`quick: true`, not already listed): one batch, "≈ N min".
6. **Sessions** — the roll call: every `board.units` entry that has live
   sessions, is waiting (`waiting`), or has Inbox questions (`inbox.open > 0`),
   plus Done units whose worktree is still on disk. Per unit:
   `KAR-… title — phase — Linear status — state`, where state is one of
   `waiting on you (<tool>)`, `Inbox: N questions`, `running`, `idle`, `no
   session`, `done — worktree left`. Add the PR link when there is one.
7. **Plan for today** — one numbered list, in this order: overdue items;
   sessions blocked on him (waiting / Inbox); hot items; the quick-replies batch
   as one step; promises due today; today's other items; then the units to
   push forward, the one closest to done first. Mark FYIs as "read when free"
   at the end, as a count.

Ask whether he wants to change the order. Change it only as he says.

## 4. Save the day's log

Write the report as JSON with the Write tool (`echo $TMPDIR` for a folder),
then save it:

```bash
ks-flow briefing daily set <YYYY-MM-DD, today local> --part log-in <file>
```

The board's Daily log page reads this file; keep exactly these names:

```json
{
  "at": "<now, ISO>",
  "plan": ["Reply to Priya on PR #812 (overdue 2 h)", "Unblock KAR-13413: it waits on Bash", "…"],
  "catchUp": { "added": 3, "updated": 1 },
  "counts": { "overdue": 1, "hot": 2, "promisesToday": 1, "quick": 3, "today": 4, "fyi": 2 },
  "sessions": [
    { "unit": "KAR-13413", "sessionId": "58992b31-…", "phase": "10 Implement", "state": "waiting on you (Bash)", "lastDid": "", "suggestion": "answer first" }
  ]
}
```

- `plan`: the ordered plan, one string per step (the final order, if he
  changed it).
- `sessions`: the roll call, one entry per unit. `unit` and `state` are never
  empty; `sessionId` and `phase` are a string or `null` (never `""` — the CLI
  rejects an empty string); `lastDid` may be `""` (it is filled at log-off).
  `suggestion` is one of `leave running`, `answer first`, `close or plan`,
  `remove worktree` (free text when none fits); leave the key out when there
  is nothing to suggest.

Never archive anything and never change a due time here; if he says an item is
done, tell him to archive it on the board.
