/** Per-agent-run plugin execution boundary; sessions never share registrations or mutable budget. */

import { Context, type Effect } from "effect";
import type { AgentRunMetrics } from "@/core/agent/metrics/agent-run-metrics";
import type {
  AdvisoryHookContracts,
  AdvisoryHookId,
  PluginCommandInfo,
  PluginCommandResult,
  PluginRuntimeError,
  PluginToolInfo,
  PluginToolResult,
} from "@/core/types/plugin";

export interface PluginSession {
  readonly runHook: <K extends AdvisoryHookId>(
    id: K,
    input: AdvisoryHookContracts[K]["input"],
  ) => Effect.Effect<AdvisoryHookContracts[K]["output"]>;
  /** Tools contributed by the plugins in this session, with their manifest declarations. */
  readonly listTools: () => readonly PluginToolInfo[];
  /** Invoke a registered plugin tool; always resolves (a failure returns an error result). */
  readonly runTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Effect.Effect<PluginToolResult>;
  /** Slash commands contributed by the plugins in this session, with their declarations. */
  readonly listCommands: () => readonly PluginCommandInfo[];
  /** Run a registered plugin command; always resolves ({} means no message for the agent). */
  readonly runCommand: (
    name: string,
    args: readonly string[],
  ) => Effect.Effect<PluginCommandResult>;
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
  /**
   * The tools an agent's enabled plugins contribute, for registration into the tool set.
   * Resolves to an empty list on any failure — plugin tools are additive, never fatal.
   */
  readonly listAgentTools: (agentId: string) => Effect.Effect<readonly PluginToolInfo[]>;
  /**
   * Run one of an agent's plugin tools by name. Always resolves; a failure or unknown tool
   * returns an error result, so a plugin tool can never crash the run.
   */
  readonly runAgentTool: (
    agentId: string,
    name: string,
    args: Record<string, unknown>,
  ) => Effect.Effect<PluginToolResult>;
  /** The slash commands an agent's enabled plugins contribute, for registration at chat startup. */
  readonly listAgentCommands: (agentId: string) => Effect.Effect<readonly PluginCommandInfo[]>;
  /** Run one of an agent's plugin commands by name. Always resolves ({} means nothing to send). */
  readonly runAgentCommand: (
    agentId: string,
    name: string,
    args: readonly string[],
  ) => Effect.Effect<PluginCommandResult>;
}

export const PluginRuntimeServiceTag = Context.GenericTag<PluginRuntimeService>(
  "@jazz/core/PluginRuntimeService",
);
