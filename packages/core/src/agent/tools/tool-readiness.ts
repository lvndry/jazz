/**
 * Decides which tools a run offers by asking each one whether it can run at all.
 *
 * Evaluated once when a run assembles its tool set, never per step: the declared tools stay
 * identical across the steps of a run, so a provider's cached prompt prefix survives them.
 * Across a conversation's turns the block changes only when a tool's readiness changes (a key
 * added or removed between two runs), which costs one cache miss.
 */

import { Effect, Option } from "effect";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import {
  ToolRegistryTag,
  type ToolReadinessRequirements,
  type ToolRegistry,
  type ToolUnreadyReason,
} from "@/core/interfaces/tool-registry";
import type { Agent } from "@/core/types";

export interface UnreadyTool {
  readonly name: string;
  readonly reason: ToolUnreadyReason;
  readonly remedy: string;
}

const REASON_LABELS: Record<ToolUnreadyReason, string> = {
  missing_credential: "no API key",
  not_configured: "not configured",
  not_connected: "not connected",
  unsupported_platform: "not supported on this machine",
};

export function describeUnreadyReason(reason: ToolUnreadyReason): string {
  return REASON_LABELS[reason];
}

/** Asks each named tool for its readiness. A check that fails to run leaves its tool offered. */
export function findUnreadyTools(
  toolRegistry: ToolRegistry,
  toolNames: readonly string[],
  agent: Agent,
): Effect.Effect<readonly UnreadyTool[], never, ToolReadinessRequirements> {
  return Effect.gen(function* () {
    const logger = yield* Effect.serviceOption(LoggerServiceTag);
    const unready: UnreadyTool[] = [];
    for (const name of toolNames) {
      const tool = yield* toolRegistry.getTool(name).pipe(Effect.option);
      if (Option.isNone(tool) || tool.value.ready === undefined) {
        continue;
      }
      const readiness = yield* tool.value.ready({ agent }).pipe(
        Effect.catchCause(() =>
          Effect.gen(function* () {
            if (Option.isSome(logger)) {
              yield* logger.value.warn("Tool readiness check failed; offering the tool", {
                toolName: name,
              });
            }
            return { ready: true } as const;
          }),
        ),
      );
      if (!readiness.ready) {
        unready.push({ name, reason: readiness.reason, remedy: readiness.remedy });
      }
    }
    return unready;
  });
}

/** The names left after removing every tool that is not ready, logging each omission once. */
export function withholdUnreadyTools(
  toolRegistry: ToolRegistry,
  toolNames: readonly string[],
  agent: Agent,
): Effect.Effect<readonly string[], never, ToolReadinessRequirements> {
  return Effect.gen(function* () {
    const unready = yield* findUnreadyTools(toolRegistry, toolNames, agent);
    if (unready.length === 0) {
      return toolNames;
    }
    const logger = yield* Effect.serviceOption(LoggerServiceTag);
    if (Option.isSome(logger)) {
      for (const entry of unready) {
        yield* logger.value.debug("Tool withheld: not ready", {
          agentId: agent.id,
          toolName: entry.name,
          reason: entry.reason,
        });
      }
    }
    const withheld = new Set(unready.map((entry) => entry.name));
    return toolNames.filter((name) => !withheld.has(name));
  });
}

/** What `/info` shows: every tool this agent is granted that a run would withhold. */
export function describeUnreadyAgentTools(
  agent: Agent,
  toolNames: readonly string[],
): Effect.Effect<readonly UnreadyTool[], never, ToolRegistry | ToolReadinessRequirements> {
  return Effect.gen(function* () {
    const toolRegistry = yield* ToolRegistryTag;
    return yield* findUnreadyTools(toolRegistry, toolNames, agent);
  });
}
