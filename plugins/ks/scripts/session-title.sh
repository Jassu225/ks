#!/bin/bash

# SessionStart hook: name the session after the ks workflow unit that owns this
# checkout: the ticket id (KAR-123), or for a project its workflow folder name.
# The name is also the peer name ListAgents prints and SendMessage takes, so it
# is kept short and space-free; the statusline's ticket pill carries the ticket.
# Outside a workflow checkout it prints nothing and the name is left alone.
#
# `sessionTitle` only reaches the transcript. The live peer registry
# (~/.claude/sessions/<pid>.json) takes its name at startup, before this hook
# runs, so a new session keeps its derived <cwd>-<xx> name until resumed.
# claude-ks therefore also names the session at launch:
# `claude --name "$(session-title.sh --print)"`; --print writes the bare title.

[ "$1" = "--print" ] || cat > /dev/null # the hook's stdin is not needed

IFS=$'\t' read -r state_file kind identifier _ _ < <("$(dirname "$0")/workflow-unit" 2>/dev/null)
[ -n "$kind" ] || exit 0

if [ "$kind" = "ticket" ] && [ "$identifier" != "-" ]; then
  title="$identifier"
else
  title=$(basename "$(dirname "$state_file")")
fi

if [ "$1" = "--print" ]; then
  printf '%s\n' "$title"
  exit 0
fi

jq -n --arg title "$title" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    sessionTitle: $title
  }
}'
exit 0
