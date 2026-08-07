#!/usr/bin/env bash
# Reject public-release hygiene regressions before they reach a ready-for-review PR.
#
# The repository already scans secrets separately via gitleaks. This guard covers the
# lightweight release-quality expectations called out in issue #72: no accidental
# tracked build artifacts, no committed .env files, no private IP literals, and no old
# private-repo/path references in shipped source and docs.
set -euo pipefail

ROOT_DIR="${1:-.}"

log() { printf '[check-public-release-hygiene] %s\n' "$*"; }
die() { printf '[check-public-release-hygiene] ERROR: %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null || die "git not found"
have_rg=0
if command -v rg >/dev/null; then
  have_rg=1
fi

cd "$ROOT_DIR"

scan_for_matches() {
  local pattern=$1
  local path=$2

  if ((have_rg)); then
    rg -n --hidden --no-messages -g '!check-public-release-hygiene.sh' "$pattern" "$path"
    return
  fi

  grep -RInE --binary-files=without-match --exclude='check-public-release-hygiene.sh' \
    "$pattern" "$path"
}

reject_tracked_path() {
  local path=$1
  if git ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
    die "tracked build artifact found: $path"
  fi
}

if git ls-files --error-unmatch -- ".env" >/dev/null 2>&1; then
  die "tracked build artifact found: .env"
fi

if [[ -n "$(git ls-files -- ".env*" 2>/dev/null | grep -v '^\.env\.example$' || true)" ]]; then
  die "tracked build artifact found: tracked .env files"
fi

for tracked in \
  "macos/DispatcherStatusBar/build" \
  "macos/DispatcherStatusBar/build/Dispatcher Status Bar.app"
do
  reject_tracked_path "$tracked"
done

private_ip_pattern='(?<!\d)(?:10|192\.168|172\.(?:1[6-9]|2[0-9]|3[0-1]))\.\d{1,3}\.\d{1,3}(?!\d)'
shipped_paths=(
  README.md
  LICENSE
  SECURITY.md
  CONTRIBUTING.md
  src
  docs/macos-menu-bar.md
  macos/DispatcherStatusBar/Info.plist
  macos/DispatcherStatusBar/Sources
)

for path in "${shipped_paths[@]}"; do
  [[ -e "$path" ]] || continue
  if scan_for_matches "BourbonBaggers/internal-tools|/internal-tools|services/ai-dispatcher|/packages/|/apps/" "$path"; then
    die "found private repository/path residue in $path"
  fi
  if ((have_rg)); then
    if rg -n -P --hidden --no-messages -g '!check-public-release-hygiene.sh' "$private_ip_pattern" "$path"; then
      die "found private IP literal residue in $path"
    fi
  elif scan_for_matches '(^|[^0-9])(10|192\.168|172\.(1[6-9]|2[0-9]|3[0-1]))\.[0-9]{1,3}\.[0-9]{1,3}([^0-9]|$)' "$path"; then
    die "found private IP literal residue in $path"
  fi
done

log "public release hygiene checks passed"
