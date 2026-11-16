# lib/peer-name.sh — the session (peer) name the KS launchers give Claude. Source
# it after lib/ks-config.sh and lib/ks-root.sh:
#   name="$(ks_peer_name "$(session-title.sh --print)")"
#
# The name is the one ListAgents prints and SendMessage takes. When two or more
# Macs share the ks-flow board and this one has a label, it is prefixed with the
# label so agents on different Macs can be told apart: `B:KAR-123`, or with no
# workflow unit `B:<git toplevel or cwd folder name>`. Otherwise it is the unit
# alone (KAR-123), or nothing outside a workflow checkout.
#
# The label comes from <ks-flow dataDir>/device.json ({ deviceId, defaultName,
# label, name, deviceCount }), which ks-flow's daemon writes. The data dir is
# KS_FLOW_DATA, else ks-flow's datadir.mjs for the KarmaSuite checkout (else the
# cwd): one node call at most. Silent and empty when ks-flow isn't there.

# This device's label, only while 2+ devices share the board; else nothing.
ks_device_label() {
  local dd="${KS_FLOW_DATA:-}" flow proj
  if [ -z "$dd" ]; then
    flow="$(ksr_live_root ks-flow 2>/dev/null)" || return 0
    [ -f "$flow/src/lib/datadir.mjs" ] || return 0
    if proj="$(ksc_project_root 2>/dev/null)" && [ -d "$proj" ]; then
      dd="$(node "$flow/src/lib/datadir.mjs" --project "$proj" 2>/dev/null)"
    else
      dd="$(node "$flow/src/lib/datadir.mjs" --cwd "$PWD" 2>/dev/null)"
    fi
  fi
  [ -n "$dd" ] && [ -f "$dd/device.json" ] || return 0
  jq -r 'select((.deviceCount // 0) >= 2) | .label // empty | strings | gsub("\\s"; "")' \
    "$dd/device.json" 2>/dev/null || true
}

# The peer name for this checkout: [<label>:]<unit>. $1 = the workflow unit's
# name (session-title.sh --print), or empty.
ks_peer_name() {
  local base="${1:-}" label
  label="$(ks_device_label)"
  if [ -n "$label" ]; then
    [ -n "$base" ] || base="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")"
    printf '%s:%s\n' "$label" "$base"
  elif [ -n "$base" ]; then
    printf '%s\n' "$base"
  fi
}
