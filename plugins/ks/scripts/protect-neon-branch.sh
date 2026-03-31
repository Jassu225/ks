#!/bin/bash

# PreToolUse hook: blocks Neon MCP calls targeting a protected branch.
# The protected branch ID is the production/main branch that should not be
# modified directly via MCP tools.

INPUT=$(cat)

PROTECTED_BRANCH_ID="br-round-breeze-217777"

# Check branchId in the tool input
BRANCH_ID=$(echo "$INPUT" | jq -r '.tool_input.branchId // empty')

if [ "$BRANCH_ID" = "$PROTECTED_BRANCH_ID" ]; then
  jq -n --arg reason "Blocked: cannot operate on the protected main branch ($PROTECTED_BRANCH_ID). Use a dev branch instead." '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
fi

# Allow all other calls
exit 0
