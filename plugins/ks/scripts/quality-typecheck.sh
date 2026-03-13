#!/bin/bash

# Hook: Type-check changed TypeScript files
# Runs on Stop and SubagentStop events

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/quality-files.sh"

echo "=========================================="
echo "[TypeScript] Type checking $FILE_COUNT files"
echo "=========================================="

# Create temporary tsconfig in www directory that extends its config with only changed files
PROJECT_ROOT=$(git rev-parse --show-toplevel)
TEMP_TSCONFIG="$PROJECT_ROOT/apps/www/.tsconfig.quality-check.json"

# Convert paths to be relative to www directory
FILES_RELATIVE=$(echo "$ALL_FILES" | sed 's|^|../../|')
FILES_JSON=$(echo "$FILES_RELATIVE" | jq -R -s -c 'split("\n") | map(select(length > 0))')

cat > "$TEMP_TSCONFIG" << EOF
{
  "extends": "./tsconfig.json",
  "include": $FILES_JSON
}
EOF

TSC_OUTPUT=$(pnpm tsc --noEmit --project "$TEMP_TSCONFIG" 2>&1)
TSC_EXIT=$?
rm -f "$TEMP_TSCONFIG"

if [ $TSC_EXIT -ne 0 ]; then
  # Filter tsc output to only show errors from files we actually changed,
  # since tsc resolves imports transitively and may report errors in unrelated files
  FILTERED_OUTPUT=""
  while IFS= read -r line; do
    for file in $ALL_FILES; do
      if echo "$line" | grep -q "$file"; then
        FILTERED_OUTPUT="$FILTERED_OUTPUT$line"$'\n'
        break
      fi
    done
  done <<< "$TSC_OUTPUT"

  if [ -n "$FILTERED_OUTPUT" ]; then
    echo "" >&2
    echo "==========================================" >&2
    echo "[TypeScript] Type errors found:" >&2
    echo "==========================================" >&2
    echo "$FILTERED_OUTPUT" >&2
    exit 2
  fi
fi

exit 0
