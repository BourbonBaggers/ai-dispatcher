#!/usr/bin/env bash
# dispatch-ci.sh — the launcher's read of a pull request's real CI verdict (#96).
#
# The bare `gh pr checks` exit code is not a CI verdict. A pull request opened a second
# ago has no checks registered yet, and gh reports that as exit 1 with "no checks
# reported on the '<branch>' branch" — the same exit code as a red check, and as any
# transport or auth failure. Judging by the exit code logged `CI FAILED` within a second
# of opening a PR, before CI had even started; the run then sat parked for a full poll
# interval although CI went green minutes later. So every read here asks for structured
# buckets (`--json`, which exits 0 whenever gh can read the checks at all), and only a
# check GitHub puts in the `fail` or `cancel` bucket — failure, error, timeout, action
# required, cancelled — is a failure.
#
# This file is sourced by dispatch-agent.sh. It lives on its own so the polling policy is
# unit-testable against a fake `gh` instead of a live pull request. The caller defines
# `event` (the control-channel logger) and sets CI_WAIT_SECONDS, CI_POLL_SECONDS, and
# CI_START_GRACE_SECONDS. src/github.ts applies the same rule to autoship's reads.

# ci_checks_verdict <gh_exit_code> <gh_stderr>
#
# Classifies one `gh pr checks --json name,bucket,link` read, whose stdout arrives on
# stdin. Prints the verdict on the first line:
#   pass     every check passed or was skipped
#   fail     a check failed, errored, timed out, needed action, or was cancelled
#   pending  a check is still queued or running
#   absent   no check is registered yet ("no checks reported", or an empty list)
#   unknown  gh could not answer (transport, auth, rate limit) or said something else
# then, for `fail`, one line per failing check. Check names come from workflow files the
# agent can edit, so every control character is stripped: a name can never end a line
# and forge a control record.
ci_checks_verdict() {
  CI_GH_EXIT="$1" CI_GH_STDERR="$2" node -e '
const { readFileSync } = require("node:fs");
const raw = readFileSync(0, "utf8").trim();
let checks = null;
try {
  checks = JSON.parse(raw);
} catch {}
if (!Array.isArray(checks)) {
  // gh prints no JSON at all when the head commit has no checks yet.
  if (/no checks reported/i.test(process.env.CI_GH_STDERR || "")) console.log("absent");
  // Exit 8 is the documented pending code of a gh that predates --json output.
  else console.log(process.env.CI_GH_EXIT === "8" ? "pending" : "unknown");
  process.exit(0);
}
if (checks.length === 0) {
  console.log("absent");
  process.exit(0);
}
const bucket = (check) => (check && typeof check === "object" ? check.bucket : undefined);
const clean = (value) =>
  String(value ?? "").replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim().slice(0, 200);
const failing = checks.filter((check) => bucket(check) === "fail" || bucket(check) === "cancel");
if (failing.length > 0) {
  console.log("fail");
  for (const check of failing.slice(0, 10)) {
    console.log([clean(check.name) || "(unnamed check)", "(" + bucket(check) + ")", clean(check.link)]
      .filter(Boolean)
      .join(" "));
  }
  if (failing.length > 10) console.log("+" + (failing.length - 10) + " more failing check(s)");
} else if (checks.some((check) => bucket(check) === "pending")) {
  console.log("pending");
} else if (checks.every((check) => bucket(check) === "pass" || bucket(check) === "skipping")) {
  console.log("pass");
} else {
  console.log("unknown");
}
'
}

# read_pr_ci <pr>
#
# One read of the PR's checks. Sets CI_VERDICT (see ci_checks_verdict) and, for `fail`,
# CI_FAILING_CHECKS (one sanitized line per failing check). Never fails the caller: an
# unreadable answer is `unknown`, never red CI.
read_pr_ci() {
  local pr="$1" out="" err="" err_file="" rc=0 verdict_lines=""
  CI_VERDICT="unknown"
  CI_FAILING_CHECKS=""
  err_file="$(mktemp "${TMPDIR:-/tmp}/dispatch-ci.XXXXXX")" || return 0
  out="$(gh pr checks "$pr" --json name,bucket,link 2>"$err_file")" || rc=$?
  err="$(head -c 4096 "$err_file" 2>/dev/null || true)"
  rm -f "$err_file"
  verdict_lines="$(printf '%s' "$out" | ci_checks_verdict "$rc" "$err")" || verdict_lines="unknown"
  CI_VERDICT="${verdict_lines%%$'\n'*}"
  if [[ "$verdict_lines" == *$'\n'* ]]; then
    CI_FAILING_CHECKS="${verdict_lines#*$'\n'}"
  fi
  case "$CI_VERDICT" in
    pass|fail|pending|absent|unknown) ;;
    *) CI_VERDICT="unknown"; CI_FAILING_CHECKS="" ;;
  esac
  return 0
}

# wait_for_pr_ci <pr>
#
# Polls every CI_POLL_SECONDS until CI resolves or CI_WAIT_SECONDS pass. Sets CI_STATE:
#   pass     green
#   fail     a real failed/cancelled check (CI_FAILING_CHECKS names it) — returns at once
#   absent   no check registered for CI_START_GRACE_SECONDS: CI did not start
#   pending  still unresolved (or unreadable) at the deadline
# Absent, pending, and unreadable reads all keep waiting. The grace clock measures one
# continuous absence: it starts at the first empty read and restarts if checks appear and
# then vanish again (a new head commit), and an unreadable read neither starts nor stops it.
wait_for_pr_ci() {
  local pr="$1" deadline=$(( SECONDS + CI_WAIT_SECONDS )) absent_since=""
  CI_STATE="pending"
  while :; do
    read_pr_ci "$pr"
    case "$CI_VERDICT" in
      pass|fail)
        CI_STATE="$CI_VERDICT"
        return 0
        ;;
      absent)
        if [[ -z "$absent_since" ]]; then
          absent_since="$SECONDS"
          event "no checks registered on $pr yet — waiting up to ${CI_START_GRACE_SECONDS}s for CI to start"
        fi
        if (( SECONDS - absent_since >= CI_START_GRACE_SECONDS )); then
          CI_STATE="absent"
          return 0
        fi
        ;;
      pending)
        absent_since=""
        ;;
    esac
    (( SECONDS < deadline )) || break
    sleep "$CI_POLL_SECONDS"
  done
  if [[ "$CI_VERDICT" == "absent" ]]; then
    CI_STATE="absent"
  fi
  return 0
}

# report_pr_ci <pr>
#
# Logs the state wait_for_pr_ci reached. Each state has its own wording so the run
# timeline never shows `CI FAILED` for a PR whose CI simply had not started.
report_pr_ci() {
  local pr="$1" line=""
  case "$CI_STATE" in
    pass)
      event "CI PASSED — the PR is green and ready for autoship"
      ;;
    fail)
      event "CI FAILED — this run did not produce mergeable work:"
      while IFS= read -r line; do
        if [[ -n "$line" ]]; then event "  $line"; fi
      done <<< "$CI_FAILING_CHECKS"
      ;;
    absent)
      event "CI DID NOT START — no checks registered on $pr within ${CI_START_GRACE_SECONDS}s; the dispatcher re-checks it without relaunching the agent"
      ;;
    *)
      if [[ "$CI_VERDICT" == "unknown" ]]; then
        event "CI state unreadable after ${CI_WAIT_SECONDS}s — outcome unverified"
      else
        event "CI still running after ${CI_WAIT_SECONDS}s — outcome unverified"
      fi
      ;;
  esac
}
