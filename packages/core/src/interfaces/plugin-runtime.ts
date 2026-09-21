/** Per-agent-run plugin execution boundary; sessions never share registrations or mutable budget. */

import { Context, type Effect } from "effect";
import type { AgentRunMetrics } from "@/core/agent/metrics/agent-run-metrics";
import type {
  AdvisoryHookContracts,
  AdvisoryHookId,
  LifecycleEvent,
  PluginCommandInfo,
  PluginCommandResult,
  PluginPersonaInfo,
  PluginRuntimeError,
  PluginSkillInfo,
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
  /** Deliver a lifecycle event to every plugin subscribed to it. Fire-and-forget; never fails. */
  readonly emitLifecycle: (event: LifecycleEvent) => Effect.Effect<void>;
  readonly close: () => Effect.Effect<void>;
}

export interface PluginSessionOptions {
  readonly agentId: string;
  /**
   * Metrics sink for decision-provider cost accounting. Optional: a session that only serves tools,
   * commands, or lifecycle events never invokes a decision provider, so it needs none.
   */
  readonly metrics?: AgentRunMetrics;
  readonly hookTimeoutMs?: number;
  readonly maxCostUSD?: number;
  readonly currentRunCostUSD?: () => number | undefined;
  /**
   * Writes raw bytes to the user's controlling terminal, passed to lifecycle handlers as
   * `writeTerminalSequence`. Defaults to writing the controlling terminal directly (so it survives a
   * fullscreen TUI that owns stdout); the host can override it to route through its own output.
   */
  readonly writeTerminalSequence?: (data: string) => void;
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
  /**
   * Personas contributed by all enabled plugins (global), for folding into the persona list.
   * Pure manifest data — no code is imported. Resolves to an empty list on any failure.
   */
  readonly listAllPersonas: () => Effect.Effect<readonly PluginPersonaInfo[]>;
  /**
   * Skills contributed by all enabled plugins (global), for folding into the skill index and
   * serving their content on load. Pure manifest data. Resolves to an empty list on any failure.
   */
  readonly listAllSkills: () => Effect.Effect<readonly PluginSkillInfo[]>;
  /**
   * Deliver a lifecycle event to enabled plugins that subscribed to it. Fire-and-forget and
   * fail-open — never blocks or breaks the run. Reuses one long-lived session per agent so frequent
   * events do not reload modules.
   */
  readonly emitLifecycleEvent: (event: LifecycleEvent) => Effect.Effect<void>;
  readonly hasNotificationPlugin: () => Effect.Effect<boolean>;
}

export const PluginRuntimeServiceTag = Context.GenericTag<PluginRuntimeService>(
  "@jazz/core/PluginRuntimeService",
);
