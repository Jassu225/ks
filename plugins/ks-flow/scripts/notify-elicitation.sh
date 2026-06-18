#!/bin/bash
# Elicitation — an MCP server is asking the user for input; the session blocks.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "$DIR/_common.sh"

read_payload
init_data_dir "$HOOK_CWD"
require_in_project "$HOOK_CWD"
[ -n "$HOOK_SID" ] || exit 0

append_event "$HOOK_SID" "Elicitation" "$HOOK_SID-elic-$(date +%s)" "$HOOK_CWD"

if ! throttled "$HOOK_SID"; then
  build_notify_fields "$HOOK_CWD" "$HOOK_BRANCH"   # → NOTIFY_TITLE / NOTIFY_SUBTITLE
  notify "$HOOK_SID" "$NOTIFY_SUBTITLE" "Claude needs input to continue" "$NOTIFY_TITLE"
fi
exit 0
