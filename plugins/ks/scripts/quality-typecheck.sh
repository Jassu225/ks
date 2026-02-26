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

pnpm tsc --noEmit --project "$TEMP_TSCONFIG" 2>&1 || true
rm -f "$TEMP_TSCONFIG"

exit 0
