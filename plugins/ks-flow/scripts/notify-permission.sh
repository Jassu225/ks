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
  notify "$HOOK_SID" "${HOOK_BRANCH:-permission}" "Claude needs permission to continue"
fi
exit 0
