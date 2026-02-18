#!/bin/bash
set -euo pipefail

# Capture the directory where script was invoked BEFORE anything else
INVOKE_DIR="$(pwd)"

# Script to remove git worktrees for KarmaSuite project
# Usage: ./remove_worktree.sh [-D] <worktree-path>
# Removes the worktree and optionally deletes the underlying branch

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

# Get the git repository root from where the script was invoked
MAIN_REPO_DIR="$(git -C "$INVOKE_DIR" rev-parse --show-toplevel 2>/dev/null)" || {
    echo -e "${RED}[ERROR]${NC} Not in a git repository: ${INVOKE_DIR}" >&2
    exit 1
}

# Parse arguments (handle -D flag in any position)
DELETE_BRANCH=false
WORKTREE_PATH=""

for arg in "$@"; do
    case $arg in
        -D)
            DELETE_BRANCH=true
            ;;
        -*)
            error "Invalid option: $arg"
            exit 1
            ;;
        *)
            if [[ -z "$WORKTREE_PATH" ]]; then
                WORKTREE_PATH="$arg"
            else
                error "Unexpected argument: $arg"
                exit 1
            fi
            ;;
    esac
done

# Validate arguments
if [[ -z "$WORKTREE_PATH" ]]; then
    error "Worktree path is required"
    echo ""
    echo "Usage: $0 [-D] <worktree-path>"
    echo ""
    echo "Arguments:"
    echo "  worktree-path    Path to the worktree to remove (required)"
    echo ""
    echo "Options:"
    echo "  -D               Also delete the underlying branch"
    echo ""
    echo "Examples:"
    echo "  $0 ../karmasuite-worktree/my-feature        # Remove worktree only"
    echo "  $0 -D ../karmasuite-worktree/my-feature     # Remove worktree and delete branch"
    echo "  $0 ../karmasuite-worktree/my-feature -D     # -D can be in any position"
    exit 1
fi

# Resolve to absolute path
if [[ ! "$WORKTREE_PATH" = /* ]]; then
    WORKTREE_PATH="$(cd "$(dirname "$WORKTREE_PATH")" 2>/dev/null && pwd)/$(basename "$WORKTREE_PATH")" || WORKTREE_PATH="$(pwd)/$1"
fi

# Check if we're in a git repository
if ! git -C "$MAIN_REPO_DIR" rev-parse --git-dir > /dev/null 2>&1; then
    error "Not a git repository: ${MAIN_REPO_DIR}"
    exit 1
fi

# Check if the worktree exists in git's worktree list
WORKTREE_INFO=$(git -C "$MAIN_REPO_DIR" worktree list --porcelain | grep -A2 "worktree $WORKTREE_PATH$" || true)

if [[ -z "$WORKTREE_INFO" ]]; then
    error "Worktree not found: ${WORKTREE_PATH}"
    echo ""
    echo "Available worktrees:"
    git -C "$MAIN_REPO_DIR" worktree list
    exit 1
fi

# Extract the branch name from the worktree info
BRANCH_NAME=$(echo "$WORKTREE_INFO" | grep "^branch " | sed 's/branch refs\/heads\///')

if [[ -z "$BRANCH_NAME" ]]; then
    warn "Could not determine branch name for worktree"
    if [[ "$DELETE_BRANCH" = true ]]; then
        error "Cannot delete branch: branch name could not be determined"
        exit 1
    fi
fi

info "Removing worktree..."
info "  Path: ${WORKTREE_PATH}"
if [[ -n "$BRANCH_NAME" ]]; then
    info "  Branch: ${BRANCH_NAME}"
fi
if [[ "$DELETE_BRANCH" = true ]]; then
    info "  Will also delete branch: yes"
fi
echo ""

# Remove the worktree
info "Removing git worktree..."
if ! git -C "$MAIN_REPO_DIR" worktree remove "$WORKTREE_PATH"; then
    error "Failed to remove worktree"
    echo ""
    echo "If the worktree has uncommitted changes, use:"
    echo "  git worktree remove --force ${WORKTREE_PATH}"
    exit 1
fi
success "Git worktree removed"

# Delete the branch if -D was provided
if [[ "$DELETE_BRANCH" = true ]] && [[ -n "$BRANCH_NAME" ]]; then
    info "Deleting branch '${BRANCH_NAME}'..."
    if ! git -C "$MAIN_REPO_DIR" branch -D "$BRANCH_NAME"; then
        error "Failed to delete branch: ${BRANCH_NAME}"
        exit 1
    fi
    success "Branch '${BRANCH_NAME}' deleted"
fi

echo ""
success "Worktree removal complete!"
