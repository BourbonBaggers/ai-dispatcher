import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRepoSlug, parseCliConfig, parseShipCliConfig } from "../src/config.ts";

test("parseRepoSlug accepts a canonical owner/repository", () => {
  const result = parseRepoSlug("BourbonBaggers/internal-tools");
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.value, {
    owner: "BourbonBaggers",
    repo: "internal-tools",
    slug: "BourbonBaggers/internal-tools",
  });
});

test("parseRepoSlug rejects a missing repository", () => {
  for (const bad of [undefined, null, "", "   "]) {
    const result = parseRepoSlug(bad);
    assert.equal(result.ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test("parseRepoSlug rejects malformed identifiers", () => {
  const bad = [
    "internal-tools", // no owner
    "owner/repo/extra", // too many segments
    "owner//repo", // empty middle
    "-owner/repo", // leading hyphen in owner
    "owner-/repo", // trailing hyphen in owner
    "own er/repo", // space
    "owner/re po", // space in repo
    "owner/.", // dot repo
    "owner/..", // dotdot repo
    "owner/re$po", // invalid char
  ];
  for (const value of bad) {
    const result = parseRepoSlug(value);
    assert.equal(result.ok, false, `expected ${value} to be rejected`);
  }
});

test("parseRepoSlug accepts dots, underscores and hyphens in the repo name", () => {
  for (const value of ["a/b", "Org123/my_repo.js", "x-y/z-1.2_3"]) {
    assert.equal(parseRepoSlug(value).ok, true, `expected ${value} accepted`);
  }
});

test("parseCliConfig requires --repo (or DISPATCHER_REPO) and never falls back", () => {
  const result = parseCliConfig([], {
    DISPATCHER_REPO_DIR: "/mirror",
    DISPATCHER_WORKTREE_DIR: "/worktrees",
  });
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /repository is required|Invalid repository/);
});

test("parseCliConfig fails fast on a malformed --repo before anything else", () => {
  const result = parseCliConfig(["--repo", "not-a-slug"], {
    DISPATCHER_REPO_DIR: "/mirror",
    DISPATCHER_WORKTREE_DIR: "/worktrees",
  });
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /Invalid repository/);
});

test("parseCliConfig resolves a full config with the flag winning over env", () => {
  const result = parseCliConfig(["--repo", "acme/widgets", "--once", "--interval", "120"], {
    DISPATCHER_REPO: "other/thing",
    DISPATCHER_REPO_DIR: "/mirror",
    DISPATCHER_STATE_DIR: "/state",
    DISPATCHER_WORKTREE_DIR: "/worktrees",
    DISPATCHER_MAX_RUNTIME_MINUTES: "45",
    DISPATCHER_ISSUE_AUTHOR_AUTH_MODE: "author-allowlist",
    DISPATCHER_TRUSTED_ISSUE_AUTHORS: "BourbonBaggers",
  });
  assert.equal(result.ok, true);
  const c = result.config!;
  assert.equal(c.repo.slug, "acme/widgets"); // flag wins over DISPATCHER_REPO
  assert.equal(c.once, true);
  assert.equal(c.pollIntervalSeconds, 120);
  assert.equal(c.maxRuntimeMinutes, 45);
  assert.equal(c.autoshipTimeoutMinutes, 120);
  assert.equal(c.autoshipDeploymentDir, "/state/autoship-deployments/acme-widgets");
  assert.equal(c.dryRun, false);
  assert.equal(c.authorAuth.ok && c.authorAuth.mode, "author-allowlist");
});

test("parseCliConfig resolves the autoship timeout from env or flag", () => {
  const fromEnv = parseCliConfig(["--repo", "acme/widgets"], {
    DISPATCHER_REPO_DIR: "/mirror",
    DISPATCHER_WORKTREE_DIR: "/worktrees",
    DISPATCHER_AUTOSHIP_TIMEOUT_MINUTES: "75",
  });
  assert.equal(fromEnv.ok, true);
  assert.equal(fromEnv.config!.autoshipTimeoutMinutes, 75);

  const fromFlag = parseCliConfig(
    ["--repo", "acme/widgets", "--autoship-timeout-minutes", "180"],
    {
      DISPATCHER_REPO_DIR: "/mirror",
      DISPATCHER_WORKTREE_DIR: "/worktrees",
      DISPATCHER_AUTOSHIP_TIMEOUT_MINUTES: "75",
    },
  );
  assert.equal(fromFlag.ok, true);
  assert.equal(fromFlag.config!.autoshipTimeoutMinutes, 180);
});

test("parseCliConfig resolves the autoship deployment checkout from env or flag", () => {
  const fromEnv = parseCliConfig(["--repo", "acme/widgets"], {
    DISPATCHER_REPO_DIR: "/mirror",
    DISPATCHER_WORKTREE_DIR: "/worktrees",
    DISPATCHER_AUTOSHIP_DEPLOYMENT_DIR: "/deploy/env",
  });
  assert.equal(fromEnv.ok, true);
  assert.equal(fromEnv.config!.autoshipDeploymentDir, "/deploy/env");

  const fromFlag = parseCliConfig(
    ["--repo", "acme/widgets", "--autoship-deploy-dir", "/deploy/flag"],
    {
      DISPATCHER_REPO_DIR: "/mirror",
      DISPATCHER_WORKTREE_DIR: "/worktrees",
      DISPATCHER_AUTOSHIP_DEPLOYMENT_DIR: "/deploy/env",
    },
  );
  assert.equal(fromFlag.ok, true);
  assert.equal(fromFlag.config!.autoshipDeploymentDir, "/deploy/flag");
});

test("parseCliConfig falls back to DISPATCHER_REPO when no flag is given", () => {
  const result = parseCliConfig([], {
    DISPATCHER_REPO: "acme/widgets",
    DISPATCHER_REPO_DIR: "/mirror",
    DISPATCHER_WORKTREE_DIR: "/worktrees",
  });
  assert.equal(result.ok, true);
  assert.equal(result.config!.repo.slug, "acme/widgets");
});

test("parseCliConfig preserves explicit unrestricted author mode", () => {
  const result = parseCliConfig(["--repo", "acme/widgets", "--author-auth", "none"], {
    DISPATCHER_REPO_DIR: "/mirror",
    DISPATCHER_WORKTREE_DIR: "/worktrees",
  });

  assert.equal(result.ok, true);
  assert.equal(result.config!.authorAuth.ok && result.config!.authorAuth.mode, "none");
});

test("parseCliConfig resolves generated-conflict recovery settings from env", () => {
  const result = parseCliConfig(["--repo", "acme/widgets"], {
    DISPATCHER_REPO_DIR: "/mirror",
    DISPATCHER_WORKTREE_DIR: "/worktrees",
    DISPATCHER_GENERATED_CONFLICT_ALLOWLIST: "docs/memory.md,docs/researcher.md",
    DISPATCHER_GENERATED_CONFLICT_REGEN_CMD: "npm run docs:generate",
    DISPATCHER_GENERATED_CONFLICT_MAX_ATTEMPTS: "2",
    DISPATCHER_GENERATED_CONFLICT_CI_WAIT_SECONDS: "120",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.config!.generatedConflictAllowlist, [
    "docs/memory.md",
    "docs/researcher.md",
  ]);
  assert.equal(result.config!.generatedConflictRegenCmd, "npm run docs:generate");
  assert.equal(result.config!.generatedConflictMaxAttempts, 2);
  assert.equal(result.config!.generatedConflictCiWaitSeconds, 120);
});

test("parseCliConfig defaults ciSelfHealMaxAttempts to 2", () => {
  const result = parseCliConfig(["--repo", "acme/widgets"], {
    DISPATCHER_REPO_DIR: "/mirror",
    DISPATCHER_WORKTREE_DIR: "/worktrees",
  });

  assert.equal(result.ok, true);
  assert.equal(result.config!.ciSelfHealMaxAttempts, 2);
});

test("parseCliConfig resolves ciSelfHealMaxAttempts from env", () => {
  const result = parseCliConfig(["--repo", "acme/widgets"], {
    DISPATCHER_REPO_DIR: "/mirror",
    DISPATCHER_WORKTREE_DIR: "/worktrees",
    DISPATCHER_CI_SELF_HEAL_MAX_ATTEMPTS: "3",
  });

  assert.equal(result.ok, true);
  assert.equal(result.config!.ciSelfHealMaxAttempts, 3);
});

test("parseCliConfig defaults ciEscalationModel to claude-opus-4-8", () => {
  const result = parseCliConfig(["--repo", "acme/widgets"], {
    DISPATCHER_REPO_DIR: "/mirror",
    DISPATCHER_WORKTREE_DIR: "/worktrees",
  });

  assert.equal(result.ok, true);
  assert.equal(result.config!.ciEscalationModel, "claude-opus-4-8");
});

test("parseCliConfig resolves ciEscalationModel from env", () => {
  const result = parseCliConfig(["--repo", "acme/widgets"], {
    DISPATCHER_REPO_DIR: "/mirror",
    DISPATCHER_WORKTREE_DIR: "/worktrees",
    DISPATCHER_CI_ESCALATION_MODEL: "claude-sonnet-5",
  });

  assert.equal(result.ok, true);
  assert.equal(result.config!.ciEscalationModel, "claude-sonnet-5");
});

test("parseCliConfig resolves blocked queue audit defaults", () => {
  const result = parseCliConfig(["--repo", "acme/widgets"], {
    DISPATCHER_REPO_DIR: "/mirror",
    DISPATCHER_WORKTREE_DIR: "/worktrees",
  });

  assert.equal(result.ok, true);
  assert.equal(result.config!.blockedQueueAuditModel, "claude-sonnet-5");
  assert.equal(result.config!.blockedQueueAuditEffortLabel, "effort:low");
  assert.equal(result.config!.blockedQueueAuditMaxCandidates, 3);
});

test("parseCliConfig resolves blocked queue audit settings from env or flags", () => {
  const fromEnv = parseCliConfig(["--repo", "acme/widgets"], {
    DISPATCHER_REPO_DIR: "/mirror",
    DISPATCHER_WORKTREE_DIR: "/worktrees",
    DISPATCHER_BLOCKED_QUEUE_AUDIT_MODEL: "gpt-5.5",
    DISPATCHER_BLOCKED_QUEUE_AUDIT_EFFORT: "effort:medium",
    DISPATCHER_BLOCKED_QUEUE_AUDIT_MAX_CANDIDATES: "5",
  });
  assert.equal(fromEnv.ok, true);
  assert.equal(fromEnv.config!.blockedQueueAuditModel, "gpt-5.5");
  assert.equal(fromEnv.config!.blockedQueueAuditEffortLabel, "effort:medium");
  assert.equal(fromEnv.config!.blockedQueueAuditMaxCandidates, 5);

  const fromFlags = parseCliConfig(
    [
      "--repo",
      "acme/widgets",
      "--blocked-audit-model",
      "claude-sonnet-5",
      "--blocked-audit-effort",
      "effort:high",
      "--blocked-audit-max",
      "2",
    ],
    {
      DISPATCHER_REPO_DIR: "/mirror",
      DISPATCHER_WORKTREE_DIR: "/worktrees",
      DISPATCHER_BLOCKED_QUEUE_AUDIT_MODEL: "gpt-5.5",
      DISPATCHER_BLOCKED_QUEUE_AUDIT_EFFORT: "effort:medium",
      DISPATCHER_BLOCKED_QUEUE_AUDIT_MAX_CANDIDATES: "5",
    },
  );
  assert.equal(fromFlags.ok, true);
  assert.equal(fromFlags.config!.blockedQueueAuditModel, "claude-sonnet-5");
  assert.equal(fromFlags.config!.blockedQueueAuditEffortLabel, "effort:high");
  assert.equal(fromFlags.config!.blockedQueueAuditMaxCandidates, 2);
});

test("parseCliConfig leaves invalid blocked queue audit model to fail closed at scan time", () => {
  const result = parseCliConfig(["--repo", "acme/widgets"], {
    DISPATCHER_REPO_DIR: "/mirror",
    DISPATCHER_WORKTREE_DIR: "/worktrees",
    DISPATCHER_BLOCKED_QUEUE_AUDIT_MODEL: "claude-opus-4-8",
  });

  assert.equal(result.ok, true);
  assert.equal(result.config!.blockedQueueAuditModel, "claude-opus-4-8");
});

test("parseCliConfig rejects an unknown ciEscalationModel", () => {
  const result = parseCliConfig(["--repo", "acme/widgets"], {
    DISPATCHER_REPO_DIR: "/mirror",
    DISPATCHER_WORKTREE_DIR: "/worktrees",
    DISPATCHER_CI_ESCALATION_MODEL: "gpt-3-davinci",
  });

  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /Invalid DISPATCHER_CI_ESCALATION_MODEL/);
});

test("parseCliConfig fails closed inside author-allowlist mode", () => {
  const missing = parseCliConfig(["--repo", "acme/widgets"], {
    DISPATCHER_REPO_DIR: "/mirror",
    DISPATCHER_WORKTREE_DIR: "/worktrees",
  });
  assert.equal(missing.ok, true);
  assert.equal(missing.config!.authorAuth.ok, false);

  const malformed = parseCliConfig(
    [
      "--repo",
      "acme/widgets",
      "--author-auth",
      "author-allowlist",
      "--trusted-authors",
      "bad login",
    ],
    {
      DISPATCHER_REPO_DIR: "/mirror",
      DISPATCHER_WORKTREE_DIR: "/worktrees",
    },
  );
  assert.equal(malformed.ok, true);
  assert.equal(malformed.config!.authorAuth.ok, false);
});

test("parseCliConfig requires repo-dir and worktree-dir", () => {
  const noRepoDir = parseCliConfig(["--repo", "a/b"], { DISPATCHER_WORKTREE_DIR: "/w" });
  assert.equal(noRepoDir.ok, false);
  assert.match(noRepoDir.message ?? "", /mirror checkout is required/);

  const noWorktree = parseCliConfig(["--repo", "a/b"], { DISPATCHER_REPO_DIR: "/m" });
  assert.equal(noWorktree.ok, false);
  assert.match(noWorktree.message ?? "", /worktree directory is required/);
});

test("parseCliConfig rejects an invalid log level", () => {
  const result = parseCliConfig(["--repo", "a/b", "--log-level", "loud"], {
    DISPATCHER_REPO_DIR: "/m",
    DISPATCHER_WORKTREE_DIR: "/w",
  });
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /Invalid --log-level/);
});

test("parseCliConfig --help returns usage", () => {
  const result = parseCliConfig(["--help"], {});
  assert.equal(result.ok, true);
  assert.equal(result.help, true);
  assert.match(result.message ?? "", /Usage:/);
});

// ── parseShipCliConfig ──────────────────────────────────────────────────────────────

test("parseShipCliConfig requires --repo", () => {
  const result = parseShipCliConfig(["--pr", "1"], { DISPATCHER_AUTOSHIP_CMD: "ship.sh" });
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /repository is required|Invalid repository/);
});

test("parseShipCliConfig requires --pr as a positive integer", () => {
  const missing = parseShipCliConfig(["--repo", "acme/widgets"], {
    DISPATCHER_AUTOSHIP_CMD: "ship.sh",
  });
  assert.equal(missing.ok, false);
  assert.match(missing.message ?? "", /--pr is required/);

  const malformed = parseShipCliConfig(["--repo", "acme/widgets", "--pr", "abc"], {
    DISPATCHER_AUTOSHIP_CMD: "ship.sh",
  });
  assert.equal(malformed.ok, false);
  assert.match(malformed.message ?? "", /--pr must be a positive integer/);

  const zero = parseShipCliConfig(["--repo", "acme/widgets", "--pr", "0"], {
    DISPATCHER_AUTOSHIP_CMD: "ship.sh",
  });
  assert.equal(zero.ok, false);
});

test("parseShipCliConfig accepts an optional --issue and defaults it to null", () => {
  const withoutIssue = parseShipCliConfig(["--repo", "acme/widgets", "--pr", "42"], {
    DISPATCHER_AUTOSHIP_CMD: "ship.sh",
  });
  assert.equal(withoutIssue.ok, true);
  assert.equal(withoutIssue.config?.issue, null);

  const withIssue = parseShipCliConfig(["--repo", "acme/widgets", "--pr", "42", "--issue", "7"], {
    DISPATCHER_AUTOSHIP_CMD: "ship.sh",
  });
  assert.equal(withIssue.ok, true);
  assert.equal(withIssue.config?.issue, 7);
});

test("parseShipCliConfig rejects a malformed --issue", () => {
  const result = parseShipCliConfig(
    ["--repo", "acme/widgets", "--pr", "42", "--issue", "nope"],
    { DISPATCHER_AUTOSHIP_CMD: "ship.sh" },
  );
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /--issue must be a positive integer/);
});

test("parseShipCliConfig requires DISPATCHER_AUTOSHIP_CMD -- there is nothing to ship with otherwise", () => {
  const result = parseShipCliConfig(["--repo", "acme/widgets", "--pr", "42"], {});
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /DISPATCHER_AUTOSHIP_CMD must be configured/);
});

test("parseShipCliConfig defaults the deployment checkout the same way the loop config does", () => {
  const result = parseShipCliConfig(["--repo", "acme/widgets", "--pr", "42"], {
    DISPATCHER_AUTOSHIP_CMD: "ship.sh",
    DISPATCHER_STATE_DIR: "/state",
  });
  assert.equal(result.ok, true);
  assert.equal(result.config?.autoshipDeploymentDir, "/state/autoship-deployments/acme-widgets");
});

test("parseShipCliConfig --autoship-deploy-dir overrides the computed default", () => {
  const result = parseShipCliConfig(
    ["--repo", "acme/widgets", "--pr", "42", "--autoship-deploy-dir", "/custom/deploy"],
    { DISPATCHER_AUTOSHIP_CMD: "ship.sh" },
  );
  assert.equal(result.ok, true);
  assert.equal(result.config?.autoshipDeploymentDir, "/custom/deploy");
});

test("parseShipCliConfig --help returns usage without requiring --repo/--pr", () => {
  const result = parseShipCliConfig(["--help"], {});
  assert.equal(result.ok, true);
  assert.equal(result.help, true);
  assert.match(result.message ?? "", /Usage:/);
});
