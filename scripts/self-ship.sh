#!/usr/bin/env bash
# self-ship.sh — autoship command for the dispatcher's OWN repository.
#
# This is the dispatcher shipping changes to itself: a green, gated PR against
# BourbonBaggers/ai-dispatcher gets merged, pulled into the running checkout, and the
# systemd service is restarted onto the new code. If the new code does not come up
# healthy, it is rolled back to the commit that was running before — self-brick protection.
#
# The hard part: restarting the service kills this very process (the ship command is a
# child of the dispatcher, inside its systemd cgroup). So the restart + health-check +
# rollback cannot run here — they would be killed mid-flight. Instead this script does the
# safe, synchronous part (re-gate, merge, pull, typecheck-smoke) and then hands the restart
# off to a DETACHED transient unit via `systemd-run --user`, which lives in its own cgroup
# and survives the dispatcher restart. That detached phase owns verify + rollback + ntfy.
#
# Contract (env in): AUTOSHIP_REPO and either AUTOSHIP_PR_NUMBER or
#           AUTOSHIP_MERGED_SHA (required).
# Optional: AUTOSHIP_PR_HEAD_SHA, AUTOSHIP_BASE_SHA,
#           AUTOSHIP_DEPLOYMENT_CHECKOUT / DISPATCHER_SELFSHIP_CHECKOUT
#           (default ~/ai-dispatcher — the checkout the systemd unit runs FROM, so a
#           restart actually picks up the merged code; NOT a separate deploy checkout),
#           DISPATCHER_SELFSHIP_UNIT     (default ai-dispatcher.service).
#
# Exit 0 = merged, smoke-passed, restart handed off. The detached phase reports the final
# health verdict (and any rollback) over ntfy, because this process cannot outlive it.

set -euo pipefail

# Default to the checkout the service actually runs from ($HOME/ai-dispatcher), so a
# restart deploys the merged code. A separate ~/ai-dispatcher-deploy checkout would be
# merged into but never served. The dispatcher normally passes AUTOSHIP_DEPLOYMENT_CHECKOUT
# explicitly (DISPATCHER_AUTOSHIP_DEPLOYMENT_DIR), which must point at that same running
# checkout for the self-instance.
CHECKOUT="${AUTOSHIP_DEPLOYMENT_CHECKOUT:-${DISPATCHER_SELFSHIP_CHECKOUT:-$HOME/ai-dispatcher}}"
UNIT="${DISPATCHER_SELFSHIP_UNIT:-ai-dispatcher.service}"
ROLLBACK_RESTART_ATTEMPTS="${DISPATCHER_SELFSHIP_ROLLBACK_RESTART_ATTEMPTS:-3}"
DEPLOY_RESULT="$CHECKOUT/.git/dispatcher-deploy-result"
RUNNING_SHA_FILE="$CHECKOUT/.git/dispatcher-running-sha"

log() { echo "[self-ship] $*"; }
die() { echo "[self-ship] FAIL: $*" >&2; exit 1; }
[[ "$ROLLBACK_RESTART_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] \
  || die "DISPATCHER_SELFSHIP_ROLLBACK_RESTART_ATTEMPTS must be a positive integer"
report() { # state health pr_head merged deployed rollback last_good
  echo "::autoship:: state=$1 health=$2 pr_head=${3:--} merged=${4:--} deployed=${5:--} rollback=${6:--} last_good=${7:--} checkout=$CHECKOUT"
}
ci_state_from_checks_json() {
  node -e '
const { readFileSync } = require("node:fs");
let checks;
try {
  checks = JSON.parse(readFileSync(0, "utf8") || "[]");
} catch {
  console.log("unknown");
  process.exit(0);
}
if (!Array.isArray(checks) || checks.length === 0) {
  console.log("unknown");
  process.exit(0);
}
const buckets = checks.map((check) => check && check.bucket);
if (buckets.some((bucket) => bucket === "fail" || bucket === "cancel")) {
  console.log("fail");
} else if (buckets.some((bucket) => bucket === "pending")) {
  console.log("pending");
} else if (buckets.every((bucket) => bucket === "pass" || bucket === "skipping")) {
  console.log("pass");
} else {
  console.log("unknown");
}
'
}
healthy() {
  local state sub
  state="$(systemctl --user show -p ActiveState --value "$UNIT" 2>/dev/null || echo unknown)"
  sub="$(systemctl --user show -p SubState --value "$UNIT" 2>/dev/null || echo unknown)"
  [[ "$state" == "active" && "$sub" == "running" ]]
}
write_deploy_result() { # requested_sha state deployed_sha rollback_sha
  local tmp="$DEPLOY_RESULT.tmp"
  printf '%s %s %s %s\n' "$1" "$2" "$3" "$4" > "$tmp"
  mv "$tmp" "$DEPLOY_RESULT"
}
read_deploy_result() {
  RESULT_TARGET="" RESULT_STATE="" RESULT_DEPLOYED="" RESULT_ROLLBACK=""
  [[ -f "$DEPLOY_RESULT" ]] || return 1
  read -r RESULT_TARGET RESULT_STATE RESULT_DEPLOYED RESULT_ROLLBACK < "$DEPLOY_RESULT"
}

# ── Detached phase: restart, verify health, roll back on self-brick. ──────────
# Invoked as `self-ship.sh --restart <last_good_sha> <new_sha>` by systemd-run, OUTSIDE
# the dispatcher cgroup, so the restart below does not kill it.
if [[ "${1:-}" == "--restart" ]]; then
  LAST_GOOD="$2"; NEW="$3"
  NTFY_URL="${NTFY_URL:-}"; NTFY_TOPIC="${NTFY_TOPIC:-}"
  push() { # title; body; priority
    [[ -n "$NTFY_URL" && -n "$NTFY_TOPIC" ]] || return 0
    curl -fsS -H "Title: $1" -H "Priority: ${3:-3}" -d "$2" "$NTFY_URL/$NTFY_TOPIC" >/dev/null 2>&1 || true
  }

  systemctl --user restart "$UNIT" || true
  sleep 2
  STARTED_PID="$(systemctl --user show -p MainPID --value "$UNIT" 2>/dev/null || echo 0)"
  sleep 12
  CURRENT_PID="$(systemctl --user show -p MainPID --value "$UNIT" 2>/dev/null || echo 0)"
  if healthy && [[ "$STARTED_PID" != "0" && "$CURRENT_PID" == "$STARTED_PID" ]]; then
    write_deploy_result "$NEW" "shipped" "$NEW" "-"
    log "self-ship healthy on $NEW"
    push "Autoship: dispatcher updated" "Restarted on $NEW and healthy." 3
    exit 0
  fi

  log "new code unhealthy — rolling back to $LAST_GOOD"
  ( cd "$CHECKOUT" && git reset --hard "$LAST_GOOD" --quiet ) || true
  rollback_attempt=0
  while ! healthy && (( rollback_attempt < ROLLBACK_RESTART_ATTEMPTS )); do
    rollback_attempt=$((rollback_attempt + 1))
    log "rollback restart attempt $rollback_attempt/$ROLLBACK_RESTART_ATTEMPTS for $LAST_GOOD"
    systemctl --user reset-failed "$UNIT" >/dev/null 2>&1 || true
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    systemctl --user restart "$UNIT" || true
    sleep 15
  done
  # A failed new-code start is still automation-owned. Report the healthy rollback to the
  # restarted dispatcher; its normal deploy-repair ledger retries assigned model work,
  # escalates to frontier, and is the only place allowed to page the operator.
  if healthy; then
    write_deploy_result "$NEW" "deployment_failed_rollback_succeeded" "-" "$LAST_GOOD"
    log "rollback healthy on $LAST_GOOD after $rollback_attempt restart attempt(s)"
    exit 0
  fi
  # Do not leave a detached restart loop fighting the next assigned-model repair. A
  # terminal rollback-failed record lets the restarted/current dispatcher spend the
  # bounded deploy ladder and ultimately produce durable exhaustion evidence.
  write_deploy_result "$NEW" "deployment_failed_rollback_failed" "-" "$LAST_GOOD"
  log "rollback remained unhealthy after $rollback_attempt restart attempt(s)"
  exit 1
fi

# ── Synchronous phase: re-gate, merge, pull, smoke, hand off. ─────────────────
PR="${AUTOSHIP_PR_NUMBER:-}"
MERGED_SHA="${AUTOSHIP_MERGED_SHA:-}"
REPO="${AUTOSHIP_REPO:?AUTOSHIP_REPO is required}"
PR_HEAD="${AUTOSHIP_PR_HEAD_SHA:-}"
[[ -n "$PR" || -n "$MERGED_SHA" ]] || die "AUTOSHIP_PR_NUMBER or AUTOSHIP_MERGED_SHA is required"

if [[ -z "$MERGED_SHA" ]]; then
  # Classify structured check buckets instead of trusting raw gh exit-code semantics.
  # A transient CLI/reporting failure must not fabricate red CI when GitHub's current
  # check rollup is actually green; unreadable state remains a repairable unknown.
  ci_json=""
  ci_rc=0
  ci_json="$(gh pr checks "$PR" --repo "$REPO" --json bucket 2>/dev/null)" || ci_rc=$?
  ci_state="$(printf '%s' "$ci_json" | ci_state_from_checks_json)"
  if [[ "$ci_state" == "unknown" && "$ci_rc" -eq 8 ]]; then
    ci_state="pending"
  fi
  case "$ci_state" in
    pass) log "CI green for PR #$PR" ;;
    pending) die "CI pending for PR #$PR" ;;
    fail) die "CI not green for PR #$PR" ;;
    *) die "CI state unknown for PR #$PR (gh exit $ci_rc)" ;;
  esac
fi

mkdir -p "$(dirname "$CHECKOUT")"
if [[ ! -d "$CHECKOUT/.git" ]]; then
  rm -rf "$CHECKOUT"
  gh repo clone "$REPO" "$CHECKOUT" -- --quiet
fi

cd "$CHECKOUT"
git fetch origin --quiet
# This checkout is dedicated to autoship, so bounded cleanup is allowed here. Do not apply
# this pattern to an agent or human worktree; those may contain unsaved work.
if [[ -d .git/rebase-merge || -d .git/rebase-apply ]]; then
  log "aborting stale rebase state in dedicated deployment checkout"
  git rebase --abort >/dev/null 2>&1 || true
fi
if [[ -f .git/MERGE_HEAD ]]; then
  log "aborting stale merge state in dedicated deployment checkout"
  git merge --abort >/dev/null 2>&1 || true
fi
if [[ -f .git/CHERRY_PICK_HEAD ]]; then
  log "aborting stale cherry-pick state in dedicated deployment checkout"
  git cherry-pick --abort >/dev/null 2>&1 || true
fi
if [[ -n "$(git status --porcelain=v1)" ]]; then
  log "resetting dirty dedicated deployment checkout"
  git status --porcelain=v1
  git reset --hard origin/main --quiet
  git clean -fd --quiet
fi

# The commit currently running is this checkout's HEAD; capture it BEFORE syncing
# origin/main. An already-merged recovery arrives after origin/main advanced, and using
# origin/main as LAST_GOOD would make rollback point at the unverified new code.
git checkout main --quiet
LAST_GOOD="$(git rev-parse HEAD)"

if [[ -n "$MERGED_SHA" ]]; then
  git rev-parse --verify "$MERGED_SHA^{commit}" >/dev/null 2>&1 \
    || die "merged commit $MERGED_SHA is not available after fetch"
  NEW="$(git rev-parse "$MERGED_SHA^{commit}")"
  if read_deploy_result && [[ "$RESULT_TARGET" == "$NEW" ]]; then
    if [[ "$RESULT_STATE" == "pending" ]]; then
      log "detached deployment for $NEW is still pending; waiting for its verifier"
      for _ in $(seq 1 45); do
        sleep 2
        read_deploy_result || continue
        [[ "$RESULT_TARGET" == "$NEW" && "$RESULT_STATE" != "pending" ]] && break
      done
    fi
    if [[ "$RESULT_TARGET" == "$NEW" ]]; then
      case "$RESULT_STATE" in
        shipped)
          if healthy; then
            report "shipped" "pass" "$PR_HEAD" "$NEW" "$RESULT_DEPLOYED" "-" "$LAST_GOOD"
            exit 0
          fi
          report "deployment_state_unknown" "unknown" "$PR_HEAD" "$NEW" "$RESULT_DEPLOYED" "-" "$LAST_GOOD"
          exit 1
          ;;
        deployment_failed_rollback_succeeded)
          report "$RESULT_STATE" "pass" "$PR_HEAD" "$NEW" "-" "$RESULT_ROLLBACK" "$LAST_GOOD"
          exit 1
          ;;
        deployment_failed_rollback_failed)
          report "$RESULT_STATE" "fail" "$PR_HEAD" "$NEW" "-" "$RESULT_ROLLBACK" "$LAST_GOOD"
          exit 1
          ;;
        pending)
          report "deployment_state_unknown" "unknown" "$PR_HEAD" "$NEW" "-" "-" "$LAST_GOOD"
          die "detached deployment verifier did not finish within 90 seconds"
          ;;
      esac
    fi
  fi
  RUNNING_SHA="$(tr -d '[:space:]' < "$RUNNING_SHA_FILE" 2>/dev/null || true)"
  if [[ "$RUNNING_SHA" =~ ^[0-9a-f]{40}$ ]] \
    && git merge-base --is-ancestor "$NEW" "$RUNNING_SHA" \
    && healthy; then
    log "merged commit $NEW is already included in running dispatcher $RUNNING_SHA"
    report "shipped" "pass" "$PR_HEAD" "$NEW" "$RUNNING_SHA" "-" "$LAST_GOOD"
    exit 0
  fi
  git reset --hard "$NEW" --quiet
  log "continuing deployment of already-merged commit $NEW"
else
  git reset --hard origin/main --quiet
  gh pr ready "$PR" --repo "$REPO" >/dev/null 2>&1 || true
  merge_rc=0
  gh pr merge "$PR" --repo "$REPO" --merge --admin --delete-branch >/dev/null 2>&1 || merge_rc=$?
  [[ "$merge_rc" -eq 0 ]] || die "gh pr merge exited $merge_rc"

  git fetch origin --quiet
  NEW="$(git rev-parse origin/main)"
  if [[ -n "$PR_HEAD" ]] && ! git merge-base --is-ancestor "$PR_HEAD" "$NEW"; then
    report "merge_succeeded_deployment_not_attempted" "unknown" "$PR_HEAD" "$NEW" "-" "-" "$LAST_GOOD"
    die "merged main $NEW does not contain expected PR head $PR_HEAD"
  fi
  git reset --hard "$NEW" --quiet
  log "merged PR #$PR; main is $NEW (was $LAST_GOOD)"
fi

# Smoke: a merge of two green branches can still be semantically broken. Typecheck the
# merged tree before we dare restart the live service onto it. Failure aborts WITHOUT
# restarting — the running service keeps serving the old code — and rolls main back.
npm ci --silent >/dev/null 2>&1 || true
if ! npm run typecheck >/dev/null 2>&1; then
  log "merged code fails typecheck — reverting main, NOT restarting"
  git revert --no-edit -m 1 "$NEW" >/dev/null 2>&1 || git reset --hard "$LAST_GOOD" --quiet
  git push origin main --quiet 2>/dev/null || git push --force-with-lease origin main --quiet
  report "merge_succeeded_deployment_not_attempted" "unknown" "$PR_HEAD" "$NEW" "-" "-" "$LAST_GOOD"
  die "PR #$PR merged but failed typecheck on main; reverted, service untouched"
fi

# Hand the restart to a detached transient unit outside our cgroup, so it survives the
# restart it is about to perform. --collect reaps the unit when it exits.
log "handing off restart to a detached unit"
write_deploy_result "$NEW" "pending" "-" "-"
SHIP_ID="${PR:-${NEW:0:12}}"
systemd-run --user --collect --unit="selfship-$SHIP_ID-$(date +%s)" \
  --setenv=NTFY_URL="${NTFY_URL:-}" --setenv=NTFY_TOPIC="${NTFY_TOPIC:-}" \
  --setenv=DISPATCHER_SELFSHIP_UNIT="$UNIT" --setenv=DISPATCHER_SELFSHIP_CHECKOUT="$CHECKOUT" \
  /bin/bash "$CHECKOUT/scripts/self-ship.sh" --restart "$LAST_GOOD" "$NEW"

report "merge_succeeded_deployment_not_attempted" "unknown" "$PR_HEAD" "$NEW" "-" "-" "$LAST_GOOD"
log "merge/deploy smoke ok; restart handed off for ${PR:+PR #$PR}${PR:-commit $NEW}; verification pending"
exit 0
