#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# KS_PROJECT_ROOT_PATH: env, then ~/.config/ks/ks.env, then the legacy .config
. "$SCRIPT_DIR/lib/ks-config.sh"
PROJECT_ROOT="$(ksc_project_root || true)"
if [ -z "$PROJECT_ROOT" ]; then
  echo "Error: KS_PROJECT_ROOT_PATH is not set."
  echo "Set it with: ks-config set ks.KS_PROJECT_ROOT_PATH <path>   (or run /ks:setup)"
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
