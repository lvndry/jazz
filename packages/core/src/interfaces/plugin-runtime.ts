/** Per-agent-run plugin execution boundary; sessions never share registrations or mutable budget. */

import { Context, type Effect } from "effect";
import type { AgentRunMetrics } from "@/core/agent/metrics/agent-run-metrics";
import type {
  CompactToolsInput,
  CompactToolsOutcome,
  PolicyHookContracts,
  PolicyHookId,
  PluginRuntimeError,
  SkillRouteInput,
  SkillRouteOutcome,
} from "@/core/types/plugin";

export interface PluginSession {
  readonly runHook: (
    id: "route.skills",
    input: SkillRouteInput,
  ) => Effect.Effect<SkillRouteOutcome>;
  readonly runPolicyHook: <K extends PolicyHookId>(
    id: K,
    input: PolicyHookContracts[K]["input"],
  ) => Effect.Effect<PolicyHookContracts[K]["output"]>;
  readonly runCompactTools: (input: CompactToolsInput) => Effect.Effect<CompactToolsOutcome>;
  readonly close: () => Effect.Effect<void>;
}

export interface PluginSessionOptions {
  readonly agentId: string;
  readonly metrics: AgentRunMetrics;
  readonly hookTimeoutMs?: number;
  readonly maxCostUSD?: number;
  readonly currentRunCostUSD?: () => number | undefined;
}

export interface PluginRuntimeService {
  readonly openSession: (
    options: PluginSessionOptions,
  ) => Effect.Effect<PluginSession, PluginRuntimeError>;
}

export const PluginRuntimeServiceTag = Context.GenericTag<PluginRuntimeService>(
  "@jazz/core/PluginRuntimeService",
);
