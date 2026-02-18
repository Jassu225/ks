#!/bin/bash

# Shared helper: detects changed TypeScript/TSX files.
# Source this script to get $ALL_FILES and $FILE_COUNT.
# Exits the parent script (exit 0) if no files found.

# Exit early if not in a git repository
if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  exit 0
fi

# Get staged TypeScript files
STAGED_FILES=$(git diff --cached --name-only 2>/dev/null | grep -E '\.(ts|tsx)$' || true)

# Get unstaged modified TypeScript files
UNSTAGED_FILES=$(git diff --name-only 2>/dev/null | grep -E '\.(ts|tsx)$' || true)

# Get untracked TypeScript files
UNTRACKED_FILES=$(git ls-files --others --exclude-standard 2>/dev/null | grep -E '\.(ts|tsx)$' || true)

# Get files changed on this branch vs main (catches already-committed files)
DEFAULT_BRANCH="main"
BRANCH_FILES=$(git diff --name-only "$DEFAULT_BRANCH"...HEAD 2>/dev/null | grep -E '\.(ts|tsx)$' || true)

# Combine, deduplicate, and filter to only existing files
ALL_FILES=""
for file in $STAGED_FILES $UNSTAGED_FILES $UNTRACKED_FILES $BRANCH_FILES; do
  if [ -f "$file" ]; then
    ALL_FILES="$ALL_FILES$file"$'\n'
  fi
done
ALL_FILES=$(echo "$ALL_FILES" | sort -u | sed '/^$/d')

# Exit early if no files to process
if [ -z "$ALL_FILES" ]; then
  exit 0
fi

FILE_COUNT=$(echo "$ALL_FILES" | wc -l | tr -d ' ')
if [ "$FILE_COUNT" -eq 0 ]; then
  exit 0
fi
