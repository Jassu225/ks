#!/bin/bash
set -euo pipefail

# Capture the directory where script was invoked BEFORE anything else
INVOKE_DIR="$(pwd)"

# Script to create git worktrees for KarmaSuite project
# Usage: ./create-worktree.sh <worktree-name> [base-branch] [-b new-branch-name]
# Creates a new branch based on the specified branch (or current branch)

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions - all output to stderr so stdout can be used for machine-readable output
info() {
    echo -e "${BLUE}[INFO]${NC} $1" >&2
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1" >&2
}

warn() {
    echo -e "${YELLOW}[WARNING]${NC} $1" >&2
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

# Get the git repository root from where the script was invoked
MAIN_REPO_DIR="$(git -C "$INVOKE_DIR" rev-parse --show-toplevel 2>/dev/null)" || {
    echo -e "${RED}[ERROR]${NC} Not in a git repository: ${INVOKE_DIR}" >&2
    exit 1
}
# Worktrees directory is sibling to main repo
WORKTREES_BASE_DIR="$(dirname "$MAIN_REPO_DIR")/karmasuite-worktree"

# Parse arguments - supports both:
#   <worktree-name> [base-branch] [-b new-branch-name]
#   [-b new-branch-name] <worktree-name> [base-branch]
NEW_BRANCH_NAME=""
POSITIONAL_ARGS=()

while [[ $# -gt 0 ]]; do
    case $1 in
        -b)
            if [[ -z "${2:-}" ]]; then
                error "Option -b requires an argument"
                exit 1
            fi
            NEW_BRANCH_NAME="$2"
            shift 2
            ;;
        -*)
            error "Invalid option: $1"
            exit 1
            ;;
        *)
            POSITIONAL_ARGS+=("$1")
            shift
            ;;
    esac
done

# Restore positional arguments
set -- "${POSITIONAL_ARGS[@]}"

# Validate arguments
if [[ $# -lt 1 ]]; then
    error "Worktree name is required"
    echo "" >&2
    echo "Usage: $0 <worktree-name> [base-branch] [-b new-branch-name]" >&2
    echo "" >&2
    echo "Arguments:" >&2
    echo "  worktree-name    Name for the worktree directory (required)" >&2
    echo "  base-branch      Base branch to create from (optional, defaults to current branch)" >&2
    echo "" >&2
    echo "Options:" >&2
    echo "  -b new-branch-name  Name for the new branch (optional, defaults to worktree-name)" >&2
    echo "" >&2
    echo "Examples:" >&2
    echo "  $0 my-feature                          # Creates branch 'my-feature' from current branch" >&2
    echo "  $0 my-feature main                     # Creates branch 'my-feature' from main" >&2
    echo "  $0 my-feature -b feature/KAR-123       # Creates branch 'feature/KAR-123' from current branch" >&2
    echo "  $0 my-feature main -b feature/KAR-123  # Creates branch 'feature/KAR-123' from main" >&2
    exit 1
fi

WORKTREE_NAME="$1"
WORKTREE_PATH="${WORKTREES_BASE_DIR}/${WORKTREE_NAME}"

# Get base branch - use provided argument or current branch
if [[ $# -ge 2 ]]; then
    BASE_BRANCH="$2"
else
    BASE_BRANCH="$(cd "$MAIN_REPO_DIR" && git rev-parse --abbrev-ref HEAD)"
    info "No base branch specified, using current branch: ${BASE_BRANCH}"
fi

# Set new branch name to worktree name if not provided via -b
if [[ -z "$NEW_BRANCH_NAME" ]]; then
    NEW_BRANCH_NAME="$WORKTREE_NAME"
fi

# Check if we're in a git repository
if ! git -C "$MAIN_REPO_DIR" rev-parse --git-dir > /dev/null 2>&1; then
    error "Not a git repository: ${MAIN_REPO_DIR}"
    exit 1
fi

# Check if worktree already exists
if [[ -d "$WORKTREE_PATH" ]]; then
    error "Worktree already exists at: ${WORKTREE_PATH}"
    echo "" >&2
    echo "To remove an existing worktree, run:" >&2
    echo "  git worktree remove ${WORKTREE_PATH}" >&2
    exit 1
fi

# Check if worktree is already registered in git
if git -C "$MAIN_REPO_DIR" worktree list | grep -q "$WORKTREE_PATH"; then
    error "Worktree is already registered in git for path: ${WORKTREE_PATH}"
    echo "" >&2
    echo "To remove the worktree registration, run:" >&2
    echo "  git worktree prune" >&2
    exit 1
fi

# Verify the base branch exists
if ! git -C "$MAIN_REPO_DIR" rev-parse --verify "$BASE_BRANCH" > /dev/null 2>&1; then
    error "Base branch '${BASE_BRANCH}' does not exist"
    echo "" >&2
    echo "Available local branches:" >&2
    git -C "$MAIN_REPO_DIR" branch --list | head -20 >&2
    exit 1
fi

# Check if the new branch already exists
if git -C "$MAIN_REPO_DIR" rev-parse --verify "$NEW_BRANCH_NAME" > /dev/null 2>&1; then
    error "Branch '${NEW_BRANCH_NAME}' already exists"
    echo "" >&2
    echo "Choose a different worktree name or delete the existing branch first:" >&2
    echo "  git branch -d ${NEW_BRANCH_NAME}" >&2
    exit 1
fi

info "Creating worktree..."
info "  Name: ${WORKTREE_NAME}"
info "  Path: ${WORKTREE_PATH}"
info "  New branch: ${NEW_BRANCH_NAME}"
info "  Based on: ${BASE_BRANCH}"
echo "" >&2

# Create the worktrees base directory if it doesn't exist
if [[ ! -d "$WORKTREES_BASE_DIR" ]]; then
    info "Creating worktrees base directory: ${WORKTREES_BASE_DIR}"
    mkdir -p "$WORKTREES_BASE_DIR"
fi

# Create the worktree with a new branch
info "Creating git worktree with new branch..."
if ! git -C "$MAIN_REPO_DIR" worktree add -b "$NEW_BRANCH_NAME" "$WORKTREE_PATH" "$BASE_BRANCH"; then
    error "Failed to create worktree"
    exit 1
fi
success "Git worktree created with branch '${NEW_BRANCH_NAME}'"

# Copy .env files
info "Copying .env files..."

# Copy apps/www/.env if it exists
if [[ -f "${MAIN_REPO_DIR}/apps/www/.env" ]]; then
    mkdir -p "${WORKTREE_PATH}/apps/www"
    cp "${MAIN_REPO_DIR}/apps/www/.env" "${WORKTREE_PATH}/apps/www/.env"
    success "Copied apps/www/.env"
else
    warn "apps/www/.env not found in main repo, skipping"
fi

# Copy packages/prisma/.env if it exists
if [[ -f "${MAIN_REPO_DIR}/packages/prisma/.env" ]]; then
    mkdir -p "${WORKTREE_PATH}/packages/prisma"
    cp "${MAIN_REPO_DIR}/packages/prisma/.env" "${WORKTREE_PATH}/packages/prisma/.env"
    success "Copied packages/prisma/.env"
else
    warn "packages/prisma/.env not found in main repo, skipping"
fi

# Copy thoughts/ folder if it exists
info "Copying thoughts/ folder..."
if [[ -d "${MAIN_REPO_DIR}/thoughts" ]]; then
    cp -r "${MAIN_REPO_DIR}/thoughts" "${WORKTREE_PATH}/thoughts"
    success "Copied thoughts/ folder"
else
    warn "thoughts/ folder not found in main repo, skipping"
fi

# Copy workflow/ folder if it exists
info "Copying workflow/ folder..."
if [[ -d "${MAIN_REPO_DIR}/workflow" ]]; then
    cp -r "${MAIN_REPO_DIR}/workflow" "${WORKTREE_PATH}/workflow"
    success "Copied workflow/ folder"
else
    warn "workflow/ folder not found in main repo, skipping"
fi

# Copy CLAUDE.local.md if it exists
info "Copying CLAUDE.local.md..."
if [[ -f "${MAIN_REPO_DIR}/CLAUDE.local.md" ]]; then
    cp "${MAIN_REPO_DIR}/CLAUDE.local.md" "${WORKTREE_PATH}/CLAUDE.local.md"
    success "Copied CLAUDE.local.md"
else
    warn "CLAUDE.local.md not found in main repo, skipping"
fi

# Copy hack/ folder and set execute permissions
info "Copying hack/ folder..."
if [[ -d "${MAIN_REPO_DIR}/hack" ]]; then
    cp -r "${MAIN_REPO_DIR}/hack" "${WORKTREE_PATH}/hack"
    success "Copied hack/ folder"

    info "Setting execute permissions for all files in hack/ folder..."
    chmod +x "${WORKTREE_PATH}/hack"/*
    success "Execute permissions set for hack/ files"
else
    warn "hack/ folder not found in main repo, skipping"
fi

# Copy .scripts/ folder and set execute permissions
info "Copying .scripts/ folder..."
if [[ -d "${MAIN_REPO_DIR}/.scripts" ]]; then
    cp -r "${MAIN_REPO_DIR}/.scripts" "${WORKTREE_PATH}/.scripts"
    success "Copied .scripts/ folder"

    info "Setting execute permissions for all files in .scripts/ folder..."
    chmod +x "${WORKTREE_PATH}/.scripts"/*
    success "Execute permissions set for .scripts/ files"
else
    warn ".scripts/ folder not found in main repo, skipping"
fi

# Delete .claude folder if it exists
info "Removing .claude folder from worktree..."
if [[ -d "${WORKTREE_PATH}/.claude" ]]; then
    rm -rf "${WORKTREE_PATH}/.claude"
    success "Removed .claude folder"
else
    info ".claude folder not present, skipping"
fi

# Install dependencies
info "Installing dependencies with pnpm..."
if ! (cd "$WORKTREE_PATH" && pnpm install); then
    error "Failed to install dependencies"
    exit 1
fi
success "Dependencies installed"

# Build packages in dependency order
# Only packages with build scripts are included

info "Building packages in dependency order..."

build_package() {
    local package=$1
    info "Building package: ${package}"
    if ! (cd "$WORKTREE_PATH/packages/$package" && pnpm build); then
        error "Failed to build package: ${package}"
        exit 1
    fi
}

# Level 1: No workspace dependencies
info "Building Level 1 packages..."
for package in utils react-icons; do
    build_package "$package"
done

# Level 2: Depend on Level 1
info "Building Level 2 packages..."
for package in prisma react-hooks; do
    build_package "$package"
done

# Level 3: Depend on Level 2
info "Building Level 3 packages..."
for package in netsuite-restlet-get-transactions db-anonymizer; do
    build_package "$package"
done

success "Packages built"

# Generate Hypertune types
info "Running Hypertune generate..."
if ! (cd "$WORKTREE_PATH/apps/www" && pnpm hypertune:generate); then
    warn "Hypertune generate failed, skipping"
fi
success "Hypertune types generated"

echo "" >&2
success "Worktree setup complete!"
echo "" >&2
info "Worktree location: ${WORKTREE_PATH}"
info "To remove this worktree later:"
echo "  git worktree remove ${WORKTREE_PATH} && git branch -D ${NEW_BRANCH_NAME}" >&2
echo "" >&2

# Output the worktree path for the caller to use (stdout only)
echo "WORKTREE_PATH=${WORKTREE_PATH}"
