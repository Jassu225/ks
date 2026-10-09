#!/bin/bash

# Hook: append one line to the ks workflow unit's time log for every event that
# marks Claude starting, finishing or waiting, so `ks-time` can work out the
# active time spent on each ticket.
#
#   ~/.claude/ks-time/<identifier>.jsonl
#   {"ts":1791460300518,"event":"Stop","session":"…","phase":"9"}
#
# Wired in hooks.json to SessionStart, UserPromptSubmit, PostToolUse,
# Notification, SubagentStart, SubagentStop, Stop and SessionEnd. Only events
# are recorded; turning them into time (idle cut-off, overlaps) is ks-time's
# job, so the rules can change and recount the past.
#
# The identifier is the one ks-flow keys its backups on (the unit's
# identifier, else its workflow folder name), so its sweep can upload the log
# beside the unit's transcripts. A session outside any ks workflow is not logged.
#
# On Stop and SessionEnd it also runs `ks-time --write` in the background,
# which keeps the unit's state.yaml figures current.
#
# Never fails the event: every path exits 0.

input=$(cat)
scripts=$(cd "$(dirname "$0")" && pwd)
dir="${KS_TIME_DIR:-$HOME/.claude/ks-time}"
cache="$dir/.sessions"
mkdir -p "$cache" 2>/dev/null || exit 0

session=$(jq -r '.session_id // empty' <<<"$input" 2>/dev/null)
event=$(jq -r '.hook_event_name // empty' <<<"$input" 2>/dev/null)
cwd=$(jq -r '.cwd // empty' <<<"$input" 2>/dev/null)
[ -n "$session" ] && [ -n "$event" ] || exit 0
# A session id is a uuid; keep anything else out of the cache path.
[[ "$session" =~ ^[A-Za-z0-9_-]+$ ]] || exit 0

# Which unit (and phase) the session is working on. Looking it up greps the
# checkout's workflow/ tree, too slow for every tool call, so it runs when a
# session starts or a prompt is sent and is cached per session in between.
lookup() {
    local unit_line state_file id phase
    unit_line=$(cd "${cwd:-.}" 2>/dev/null && "$scripts/workflow-unit" 2>/dev/null) || return 1
    state_file=$(cut -f1 <<<"$unit_line")
    id=$(cut -f3 <<<"$unit_line")
    # A unit without an identifier (a project) goes by its workflow folder, as in ks-flow.
    [ "$id" = "-" ] && id=$(basename "$(dirname "$state_file")")
    # The phase being worked: the first IN_PROGRESS or REVISITING one under phases:.
    phase=$(awk '
        /^phases:/ { p = 1; next }
        /^[^ #-]/ { p = 0 }
        p && /- number:/ { n = $0; gsub(/[^0-9]/, "", n) }
        p && /^ +status:/ && /IN_PROGRESS|REVISITING/ { print n; exit }
    ' "$state_file")
    printf '%s\t%s\n' "$id" "$phase"
}

case "$event" in
    SessionStart | UserPromptSubmit)
        if found=$(lookup); then
            printf '%s\n' "$found" >"$cache/$session"
        else
            rm -f "$cache/$session"
        fi
        ;;
esac

[ -f "$cache/$session" ] || exit 0
IFS=$'\t' read -r id phase <"$cache/$session"
[ -n "$id" ] || exit 0
# Object-name safe, the rule ks-flow's safeId() applies.
file="$dir/$(sed 's/[^A-Za-z0-9._-]/_/g' <<<"$id").jsonl"

# One compact line; jq stamps the time (ms) as the line is written.
jq -c --arg phase "$phase" '{
    ts: (now * 1000 | floor),
    event: .hook_event_name,
    session: .session_id,
    agent: (.agent_id // null),
    agentType: (.agent_type // null),
    kind: (.notification_type // .source // .reason // null),
    phase: (if $phase == "" then null else $phase end)
} | with_entries(select(.value != null))' <<<"$input" >>"$file" 2>/dev/null

# A turn or session just ended: bring the unit's state.yaml figures up to date
# (phases[].engaged_minutes, time_spent). In the background, so the event never
# waits on node; ks-time writes only when a figure changed.
case "$event" in
    Stop | SessionEnd) (cd "${cwd:-.}" 2>/dev/null && "$scripts/ks-time" --write >/dev/null 2>&1 &) ;;
esac

[ "$event" = "SessionEnd" ] && rm -f "$cache/$session"
exit 0
