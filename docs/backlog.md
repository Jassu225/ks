# Backlog

Ideas agreed on but not scheduled. Newest first. Remove an entry when it ships
(the release notes record it then).

## ks-flow

- **Board tabs share one set of Firestore listeners.** Today every open board
  tab's live stream (`/api/store/live`) attaches its own listeners (about 11
  queries across the board, Briefing and Activity scopes). Firestore bills per
  listener, so:
  - a new tab or a reload reads every doc of every query again (several hundred
    reads: 200+ cards, sessions, reminders, 60 days of Briefing items, runs, events);
  - every change costs one read per open tab.

  Instead, the board server keeps one listener per query for the whole process
  (started by the first stream, stopped about 5 minutes after the last one
  closes) and fans each snapshot out to every stream:
  - a new tab or a reload is served from memory with 0 reads;
  - each change costs one read, however many tabs are open.

  Offline mode (the cached snapshot first) and the outbox overlay move from each
  stream onto the shared copy. The work is in `web/app/api/store/live/route.ts`
  plus a new hub module.
- **Messages between agents on the message board.** The board carries commands
  for each Mac's daemon only. It could also carry text for a session: the daemon
  would hand it over, and the ks mod would submit it as a turn when the session
  is idle, as the master gets its requests. That gives delivery receipts and
  history, which Remote Control messages lack, and needs no Remote Control. Wait
  and see whether Remote Control's gaps hurt first.

- **Remove `ks-flow inbox-check` once Plannotator reclaims its own Tailscale
  mappings after a reboot.** It is a stopgap: the restarted Inbox refuses
  to publish over its own leftover `tailscale serve` mapping (on its port, and
  on the 8443 link door).

## ks

- **Try `linear issue batch-update --state` on real tickets.** The single-ticket
  fix that keeps an issue's place in the manual order is verified (KAR-13002);
  the batch path, which puts back the place of each issue the new state moved,
  is not.
