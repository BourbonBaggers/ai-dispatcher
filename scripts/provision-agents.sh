#!/usr/bin/env bash
# provision-agents.sh — one-time setup of the ai-dispatcher host.
#
# Run ON the host that will launch agents. The provisioning host is this service's
# concern, not a repository-specific deployment's.
#
# Installs and verifies everything the dispatcher needs to launch coding agents:
#   • gh          — GitHub CLI (user-local; the dev server has no passwordless sudo)
#   • codex       — OpenAI Codex CLI
#   • claude      — Claude Code CLI
#   • a dedicated dispatcher clone of the repo, separate from DEV_APP_DIR
#   • the worktree base directory
#
# Authentication is interactive and is NOT performed here — the CLIs own their own
# credential stores and we never put agent credentials in the database or .env.
# This script prints the exact login commands for whatever is still unauthenticated.
#
# Safe to re-run: every step is idempotent.
set -euo pipefail

# Node 24 lives under nvm; a non-login ssh shell may not have it on PATH.
export PATH="$HOME/bin:$PATH"
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
fi

GH_VERSION="2.63.2"

# Configuration may come from documented environment variables or explicit CLI flags.
# Keep the script reusable for any checkout rather than silently defaulting to the
# deployment-specific repository and paths.
REPO_SLUG="${DISPATCHER_REPO:-${DISPATCHER_REPO_SLUG:-}}"
DISPATCHER_REPO_DIR="${DISPATCHER_REPO_DIR:-}"
DISPATCHER_WORKTREE_DIR="${DISPATCHER_WORKTREE_DIR:-}"
DISPATCHER_ENV_SOURCE_DIR="${DISPATCHER_ENV_SOURCE_DIR:-}"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok()   { printf '   \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '   \033[33m!\033[0m %s\n' "$1"; }

usage() {
  cat <<'EOF'
Usage: scripts/provision-agents.sh [options]

Options:
  --repo <owner/repo>               GitHub repository to clone and maintain
  --repo-dir <path>                 Dispatcher checkout path
  --worktree-dir <path>             Base directory for per-run worktrees
  --env-source-dir <path>           Optional checkout whose .env seeds the checkout
  -h, --help                        Show this help text

Environment variables:
  DISPATCHER_REPO
  DISPATCHER_REPO_SLUG
  DISPATCHER_REPO_DIR
  DISPATCHER_WORKTREE_DIR
  DISPATCHER_ENV_SOURCE_DIR
EOF
}

while (($#)); do
  case "$1" in
    --repo)
      REPO_SLUG="${2:-}"
      shift 2
      ;;
    --repo-dir)
      DISPATCHER_REPO_DIR="${2:-}"
      shift 2
      ;;
    --worktree-dir)
      DISPATCHER_WORKTREE_DIR="${2:-}"
      shift 2
      ;;
    --env-source-dir)
      DISPATCHER_ENV_SOURCE_DIR="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ -n "$REPO_SLUG" ]] || { echo "missing required repo slug: set DISPATCHER_REPO or DISPATCHER_REPO_SLUG, or pass --repo" >&2; exit 1; }
[[ -n "$DISPATCHER_REPO_DIR" ]] || { echo "missing required repo checkout path: set DISPATCHER_REPO_DIR or pass --repo-dir" >&2; exit 1; }
[[ -n "$DISPATCHER_WORKTREE_DIR" ]] || { echo "missing required worktree base path: set DISPATCHER_WORKTREE_DIR or pass --worktree-dir" >&2; exit 1; }

# ─── git ─────────────────────────────────────────────────────────────────────
step "git"
command -v git >/dev/null || { echo "git is not installed. Install it with: sudo apt install git" >&2; exit 1; }
ok "$(git --version)"

# ─── gh ──────────────────────────────────────────────────────────────────────
step "GitHub CLI"
if ! command -v gh >/dev/null; then
  # No passwordless sudo on this host, so install the release tarball into ~/bin
  # rather than using apt.
  tarball="gh_${GH_VERSION}_linux_amd64"
  curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${tarball}.tar.gz" -o "/tmp/${tarball}.tar.gz"
  tar -xzf "/tmp/${tarball}.tar.gz" -C /tmp
  mkdir -p "$HOME/bin"
  install -m 0755 "/tmp/${tarball}/bin/gh" "$HOME/bin/gh"
  rm -rf "/tmp/${tarball}.tar.gz" "/tmp/${tarball}"
fi
ok "$(gh --version | head -1)"

# ─── agent CLIs ──────────────────────────────────────────────────────────────
step "Codex CLI"
command -v codex >/dev/null || npm install -g @openai/codex
ok "codex $(codex --version 2>&1 | head -1)"

step "Claude Code CLI"
command -v claude >/dev/null || npm install -g @anthropic-ai/claude-code
ok "claude $(claude --version 2>&1 | head -1)"

# ─── dispatcher checkout ─────────────────────────────────────────────────────
step "Dispatcher repo checkout"
if [[ -d "$DISPATCHER_REPO_DIR/.git" ]]; then
  # Hard-reset to origin/main, not just fetch. The API runs dispatch-agent.sh and
  # dispatch-doctor.sh *out of this checkout*, so a stale one means the dispatcher
  # runs stale scripts — or, right after the feature ships, none at all. Nothing is
  # ever authored here (agents work in per-run clones), so there is nothing to lose.
  git -C "$DISPATCHER_REPO_DIR" fetch --quiet origin
  git -C "$DISPATCHER_REPO_DIR" reset --hard --quiet origin/main
  ok "updated $DISPATCHER_REPO_DIR to $(git -C "$DISPATCHER_REPO_DIR" rev-parse --short HEAD)"
else
  mkdir -p "$(dirname "$DISPATCHER_REPO_DIR")"
  git clone --quiet "https://github.com/${REPO_SLUG}.git" "$DISPATCHER_REPO_DIR"
  ok "cloned $REPO_SLUG → $DISPATCHER_REPO_DIR"
fi

# Agents commit as themselves; give the dispatcher checkout a sane default identity
# so a commit never fails with "please tell me who you are".
git -C "$DISPATCHER_REPO_DIR" config user.name  "Internal Tools Dispatcher"
git -C "$DISPATCHER_REPO_DIR" config user.email "noreply@anthropic.com"

step "Git push authentication"
# Agents push over HTTPS using gh's token. Two things break that:
#   1. a global `url.git@github.com:.insteadOf https://github.com/` rewrite, which
#      silently redirects every HTTPS push onto SSH — and the SSH key GitHub sees may
#      be a read-only deploy key ("the key you are authenticating with has been marked
#      as read only"), which fails only at push time, after the agent has done the work;
#   2. no git credential helper, so HTTPS has no token to present.
if git config --global --get-regexp 'url\..*insteadof' >/dev/null 2>&1; then
  git config --global --unset-all url.'git@github.com:'.insteadOf 2>/dev/null || true
  ok "removed the global HTTPS→SSH rewrite (it forced pushes onto a read-only key)"
fi
gh auth setup-git 2>/dev/null && ok "gh is git's credential helper for github.com"

step "Dispatcher .env"
# deploy.sh and dispatcher-autoship.sh run out of this clone and need the SSH/ntfy
# coordinates. Copied, never committed (it is gitignored).
if [[ -n "$DISPATCHER_ENV_SOURCE_DIR" && -f "$DISPATCHER_ENV_SOURCE_DIR/.env" ]]; then
  cp "$DISPATCHER_ENV_SOURCE_DIR/.env" "$DISPATCHER_REPO_DIR/.env"
  chmod 600 "$DISPATCHER_REPO_DIR/.env"
  ok "seeded .env into the dispatcher checkout"
else
  warn "no .env source configured — autonomous deploys will fail until you provide one"
fi

step "Worktree base directory"
mkdir -p "$DISPATCHER_WORKTREE_DIR"
[[ -w "$DISPATCHER_WORKTREE_DIR" ]] || { echo "not writable: $DISPATCHER_WORKTREE_DIR" >&2; exit 1; }
ok "$DISPATCHER_WORKTREE_DIR is writable"

step "AGENTS.md → CLAUDE.md symlink"
if [[ -L "$DISPATCHER_REPO_DIR/AGENTS.md" ]]; then
  ok "intact ($(readlink "$DISPATCHER_REPO_DIR/AGENTS.md"))"
else
  warn "AGENTS.md is not a symlink — Codex and Claude may read different rules"
fi

# ─── authentication (interactive; operator-driven) ───────────────────────────
step "Authentication status"
needs_auth=()

if gh auth status >/dev/null 2>&1; then
  ok "gh authenticated"
else
  warn "gh NOT authenticated"
  needs_auth+=("gh auth login --hostname github.com --git-protocol https --web")
fi

# Both agent CLIs store credentials under ~/.codex and ~/.claude respectively.
# There is no scriptable 'am I logged in' probe that doesn't burn a token, so we
# check for the credential store the interactive login writes.
if [[ -f "$HOME/.codex/auth.json" ]]; then
  ok "codex authenticated"
else
  warn "codex NOT authenticated"
  needs_auth+=("codex login")
fi

if [[ -f "$HOME/.claude/.credentials.json" ]] || [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  ok "claude authenticated"
else
  warn "claude NOT authenticated"
  needs_auth+=("claude setup-token")
fi

if ((${#needs_auth[@]})); then
  cat <<EOF

────────────────────────────────────────────────────────────────────────────
  OPERATOR ACTION REQUIRED — run these on the dev server over SSH.
  Each is a one-time interactive login. Credentials stay in the CLI's own
  store on this server; they are never written to the database or .env.

EOF
  for cmd in "${needs_auth[@]}"; do printf '    %s\n' "$cmd"; done
  cat <<EOF

  Then re-run this script to confirm everything reports ready.
────────────────────────────────────────────────────────────────────────────
EOF
  exit 1
fi

step "Ready"
ok "All dispatcher prerequisites satisfied."
