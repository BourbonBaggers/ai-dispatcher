/**
 * Agent-level pickup overrides: allow issues to request a specific agent (codex, claude, or opencode)
 * as a pickup-time override.
 *
 * When exactly one `agent:*` label is present, the dispatcher selects that agent and picks a
 * compatible model within that agent's supported routing options. When multiple agent labels
 * conflict, the issue is blocked with an explanatory comment.
 */

import { AGENT_LABELS, type DispatcherAgent } from "./labels.ts";
import {
  allDispatchableModels,
  type ModelEntry,
  modelExpectedCostScore,
  servesRoute,
  type ModelTier,
} from "./models.ts";
import { poolScarcityMultiplier, type CapacityAssessment } from "./capacity.ts";
import type { IssueCharacteristics } from "./routing.ts";

/**
 * Result of detecting and validating agent override labels.
 */
export interface AgentOverrideResult {
  /** The selected agent, or null if no override or conflict. */
  agent: DispatcherAgent | null;
  /** True if multiple conflicting agent labels were present. */
  hasConflict: boolean;
  /** Conflicting agent labels if hasConflict is true. */
  conflictingLabels?: string[];
}

/**
 * Detects whether an issue has a single agent override or conflicting agent labels.
 *
 * Returns:
 * - agent set, hasConflict false: single agent override
 * - agent null, hasConflict true: multiple conflicting labels
 * - agent null, hasConflict false: no agent override
 */
export function detectAgentOverride(labels: string[]): AgentOverrideResult {
  const agentLabels = labels.filter((l) => l in AGENT_LABELS);

  if (agentLabels.length === 0) {
    return { agent: null, hasConflict: false };
  }

  if (agentLabels.length > 1) {
    return {
      agent: null,
      hasConflict: true,
      conflictingLabels: agentLabels,
    };
  }

  const agent = AGENT_LABELS[agentLabels[0] as keyof typeof AGENT_LABELS];
  return { agent, hasConflict: false };
}

/**
 * Selects the best model for an agent given issue characteristics and capacity.
 *
 * Returns null if no eligible model exists (all capacity exhausted, or route unsupported).
 */
export function selectAgentModel(
  agent: DispatcherAgent,
  minimumTier: ModelTier,
  needsLargeContext: boolean,
  capacityByPool: Map<string, CapacityAssessment>,
): ModelEntry | null {
  // Get all models (including fallback-only) that match this agent.
  const agentModels = allDispatchableModels().filter(
    (m) => m.cli === agent && servesRoute(m, minimumTier),
  );

  // Filter by large-context if needed.
  const eligible = agentModels.filter((m) => !needsLargeContext || m.largeContext);

  if (eligible.length === 0) {
    return null;
  }

  // Pick the lowest scarcity-weighted cost among eligible models.
  // This matches the routing logic in routing.ts pickBest().
  const scored = eligible.map((model) => {
    const burn = modelExpectedCostScore(model, "effort:medium");
    const scarcity = poolScarcityMultiplier(capacityByPool.get(model.capacityPool), model.modelLabel);
    const capacity = capacityByPool.get(model.capacityPool);
    const hasCapacity = !capacity || capacity.status === "available";
    return { model, burn, scarcity, score: burn * scarcity, hasCapacity };
  });

  // Prioritize models with available capacity, then by cost.
  const available = scored.filter((s) => s.hasCapacity);
  const byScore = (available.length > 0 ? available : scored).sort(
    (a, b) => a.score - b.score || a.burn - b.burn,
  );

  return byScore[0]?.model ?? null;
}

/**
 * Generates a GitHub comment explaining the agent label conflict.
 *
 * Used to post one-time explanatory comments on blocked issues.
 */
export function conflictCommentFor(conflictingLabels: string[]): string {
  const labels = conflictingLabels.join(", ");
  return `Cannot dispatch: multiple agent override labels are present (${labels}). ` +
    `The dispatcher can select only one agent at pickup time. Please apply exactly one of: ` +
    `\`agent:codex\`, \`agent:claude\`, or \`agent:opencode\`.`;
}
