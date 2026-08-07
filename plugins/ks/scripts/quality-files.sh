#!/bin/bash

# Shared helper: detects changed TypeScript/TSX files.
# Source this script to get $ALL_FILES and $FILE_COUNT.
# Exits the parent script (exit 0) if no files found.

# Exit early if not in a git repository
if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  exit 0
fi

# Ensure all git commands run from repo root so paths are consistent
_QF_ORIG_DIR="$PWD"
cd "$(git rev-parse --show-toplevel)" || exit 0

# Get staged TypeScript files
STAGED_FILES=$(git diff --cached --name-only 2>/dev/null | grep -E '\.(ts|tsx)$' || true)

# Get unstaged modified TypeScript files
UNSTAGED_FILES=$(git diff --name-only 2>/dev/null | grep -E '\.(ts|tsx)$' || true)

# Get untracked TypeScript files
UNTRACKED_FILES=$(git ls-files --others --exclude-standard 2>/dev/null | grep -E '\.(ts|tsx)$' || true)

# Get files changed on this branch vs main (catches already-committed files)
DEFAULT_BRANCH="main"
BRANCH_FILES=$(git diff --name-only "$DEFAULT_BRANCH"...HEAD 2>/dev/null | grep -E '\.(ts|tsx)$' || true)

# Restore original directory
cd "$_QF_ORIG_DIR"

# Combine, deduplicate, and filter to only existing files
ALL_FILES=""
for file in $STAGED_FILES $UNSTAGED_FILES $UNTRACKED_FILES $BRANCH_FILES; do
  if [ -f "$file" ]; then
    ALL_FILES="$ALL_FILES$file"$'\n'
  fi
done
ALL_FILES=$(echo "$ALL_FILES" | sort -u | sed '/^$/d')

# Drop files listed in an optional per-repo `.quality-ignore`, so a file that is
# already broken on main doesn't fail the hook for whoever happens to touch it
# next (a one-line comment edit is enough to pull it into the changed set). One
# pattern per line, matched against the repo-relative path; `#` comments and
# blank lines are ignored. Keep the list SHORT and justified — this suppresses
# real errors, it does not fix them.
QUALITY_IGNORE="$(git rev-parse --show-toplevel)/.quality-ignore"
if [ -f "$QUALITY_IGNORE" ]; then
  IGNORE_PATTERNS=$(grep -vE '^\s*(#|$)' "$QUALITY_IGNORE" || true)
  if [ -n "$IGNORE_PATTERNS" ]; then
    ALL_FILES=$(echo "$ALL_FILES" | grep -vFf <(echo "$IGNORE_PATTERNS") || true)
  fi
fi

# Exit early if no files to process
if [ -z "$ALL_FILES" ]; then
  exit 0
fi

FILE_COUNT=$(echo "$ALL_FILES" | wc -l | tr -d ' ')
if [ "$FILE_COUNT" -eq 0 ]; then
  exit 0
fi
