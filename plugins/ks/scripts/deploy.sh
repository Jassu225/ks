#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="$PLUGIN_ROOT/.config"

# Read KS_PROJECT_ROOT_PATH from .config
if [ ! -f "$CONFIG_FILE" ]; then
  echo "Error: .config file not found at $CONFIG_FILE"
  echo "Run ./init to configure the project root path."
  exit 1
fi

PROJECT_ROOT=$(grep "^KS_PROJECT_ROOT_PATH=" "$CONFIG_FILE" | cut -d'=' -f2-)
# Fallback to legacy PROJECT_ROOT_PATH if KS_ prefix not found
[ -z "$PROJECT_ROOT" ] && PROJECT_ROOT=$(grep "^PROJECT_ROOT_PATH=" "$CONFIG_FILE" | cut -d'=' -f2-)
if [ -z "$PROJECT_ROOT" ]; then
  echo "Error: KS_PROJECT_ROOT_PATH not set in $CONFIG_FILE"
  echo "Run ./init to configure the project root path."
  exit 1
fi

if [ ! -d "$PROJECT_ROOT" ]; then
  echo "Error: Project root directory does not exist: $PROJECT_ROOT"
  exit 1
fi

cd "$PROJECT_ROOT"

# Ensure we're on live
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "live" ]; then
  echo "Switching to live branch..."
  git checkout live
fi

# Pull main into live
echo "Pulling main into live..."
git pull origin main

# Push live to remote
echo "Pushing live to remote..."
git push

# Switch back to main
git checkout main --quiet
