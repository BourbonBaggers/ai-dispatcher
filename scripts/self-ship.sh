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
DEPLOY_RESULT="$CHECKOUT/.git/dispatcher-deploy-result"

log() { echo "[self-ship] $*"; }
die() { echo "[self-ship] FAIL: $*" >&2; exit 1; }
report() { # state health pr_head merged deployed rollback last_good
  echo "::autoship:: state=$1 health=$2 pr_head=${3:--} merged=${4:--} deployed=${5:--} rollback=${6:--} last_good=${7:--} checkout=$CHECKOUT"
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
  sleep 12
  if healthy; then
    write_deploy_result "$NEW" "shipped" "$NEW" "-"
    log "self-ship healthy on $NEW"
    push "Autoship: dispatcher updated" "Restarted on $NEW and healthy." 3
    exit 0
  fi

  log "new code unhealthy — rolling back to $LAST_GOOD"
  ( cd "$CHECKOUT" && git reset --hard "$LAST_GOOD" --quiet ) || true
  systemctl --user restart "$UNIT" || true
  sleep 12
  if healthy; then
    write_deploy_result "$NEW" "deployment_failed_rollback_succeeded" "-" "$LAST_GOOD"
    push "Autoship ROLLED BACK dispatcher" "New code $NEW failed to start; reverted to $LAST_GOOD and healthy." 5
  else
    write_deploy_result "$NEW" "deployment_failed_rollback_failed" "-" "$LAST_GOOD"
    push "Autoship: DISPATCHER DOWN" "New code $NEW bricked the dispatcher AND rollback to $LAST_GOOD is not healthy. Needs a human NOW." 5
  fi
  exit 0
fi

# ── Synchronous phase: re-gate, merge, pull, smoke, hand off. ─────────────────
PR="${AUTOSHIP_PR_NUMBER:-}"
MERGED_SHA="${AUTOSHIP_MERGED_SHA:-}"
REPO="${AUTOSHIP_REPO:?AUTOSHIP_REPO is required}"
PR_HEAD="${AUTOSHIP_PR_HEAD_SHA:-}"
[[ -n "$PR" || -n "$MERGED_SHA" ]] || die "AUTOSHIP_PR_NUMBER or AUTOSHIP_MERGED_SHA is required"

if [[ -z "$MERGED_SHA" ]]; then
  # gh pr checks: 0 green, 8 pending, else failed. Capture explicitly (set -e safe).
  ci_rc=0
  gh pr checks "$PR" --repo "$REPO" >/dev/null 2>&1 || ci_rc=$?
  case "$ci_rc" in
    0) log "CI green for PR #$PR" ;;
    8) die "CI pending for PR #$PR" ;;
    *) die "CI not green for PR #$PR (exit $ci_rc)" ;;
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
  git reset --hard "$NEW" --quiet
  log "continuing deployment of already-merged commit $NEW"
  if [[ -f "$DEPLOY_RESULT" ]]; then
    read -r RESULT_TARGET RESULT_STATE RESULT_DEPLOYED RESULT_ROLLBACK < "$DEPLOY_RESULT"
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
      esac
    fi
  fi
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
rm -f "$DEPLOY_RESULT"
SHIP_ID="${PR:-${NEW:0:12}}"
systemd-run --user --collect --unit="selfship-$SHIP_ID-$(date +%s)" \
  --setenv=NTFY_URL="${NTFY_URL:-}" --setenv=NTFY_TOPIC="${NTFY_TOPIC:-}" \
  --setenv=DISPATCHER_SELFSHIP_UNIT="$UNIT" --setenv=DISPATCHER_SELFSHIP_CHECKOUT="$CHECKOUT" \
  /bin/bash "$CHECKOUT/scripts/self-ship.sh" --restart "$LAST_GOOD" "$NEW"

report "merge_succeeded_deployment_not_attempted" "unknown" "$PR_HEAD" "$NEW" "-" "-" "$LAST_GOOD"
log "merge/deploy smoke ok; restart handed off for ${PR:+PR #$PR}${PR:-commit $NEW}; verification pending"
exit 0
