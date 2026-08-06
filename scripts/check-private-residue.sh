#!/usr/bin/env bash
# Reject private deployment residue from shipped source and docs.
#
# The goal is to keep the public checkout free of hard-coded private repository names
# and private LAN addresses while still allowing tests and historical records to retain
# context about the old deployment.
set -euo pipefail

ROOT_DIR="${1:-.}"

log() { printf '[check-private-residue] %s\n' "$*"; }
die() { printf '[check-private-residue] ERROR: %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null || die "git not found"
have_rg=0
if command -v rg >/dev/null; then
  have_rg=1
fi

cd "$ROOT_DIR"

INCLUDED_PATHS=(
  README.md
  src
  scripts
  .github
  docs/macos-menu-bar.md
)

private_ip_pattern='(?<!\d)(?:10|192\.168|172\.(?:1[6-9]|2[0-9]|3[0-1]))\.\d{1,3}\.\d{1,3}(?!\d)'

scan_for_residue() {
  local pattern=$1
  local path=$2

  if ((have_rg)); then
    rg -n --hidden --no-messages -g '!check-private-residue.sh' "$pattern" "$path"
    return
  fi

  # Use grep as a portable fallback on runners that do not ship ripgrep.
  grep -RInE --binary-files=without-match --exclude='check-private-residue.sh' "$pattern" "$path"
}

for path in "${INCLUDED_PATHS[@]}"; do
  [[ -e "$path" ]] || continue
  if scan_for_residue "BourbonBaggers/internal-tools" "$path"; then
    die "found private residue matching /BourbonBaggers\/internal-tools/ in $path"
  fi
  if ((have_rg)); then
    if rg -n -P --hidden --no-messages -g '!check-private-residue.sh' "$private_ip_pattern" "$path"; then
      die "found private residue matching private IP literals in $path"
    fi
  elif scan_for_residue '(^|[^0-9])(10|192\.168|172\.(1[6-9]|2[0-9]|3[0-1]))\.[0-9]{1,3}\.[0-9]{1,3}([^0-9]|$)' "$path"; then
    die "found private residue matching private IP literals in $path"
  fi
done

log "no private deployment residue found in shipped source/docs"
