#!/bin/bash

# Stop/SubagentStop hook: suggests running code-simplifier agent if there are changed TS/TSX files.
# Uses "block" decision to resume the agent so it can act on the suggestion.
# On second pass (stop_hook_active=true), exits 0 to allow the agent to stop.

# Prevent recursive invocation: if the hook already triggered a continuation, allow stop.
INPUT=$(cat)
if [ "$(echo "$INPUT" | jq -r '.stop_hook_active // false')" = "true" ]; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/quality-files.sh"

# If we get here, quality-files.sh found changed TS/TSX files (it exits early if none)
REASON="There are $FILE_COUNT changed TypeScript/TSX files. Consider running the ks:code-simplifier agent to refine the changes for clarity, consistency, and maintainability. Use your judgement — skip if the changes are trivial (e.g., config, imports-only, or auto-generated code)."

jq -n --arg reason "$REASON" '{
  decision: "block",
  reason: $reason
}'
exit 0
