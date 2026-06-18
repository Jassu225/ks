#!/bin/bash
# PermissionRequest — a session is blocked on a permission prompt (not visible
# in the transcript, so the daemon learns of it only via this event line).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "$DIR/_common.sh"

read_payload
init_data_dir "$HOOK_CWD"
require_in_project "$HOOK_CWD"
[ -n "$HOOK_SID" ] || exit 0

append_event "$HOOK_SID" "PermissionRequest" "$HOOK_SID-perm-$(date +%s)" "$HOOK_CWD"

if ! throttled "$HOOK_SID"; then
  build_notify_fields "$HOOK_CWD" "$HOOK_BRANCH"   # → NOTIFY_LABEL / NOTIFY_DETAIL
  notify "$HOOK_SID" "Claude needs permission to continue" "$NOTIFY_DETAIL" "$NOTIFY_LABEL"
fi
exit 0
