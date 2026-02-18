#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CSCRIPTS_DIR="$SCRIPT_DIR/c-scripts"

echo "=== Installing dependencies ==="
cd "$CSCRIPTS_DIR"
npm install

echo ""
echo "=== Building CLI tools ==="
npm run build

echo ""
echo "=== Configuring shell ==="
ZSHRC="$HOME/.zshrc"

# Add claude-ks alias
ALIAS_LINE="alias claude-ks='claude --plugin-dir $SCRIPT_DIR'"
if grep -qF "alias claude-ks=" "$ZSHRC" 2>/dev/null; then
  echo "claude-ks alias already exists in $ZSHRC, skipping"
else
  echo "" >> "$ZSHRC"
  echo "# KarmaSuite Claude Code plugin" >> "$ZSHRC"
  echo "$ALIAS_LINE" >> "$ZSHRC"
  echo "Added claude-ks alias to $ZSHRC"
fi

# Add c-scripts to PATH
PATH_LINE="export PATH=\"$CSCRIPTS_DIR:\$PATH\""
if grep -qF "$CSCRIPTS_DIR" "$ZSHRC" 2>/dev/null; then
  echo "c-scripts PATH already exists in $ZSHRC, skipping"
else
  echo "$PATH_LINE" >> "$ZSHRC"
  echo "Added c-scripts to PATH in $ZSHRC"
fi

echo ""
echo "=== Done ==="
echo "Run 'source ~/.zshrc' to apply changes."
echo ""
echo "Next steps:"
echo "  1. Get a Linear API key (with write permissions) from:"
echo "     https://linear.app/settings/api"
echo "     Then add it to $CSCRIPTS_DIR/.env:"
echo "     LINEAR_API_KEY=lin_api_your_key_here"
echo ""
echo "  2. Copy ks-rules.md to your KarmaSuite project:"
echo "     cp $SCRIPT_DIR/ks-rules.md /path/to/your/project/CLAUDE.md"
