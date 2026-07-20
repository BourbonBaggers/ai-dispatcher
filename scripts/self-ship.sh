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
# Contract (env in): AUTOSHIP_PR_NUMBER, AUTOSHIP_REPO (required).
# Optional: DISPATCHER_SELFSHIP_CHECKOUT (default ~/ai-dispatcher),
#           DISPATCHER_SELFSHIP_UNIT     (default ai-dispatcher.service).
#
# Exit 0 = merged, smoke-passed, restart handed off. The detached phase reports the final
# health verdict (and any rollback) over ntfy, because this process cannot outlive it.

set -euo pipefail

CHECKOUT="${DISPATCHER_SELFSHIP_CHECKOUT:-$HOME/ai-dispatcher}"
UNIT="${DISPATCHER_SELFSHIP_UNIT:-ai-dispatcher.service}"

log() { echo "[self-ship] $*"; }
die() { echo "[self-ship] FAIL: $*" >&2; exit 1; }

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
  healthy() { # unit is up and stably running, not crash-looping
    local state sub
    state="$(systemctl --user show -p ActiveState --value "$UNIT" 2>/dev/null || echo unknown)"
    sub="$(systemctl --user show -p SubState --value "$UNIT" 2>/dev/null || echo unknown)"
    [[ "$state" == "active" && "$sub" == "running" ]]
  }

  systemctl --user restart "$UNIT" || true
  sleep 12
  if healthy; then
    log "self-ship healthy on $NEW"
    push "Autoship: dispatcher updated" "Restarted on $NEW and healthy." 3
    exit 0
  fi

  log "new code unhealthy — rolling back to $LAST_GOOD"
  ( cd "$CHECKOUT" && git reset --hard "$LAST_GOOD" --quiet ) || true
  systemctl --user restart "$UNIT" || true
  sleep 12
  if healthy; then
    push "Autoship ROLLED BACK dispatcher" "New code $NEW failed to start; reverted to $LAST_GOOD and healthy." 5
  else
    push "Autoship: DISPATCHER DOWN" "New code $NEW bricked the dispatcher AND rollback to $LAST_GOOD is not healthy. Needs a human NOW." 5
  fi
  exit 0
fi

# ── Synchronous phase: re-gate, merge, pull, smoke, hand off. ─────────────────
PR="${AUTOSHIP_PR_NUMBER:?AUTOSHIP_PR_NUMBER is required}"
REPO="${AUTOSHIP_REPO:?AUTOSHIP_REPO is required}"
[[ -d "$CHECKOUT/.git" ]] || die "no checkout at $CHECKOUT"

# gh pr checks: 0 green, 8 pending, else failed. Capture explicitly (set -e safe).
ci_rc=0
gh pr checks "$PR" --repo "$REPO" >/dev/null 2>&1 || ci_rc=$?
case "$ci_rc" in
  0) log "CI green for PR #$PR" ;;
  8) die "CI pending for PR #$PR" ;;
  *) die "CI not green for PR #$PR (exit $ci_rc)" ;;
esac

cd "$CHECKOUT"
git fetch origin --quiet
# The commit currently running is this checkout's HEAD; rollback returns to it.
LAST_GOOD="$(git rev-parse HEAD)"

gh pr ready "$PR" --repo "$REPO" >/dev/null 2>&1 || true
merge_rc=0
gh pr merge "$PR" --repo "$REPO" --merge --delete-branch >/dev/null 2>&1 || merge_rc=$?
[[ "$merge_rc" -eq 0 ]] || die "gh pr merge exited $merge_rc"

git fetch origin --quiet
git checkout main --quiet
git reset --hard origin/main --quiet
NEW="$(git rev-parse HEAD)"
log "merged PR #$PR; main is $NEW (was $LAST_GOOD)"

# Smoke: a merge of two green branches can still be semantically broken. Typecheck the
# merged tree before we dare restart the live service onto it. Failure aborts WITHOUT
# restarting — the running service keeps serving the old code — and rolls main back.
npm ci --silent >/dev/null 2>&1 || true
if ! npm run typecheck >/dev/null 2>&1; then
  log "merged code fails typecheck — reverting main, NOT restarting"
  git revert --no-edit -m 1 "$NEW" >/dev/null 2>&1 || git reset --hard "$LAST_GOOD" --quiet
  git push origin main --quiet 2>/dev/null || git push --force-with-lease origin main --quiet
  die "PR #$PR merged but failed typecheck on main; reverted, service untouched"
fi

# Hand the restart to a detached transient unit outside our cgroup, so it survives the
# restart it is about to perform. --collect reaps the unit when it exits.
log "handing off restart to a detached unit"
systemd-run --user --collect --unit="selfship-$PR-$(date +%s)" \
  --setenv=NTFY_URL="${NTFY_URL:-}" --setenv=NTFY_TOPIC="${NTFY_TOPIC:-}" \
  --setenv=DISPATCHER_SELFSHIP_UNIT="$UNIT" --setenv=DISPATCHER_SELFSHIP_CHECKOUT="$CHECKOUT" \
  /bin/bash "$CHECKOUT/scripts/self-ship.sh" --restart "$LAST_GOOD" "$NEW"

log "merge + smoke ok; restart handed off for PR #$PR"
exit 0
