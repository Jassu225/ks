#!/bin/bash
# worktree-create.sh — the ks plugin's WorktreeCreate hook. Claude Code runs it
# instead of its own `git worktree add` for `claude -w <name>`, EnterWorktree and
# agent worktrees; stdout must be the worktree folder, which becomes the
# session's folder. Input (stdin JSON): {session_id, transcript_path, cwd,
# hook_event_name, name}.
#
#   a ticket name (KAR-123…) in the KarmaSuite checkout (KS_PROJECT_ROOT_PATH):
#       the ticket's existing worktree if there is one, else `create-worktree`
#       (karmasuite-worktree/<name>, env files and settings copied, the
#       worktree's own task list)
#   anything else: Claude's default — .claude/worktrees/<name> on a new branch
#       worktree-<name> from the default branch — plus a copy of
#       .claude/settings.local.json (a worktree session reads its own project
#       config, not the main checkout's)
set -uo pipefail
SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INPUT="$(cat)"
NAME="$(jq -r '.name // empty' <<<"$INPUT")"
CWD="$(jq -r '.cwd // empty' <<<"$INPUT")"
[ -n "$NAME" ] || { echo "worktree-create: no name in the hook input" >&2; exit 1; }
[ -d "$CWD" ] || CWD="$PWD"

MAIN="$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null)" || { echo "worktree-create: $CWD is not a git repo" >&2; exit 1; }
common() { (cd "$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P); }

. "$SCRIPTS/lib/ks-config.sh"
PROJECT="$(ksc_project_root 2>/dev/null || true)"
if [ -n "$PROJECT" ] && [[ "$NAME" =~ ^[A-Za-z]+-[0-9]+ ]] && [ "$(common "$MAIN")" = "$(common "$PROJECT")" ]; then
  # The worktree ks-start-ticket made for this ticket, if any (folder name starts
  # with the lower-cased ticket id).
  prefix="$(printf '%s' "${BASH_REMATCH[0]}" | tr '[:upper:]' '[:lower:]')"
  existing="$(git -C "$MAIN" worktree list --porcelain | awk '/^worktree /{print substr($0,10)}' \
    | while read -r w; do b="$(basename "$w" | tr '[:upper:]' '[:lower:]')"; case "$b" in "$prefix"|"$prefix"-*) echo "$w"; break ;; esac; done)"
  if [ -n "$existing" ] && [ -d "$existing" ]; then echo "$existing"; exit 0; fi
  out="$(cd "$MAIN" && "$SCRIPTS/create-worktree" "$NAME" 2>&2)" || exit 1
  path="$(printf '%s\n' "$out" | sed -n 's/^WORKTREE_PATH=//p' | tail -1)"
  [ -n "$path" ] && [ -d "$path" ] || { echo "worktree-create: create-worktree gave no path" >&2; exit 1; }
  echo "$path"
  exit 0
fi

# Claude's default layout.
safe="${NAME//\//-}"
path="$MAIN/.claude/worktrees/$safe"
if [ ! -d "$path" ]; then
  base="$(git -C "$MAIN" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || git -C "$MAIN" rev-parse --abbrev-ref HEAD)"
  git -C "$MAIN" worktree add "$path" -b "worktree-$safe" "$base" >&2 || exit 1
  if [ -f "$MAIN/.claude/settings.local.json" ]; then
    mkdir -p "$path/.claude" && cp "$MAIN/.claude/settings.local.json" "$path/.claude/settings.local.json"
  fi
fi
echo "$path"
