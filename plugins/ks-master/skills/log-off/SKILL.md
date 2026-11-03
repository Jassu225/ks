---
name: log-off
description: End the user's working day - a last Briefing pass, what was archived, what is still open and what slipped, promises due tomorrow, a roll call of their Claude sessions with a suggestion for each, engaged time from ks-time, a walk through the open items (archive or keep), the day's log saved, then a graceful restart of the master. Use when they say log off, wrap up, end my day, or runs /ks-master:log-off.
argument-hint: (no arguments)
---

# Log off

The end of the day: nothing owed gets lost overnight. You report, they decide;
you never archive and never change a due time — they do both on the board.

## 1. Last pass

Run the Briefing pass with the `log-off` trigger: follow `/ks-master:briefing`
with arguments `log-off`. Keep its counts.

## 2. Gather

```bash
ks-flow briefing context
```

```bash
ks-flow briefing daily get
```

(today's log: the log-in plan, if they logged in) and

```bash
ks-time --all --json
```

`ks-time` prints, per unit, `engagedMs`, `agentMs`, `lastAt` and `byDay`
(`{ "YYYY-MM-DD": { engagedMs, agentMs } }`). Today's figures are each unit's
`byDay[<today>]`; the day's total is their sum (time on two units at once
counts twice — say so if it matters).

Stages: as in `/ks-master:log-in` (`overdue` when now ≥ dueAt, `hot` at 80 % of
the window, `warm` at 50 %, fyi never past warm).

## 3. Report

One line per entry, nothing empty shown:

1. **Archived today** — `archivedRecent` with `archivedAt` today: title —
   resolution (done / not mine / won't do).
2. **Still open** — counts by stage, then the overdue and hot ones by title.
3. **Slipped** — items that went overdue today, and items whose due time they
   moved later today (`dueHistory` entries `by: "you"` today, `pushedCount`).
   No blame; just the list.
4. **Promises due tomorrow** — kind `promise`, `dueAt` tomorrow — to whom.
5. **Plan vs day** — if the log-in plan exists: which steps are done (their
   items archived, their units moved on) and which are not.
6. **Sessions** — the roll call (same units as log-in: live sessions, waiting,
   Inbox, Done with a worktree left). Per unit:
   `KAR-… — phase — state — last did — suggestion`.
   - *last did*: one line from the unit's newest handoff (`ks-flow session
     <unit> --json` gives its `workflowDir`; the handoffs are in
     `<workflowDir>/resources/handoffs/`, read the newest one's "What Happened"),
     else its current phase.
   - *suggestion*: one of the board's four, with a few words of why when it
     helps:
     - `leave running` — working on its own, nothing needed from them;
     - `answer first` — it waits on them (a tool prompt, an Inbox question);
     - `close or plan` — idle or finished for now: close it, or give it
       tomorrow's task;
     - `remove worktree` — the ticket is Done / the PR merged: remove the
       worktree on the board.
     Free text only when none of these fits (e.g. "context heavy: restart it
     with a handoff").
7. **Time** — today engaged / agent, total and per unit, largest first.

## 4. Walk the open items

Go through the open items with them, worst stage first (overdue, hot, today,
later); the FYIs as one group at the end. Show them numbered, a few at a time,
and ask for each: **archive or keep?**

- *Archive*: tell them to archive it on the board (Briefing page → the card →
  Archive, with Done / Not mine / Won't do). You never archive.
- *Keep*: nothing to do. If they want a different due time, they set it on the
  board (Change due); never set it for them.

Record their answers for the log. Stop walking when they say so.

## 5. Save the day's log

Write the JSON with the Write tool (`echo $TMPDIR` for a folder), then:

```bash
ks-flow briefing daily set <YYYY-MM-DD, today local> --part log-off <file>
```

The board's Daily log page reads this file; keep exactly these names:

```json
{
  "at": "<now, ISO>",
  "summary": ["4 archived, 6 open (1 overdue)", "2 promises due tomorrow", "5 h 10 m engaged"],
  "engagedMinutes": 310,
  "time": [{ "unit": "KAR-13413", "minutes": 190 }, { "unit": "KAR-13420", "minutes": 120 }],
  "lastPass": { "added": 2, "updated": 0 },
  "archived": [{ "uid": "…", "title": "…", "resolution": "done" }],
  "open": { "overdue": 1, "hot": 1, "warm": 2, "calm": 2 },
  "slipped": [{ "uid": "…", "title": "…", "why": "went overdue 16:00" }],
  "promisesTomorrow": [{ "uid": "…", "title": "…", "to": "Sam" }],
  "planDone": ["…"],
  "planOpen": ["…"],
  "walk": [{ "uid": "…", "answer": "keep" }],
  "sessions": [
    { "unit": "KAR-13413", "sessionId": "58992b31-…", "phase": "10 Implement", "state": "idle", "lastDid": "Fixed the ENA filter; PR #812 open", "suggestion": "close or plan" }
  ]
}
```

- `summary`: the report's headline, one string per line (three to five).
- `engagedMinutes`: today's engaged time from `ks-time`, in whole minutes
  (the sum of each unit's `byDay[<today>].engagedMs` / 60 000, rounded).
- `time`: per unit, today's engaged minutes, `{ unit, minutes }`, largest
  first; leave out units with 0. `ks-time` logs only workflow units (tickets
  and projects), so there is no `master` or `other` row unless it reports one
  under that name.
- `sessions`: the roll call; it replaces the log-in roll call for the day.
  `unit` and `state` are never empty; `sessionId` and `phase` are a string or
  `null` (never `""` — the CLI rejects an empty string); `lastDid` may be `""`;
  `suggestion` as in step 3, or the key left out.

## 6. Restart

Say good night in one line, then restart gracefully: follow
`/ks-master:restart` with arguments `log-off`. The new master starts fresh for
tomorrow.
