#!/usr/bin/env bash
# CI ShellCheck wrapper for bounded analysis and local reproduction.
#
# The issue #12 incident looked like a ShellCheck hang while the workflow was still live,
# but the referenced runs later showed the jobs had not started yet. Keep this wrapper
# phase-visible anyway so future failures identify whether installation, discovery, or
# analysis is the slow part.
set -euo pipefail

TIMEOUT_SECONDS="${SHELLCHECK_TIMEOUT_SECONDS:-300}"
BATCH_SIZE="${SHELLCHECK_BATCH_SIZE:-20}"
TIMEOUT_COMMAND="${SHELLCHECK_TIMEOUT_COMMAND:-auto}"

EXCLUDED_DIRS=(
  .cache
  .codex
  .git
  .next
  .npm
  .turbo
  build
  coverage
  dist
  generated
  node_modules
  out
  tmp
  vendor
)

log() { printf '[shellcheck-ci] %s\n' "$*"; }
die() { printf '[shellcheck-ci] ERROR: %s\n' "$*" >&2; exit 1; }

now_ms() {
  local seconds nanoseconds
  seconds="$(date +%s)"
  nanoseconds="$(date +%N)"
  printf '%s%03d\n' "$seconds" "$((10#${nanoseconds:0:3}))"
}

duration_ms() {
  local start="$1" end="$2"
  printf '%d' "$((end - start))"
}

format_duration() {
  local ms="$1"
  printf '%d.%03ds' "$((ms / 1000))" "$((ms % 1000))"
}

is_excluded_path() {
  local path="$1" dir
  for dir in "${EXCLUDED_DIRS[@]}"; do
    if [[ "$path" == "$dir" || "$path" == "$dir/"* || "$path" == */"$dir"/* ]]; then
      return 0
    fi
  done
  return 1
}

is_shell_file() {
  local path="$1" first_line

  [[ "$path" == *.sh ]] && return 0
  [[ -f "$path" ]] || return 1

  IFS= read -r first_line <"$path" || true
  case "$first_line" in
    '#!'*'/sh'|'#!'*'/sh '*|'#!'*'/bash'|'#!'*'/bash '*|'#!'*'env sh'|'#!'*'env bash')
      return 0
      ;;
  esac

  return 1
}

run_shellcheck_batch() {
  local now elapsed remaining rc batch_count
  batch_count="$#"

  ((batch_count > 0)) || return 0
  now="$(now_ms)"
  elapsed="$(((now - CHECK_PHASE_START_MS) / 1000))"
  remaining="$((TIMEOUT_SECONDS - elapsed))"
  if ((remaining <= 0)); then
    die "ShellCheck timed out after ${TIMEOUT_SECONDS}s. Reproduce locally with: SHELLCHECK_TIMEOUT_SECONDS=${TIMEOUT_SECONDS} scripts/shellcheck-ci.sh"
  fi

  rc=0
  case "$TIMEOUT_COMMAND" in
    timeout|gtimeout)
      "$TIMEOUT_COMMAND" "${remaining}s" shellcheck --severity=error --shell=bash "$@" || rc=$?
      ;;
    perl)
      # macOS has no coreutils timeout by default. Perl's alarm survives exec, so this
      # keeps the same hard bound without silently making local validation unbounded.
      perl -e 'alarm shift; exec @ARGV' "$remaining" shellcheck --severity=error --shell=bash "$@" || rc=$?
      ;;
  esac
  case "$rc" in
    0) return 0 ;;
    124|137|142)
      die "ShellCheck timed out after ${TIMEOUT_SECONDS}s while checking a batch of ${batch_count} file(s). Reproduce locally with: SHELLCHECK_TIMEOUT_SECONDS=${TIMEOUT_SECONDS} scripts/shellcheck-ci.sh"
      ;;
    *) return "$rc" ;;
  esac
}

command -v git >/dev/null || die "git not found"
command -v shellcheck >/dev/null || die "shellcheck not found"
[[ "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || die "SHELLCHECK_TIMEOUT_SECONDS must be a positive integer"
[[ "$BATCH_SIZE" =~ ^[1-9][0-9]*$ ]] || die "SHELLCHECK_BATCH_SIZE must be a positive integer"
case "$TIMEOUT_COMMAND" in
  auto)
    if command -v timeout >/dev/null; then
      TIMEOUT_COMMAND=timeout
    elif command -v gtimeout >/dev/null; then
      TIMEOUT_COMMAND=gtimeout
    elif command -v perl >/dev/null; then
      TIMEOUT_COMMAND=perl
    else
      die "no bounded execution command found (tried timeout, gtimeout, perl)"
    fi
    ;;
  timeout|gtimeout|perl)
    command -v "$TIMEOUT_COMMAND" >/dev/null || die "$TIMEOUT_COMMAND not found"
    ;;
  *)
    die "SHELLCHECK_TIMEOUT_COMMAND must be auto, timeout, gtimeout, or perl"
    ;;
esac

log "ShellCheck version: $(shellcheck --version | awk -F': ' '/^version:/ { print $2; exit }')"

discovery_start="$(now_ms)"
files=()
while IFS= read -r -d '' path; do
  is_excluded_path "$path" && continue
  [[ -L "$path" ]] && continue
  is_shell_file "$path" || continue
  files+=("$path")
done < <(git ls-files -z -- .)
discovery_end="$(now_ms)"

log "Discovery duration: $(format_duration "$(duration_ms "$discovery_start" "$discovery_end")")"
log "Discovered shell file count: ${#files[@]}"
log "ShellCheck base command: shellcheck --severity=error --shell=bash"
log "ShellCheck timeout: ${TIMEOUT_SECONDS}s total analysis budget; batch size: ${BATCH_SIZE}"

if ((${#files[@]} == 0)); then
  log "No shell files discovered; nothing to check."
  exit 0
fi

check_start="$(now_ms)"
CHECK_PHASE_START_MS="$check_start"
batch=()
checked=0
for file in "${files[@]}"; do
  batch+=("$file")
  if ((${#batch[@]} >= BATCH_SIZE)); then
    run_shellcheck_batch "${batch[@]}"
    checked=$((checked + ${#batch[@]}))
    log "Checked $checked/${#files[@]} files"
    batch=()
  fi
done

if ((${#batch[@]} > 0)); then
  run_shellcheck_batch "${batch[@]}"
  checked=$((checked + ${#batch[@]}))
  log "Checked $checked/${#files[@]} files"
fi
check_end="$(now_ms)"

log "Check duration: $(format_duration "$(duration_ms "$check_start" "$check_end")")"
