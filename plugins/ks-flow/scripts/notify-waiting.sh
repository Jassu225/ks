#!/bin/bash
# PreToolUse[AskUserQuestion|ExitPlanMode] — a session is about to block on you.
# Purely observational: never emits a permissionDecision. Exit 0 always.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "$DIR/_common.sh"

read_payload
init_data_dir "$HOOK_CWD"                 # derive DATA_DIR from the cwd's repo
require_in_project "$HOOK_CWD"            # exits 0 if out-of-project
[ -n "$HOOK_SID" ] || exit 0

# Record the event for the daemon (kind = tool name; daemon ignores these for
# state since the JSONL tool_use already governs the wait — they carry no id).
append_event "$HOOK_SID" "${HOOK_TOOL:-AskUserQuestion}" "$HOOK_SID-$(date +%s)" "$HOOK_CWD"

if ! throttled "$HOOK_SID"; then
  case "$HOOK_TOOL" in
    ExitPlanMode) notify "$HOOK_SID" "${HOOK_BRANCH:-plan ready}" "Plan ready for your review" ;;
    *) notify "$HOOK_SID" "${HOOK_BRANCH:-waiting}" "Claude is asking you a question" ;;
  esac
fi
exit 0
