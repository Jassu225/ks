#!/bin/bash

# SessionStart hook: name the session after the ks workflow unit that owns this
# checkout: the ticket id (KAR-123), or for a project its workflow folder name.
# `sessionTitle` sets the session's name, which is also the peer name ListAgents
# prints and SendMessage takes, so it is kept short and space-free; the
# statusline's ticket pill carries the title. Outside a workflow checkout it
# prints nothing and the name is left alone.

cat > /dev/null # the hook's stdin is not needed

IFS=$'\t' read -r state_file kind identifier _ _ < <("$(dirname "$0")/workflow-unit" 2>/dev/null)
[ -n "$kind" ] || exit 0

if [ "$kind" = "ticket" ] && [ "$identifier" != "-" ]; then
  title="$identifier"
else
  title=$(basename "$(dirname "$state_file")")
fi

jq -n --arg title "$title" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    sessionTitle: $title
  }
}'
exit 0
