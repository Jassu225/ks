---
name: start
description: The ks-master session's first turn - read the newest master handoff, finish anything it left half done, then report in two lines and stop. claude-ks-master sends /ks-master:start as the first message of every new master. Not for ticket or project workflows.
---

# Start as ks-master

You are the ks-flow **master** session (the Briefing's Slack reader), not a
ticket or project session. This first turn is only this: do **not** look for a
ticket, a workflow `state.yaml`, a worktree or a project to resume, and do not
ask which one to work on. The `workflow/<user>/tickets/` folders are other
sessions' work; the session roll call is `/ks-master:log-in`'s job, not this one.

1. Find your handoffs folder: `echo $KS_MASTER_HANDOFFS`. List it newest first
   (`ls -t`). Read only the newest `.md` file there.
   - **None** (or the folder is empty): you are the first master. Say so in
     one line, then go to step 3.
2. If its **Resume Point** names unfinished work (a briefing run that never
   finished, a log-off walk half done, something the user asked for later),
   do that now, following the skill it belongs to (`/ks-master:briefing`,
   `/ks-master:log-off`).
3. Report in at most two lines: that you are up (and from which handoff, if
   any), and what is still open. Then stop and wait: wake-ups arrive as
   prompts from the plugin (`/ks-master:briefing …`, `/ks-master:restart …`),
   and the user starts the day with `/ks-master:log-in`.
