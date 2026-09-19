/** Per-agent-run plugin execution boundary; sessions never share registrations or mutable budget. */

import { Context, type Effect } from "effect";
import type { AgentRunMetrics } from "@/core/agent/metrics/agent-run-metrics";
import type {
  AdvisoryHookContracts,
  AdvisoryHookId,
  PolicyHookContracts,
  PolicyHookId,
  PluginRuntimeError,
} from "@/core/types/plugin";

export interface PluginSession {
  readonly runHook: <K extends AdvisoryHookId>(
    id: K,
    input: AdvisoryHookContracts[K]["input"],
  ) => Effect.Effect<AdvisoryHookContracts[K]["output"], PluginRuntimeError>;
  readonly runPolicyHook: <K extends PolicyHookId>(
    id: K,
    input: PolicyHookContracts[K]["input"],
  ) => Effect.Effect<PolicyHookContracts[K]["output"], PluginRuntimeError>;
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
