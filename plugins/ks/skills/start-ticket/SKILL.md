---
name: start-ticket
description: Start work on a Linear ticket — fetch it, write its workflow state.yaml, create (or reuse) its git worktree, and open a Claude session there that runs /ks:project-manager. Use when asked to start, pick up or open a ticket (a Linear URL or KAR-123), or runs /ks:start-ticket.
argument-hint: <linear issue URL>
---

# Start a ticket

1. Prepare the ticket and its worktree without launching:

   ```bash
   ks-start-ticket <linear issue URL> --no-launch
   ```

   Run it from the KarmaSuite main checkout (`ks-config get ks.KS_PROJECT_ROOT_PATH`).
   It fetches the ticket, writes `workflow/<user>/tickets/<id>/state.yaml`,
   creates or reuses the worktree, and ends with two lines:
   `KS_WORKTREE=<path>` and `KS_PROMPT=<prompt>`. A backup restore it can't ask
   about without a terminal is skipped; mention `ks-flow restore --unit <id>`.

2. Open the session there:
   - tmux running: `claude-ks-rc <KS_WORKTREE> --prompt "<KS_PROMPT>"` — a new
     tmux window with Remote Control, named after the ticket.
   - otherwise give the user the command:
     `cd <KS_WORKTREE> && claude -n <ticket id> "<KS_PROMPT>"`
     (or open that folder in the Claude desktop app and send the prompt).

3. Report the worktree path, the branch and where the session runs.
