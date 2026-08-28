import type { Effect } from "effect";
import type { ProviderName } from "@/core/constants/models";
import type { GeneratedArtifact } from "@/core/types/artifact";
import type { MessageAttachment } from "@/core/types/attachment";
import type { ChatMessage, ConversationMessages } from "@/core/types/message";
import type { DisplayConfig } from "@/core/types/output";
import type {
  ApprovalOutcome,
  AutoApprovePolicy,
  ToolCall,
  ToolDefinition,
  ToolExecutionContext,
} from "@/core/types/tools";
import type { Agent } from "../types";
import type { createAgentRunMetrics } from "./metrics/agent-run-metrics";

/**
 * Configuration options for running an agent conversation.
 *
 * This interface defines all the parameters needed to execute a single turn of an agent conversation,
 * including the agent configuration, user input, conversation context, and execution settings.
 *
 */
export interface AgentRunnerOptions {
  /**
   * The agent to execute.
   */
  readonly agent: Agent;
  /**
   * The user's input or query for this conversation turn.
   * This is the primary instruction that the agent will process and respond to.
   */
  readonly userInput: string;
  /**
   * Attachments placed directly on this run's first user message.
   *
   * For paths a caller has already resolved and validated — model-companion
   * delegation being the reason this exists. They ride outside path-scanning
   * (`resolveUserInputAttachments`), which stays reserved for text the user typed;
   * kinds the target model cannot ingest are dropped with an explanatory note,
   * same as scanned ones.
   */
  readonly initialAttachments?: readonly MessageAttachment[];
  /**
   * Which conversation this turn belongs to.
   *
   * Generated when absent. The same id across turns is what gives a caller continuity, and
   * it is also what groups the run's logs and its todos — there used to be a second field
   * for that, bound once per terminal sitting, which is how starting a new conversation
   * ended up inheriting the previous one's todo list.
   */
  readonly conversationId?: string;
  /**
   * If true, this is an internal sub-agent run (e.g., summarization).
   * UI elements like thinking indicators will be suppressed.
   */
  readonly internal?: boolean;
  /**
   * If set, the streaming renderer routes its reasoning + response deltas
   * into the named ephemeral live region instead of the global scrollback
   * pending buffer. Used by sub-agents so their output stays bounded inside
   * the parent's live panel and never interleaves with the parent's response.
   */
  readonly ephemeralRegionId?: string;
  /**
   * Maximum number of iterations (agent reasoning loops) allowed for this run.
   * Each iteration may involve tool calls and LLM responses.
   * If not specified, falls back to `maxIterations` in app config and then to
   * `DEFAULT_MAX_ITERATIONS`.
   */
  readonly maxIterations?: number;
  /**
   * Full conversation history to date, including prior assistant, user, and tool messages.
   * Use this to preserve context across turns (e.g., approval flows, multi-step tasks).
   */
  readonly conversationHistory?: ChatMessage[];
  /**
   * Override streaming behavior (from --stream or --no-stream CLI flags).
   * - `true`: Force streaming on - responses are rendered in real-time as they're generated
   * - `false`: Force streaming off - wait for complete response before rendering
   * - `undefined`: Use auto-detection based on environment and configuration (default)
   */
  readonly stream?: boolean;
  /**
   * Auto-approve policy for tool execution in workflows.
   * When set, tools matching the policy will be auto-approved without user interaction.
   * - `true` or `"high-risk"`: Auto-approve all tools
   * - `"low-risk"`: Auto-approve read-only and low-risk tools
   * - `"read-only"`: Auto-approve only read-only tools
   * - `undefined`: Safe mode — auto-approve read-only and low-risk *where a
   *   human can be prompted*; approve nothing on an unattended surface
   *
   * Can also be a getter function for real-time policy updates (e.g., Shift+Tab toggle).
   */
  readonly autoApprovePolicy?: AutoApprovePolicy | (() => AutoApprovePolicy | undefined);
  /**
   * Shell commands to auto-approve for execute_command tool (prefix match).
   */
  readonly autoApprovedCommands?: readonly string[];
  /**
   * Callback invoked when the user chooses "always approve" for a specific command
   * from the approval prompt. Returns an Effect for async persistence.
   */
  readonly onAutoApproveCommand?: (command: string) => Effect.Effect<void>;
  /**
   * Tool names to auto-approve for this session (e.g. "edit_file", "write_file").
   * When a tool name appears in this list, it will be auto-approved without prompting.
   */
  readonly autoApprovedTools?: readonly string[];
  /**
   * Hard ceiling on this run's toolset, intersected after personas and built-in
   * categories resolve. Sub-agents inherit their parent's tools this way.
   */
  readonly toolAllowlist?: readonly string[];
  /**
   * Withhold the tools that solicit an answer from a human (`ask_user_question`,
   * `ask_file_picker`), so the model is never offered a way to block on somebody
   * who isn't there.
   *
   * Interactive surfaces leave this off. A headless run sets it unless its caller
   * can relay a question and write the answer back: a CI or cron run that stops to
   * ask something hangs until its timeout for nobody.
   */
  readonly withholdInteractiveTools?: boolean;
  /**
   * Park instead of declining when a gated tool needs an approval this process cannot
   * obtain. Requires a durable `RunStore` in the layer, since the record is what a later
   * process resumes from. Off by default, and never set for sub-agent runs.
   */
  readonly parkWhenUnattended?: boolean;
  /**
   * Approvals already answered, keyed by `toolCallId`. Set when resuming a parked run.
   */
  readonly resolvedApprovals?: ReadonlyMap<string, ApprovalOutcome>;
  /**
   * This run is continuing a parked one. Its history already ends mid-turn, so no user
   * message is appended.
   */
  readonly isResume?: boolean;
  /**
   * Continue recording under an existing run id instead of the fresh one the metrics
   * mint. Set when resuming, so the parked record is the one that finishes.
   */
  readonly runId?: string;
  /**
   * Tool calls left unanswered by a parked turn, executed before the loop's first LLM
   * call. Paired with `resolvedApprovals`, which carries the answer they were waiting on.
   */
  readonly pendingToolCalls?: readonly ToolCall[];
  /** How many sub-agent levels sit above this run. 0 at the top level. */
  readonly subagentDepth?: number;
  /**
   * Callback invoked when the user chooses "always approve" for a specific tool
   * from the approval prompt.
   */
  readonly onAutoApproveTool?: (toolName: string) => void;
  /**
   * Optional callback polled between tool-call batches (before the next LLM
   * call) to inject a queued user message into the running conversation.
   * When it returns a non-empty string, that string is appended as a user
   * message so the agent can incorporate mid-run guidance immediately.
   * Not called for internal (sub-agent) runs.
   */
  readonly checkQueuedMessage?: () => string | undefined;
  /**
   * IANA timezone (e.g. "Europe/Paris") for this run, copied into the tool
   * execution context so tools like add_reminder can resolve "now" in the
   * caller's local time without asking the model to supply a timezone string.
   * Defaults to "UTC" (via ToolExecutionContext) when unset.
   */
  readonly timezone?: string;
  /**
   * Surface this run is replying on — copied into the system prompt so the model knows
   * whether it's in a terminal, a chat app, or posting a PR comment. Defaults to "cli".
   */
  readonly platform?: "cli" | "telegram" | "discord" | "github";
  /**
   * When true, withhold the `manage_memory` tool for this run so nothing gets
   * written to the agent's long-term memory. Unrelated to `ephemeralRegionId`
   * above (that one is a streaming-UI concept) — this is the "no persistence"
   * flag behind `jazz run --ephemeral`.
   */
  readonly disablePersistence?: boolean;
  /**
   * True when `userInput` carries a literal task contract (exact output format, step
   * ordering) rather than an ordinary conversational turn — e.g. a workflow's prompt.
   * The initial user message it becomes is tagged `kind: "task"` so compaction pins
   * it instead of summarizing it away, which an LLM-generated summary is not obliged
   * to preserve verbatim.
   */
  readonly pinInitialMessage?: boolean;
}

/**
 * Response returned from executing an agent conversation.
 *
 * Contains the agent's response content, conversation metadata, tool execution results,
 * and the full message history for this turn. Use this to:
 * - Display the agent's response to the user
 * - Pass conversation history to subsequent turns
 * - Inspect tool calls and results for debugging or auditing
 * - Track conversation state and context
 */
export interface AgentResponse {
  /**
   * The agent's text response content.
   * This is the final answer or message from the agent after processing the user input
   * and executing any necessary tools. May be empty if the agent only performed tool calls
   * without providing a text response.
   */
  readonly content: string;
  /**
   * Reasoning / chain-of-thought text emitted by the model, when the provider
   * exposes it as a separate channel. Populated when the response carried
   * `reasoning_content` (e.g. llama.cpp with `--jinja`). Useful for callers
   * that want to distinguish "the model thought" from "the model answered".
   */
  readonly reasoning?: string;
  /**
   * The conversation identifier for this run.
   * This will be the same as the `conversationId` provided in options, or a newly generated
   * ID if one wasn't provided. Use this to track and correlate related conversation turns.
   */
  readonly conversationId: string;
  /**
   * Optional array of tool calls made by the agent during this turn.
   * Present when the agent decided to use tools to accomplish the task.
   * Each tool call includes the tool name, arguments, and call ID.
   *
   */
  readonly toolCalls?: ToolCall[];
  /**
   * Optional map of tool execution results, keyed by tool name.
   * Present when tools were executed during this turn.
   * Contains the results returned by each tool, which may include data, errors, or status information.
   *
   */
  readonly toolResults?: Record<string, unknown>;
  /**
   * Files produced during this run, in the order they were made.
   *
   * A list rather than a map because `toolResults` is keyed by tool name and keeps only the last
   * call — fine for inspecting what a tool returned, lossy for artifacts, where calling
   * `create_pdf` twice must yield two files.
   */
  readonly artifacts?: readonly GeneratedArtifact[];
  /**
   * Indicates tools were provided but disabled for the selected model.
   */
  readonly toolsDisabled?: boolean;
  /**
   * The full message list used for this turn, including system, user, assistant, and tool messages.
   * Pass this back on the next turn to retain context across approvals and multi-step tasks.
   *
   * This array contains the complete conversation state, including:
   * - System messages (agent instructions)
   * - User messages (input)
   * - Assistant messages (agent responses)
   * - Tool messages (tool execution results)
   */
  readonly messages?: ChatMessage[] | undefined;
  /**
   * Token usage for this turn (prompt + completion).
   * Used by the chat session to accumulate session cost for /cost.
   */
  readonly usage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly cacheReadTokens?: number;
  };
  /** Total estimated cost for the full run in USD. Populated when model pricing is available. */
  readonly costUSD?: number;
  /**
   * True when some token spend in this run — the run's own turns or any
   * sub-agent's — lacked pricing metadata, so `costUSD` understates real
   * spend. Cost-capped callers must treat such runs as unpriced.
   */
  readonly costIncomplete?: boolean;
}

/**
 * Default display configuration (applies to both modes)
 */
export const DEFAULT_DISPLAY_CONFIG: DisplayConfig = {
  showReasoning: true,
  showToolExecution: true,
  collapseReasoning: true,
  mode: "hybrid",
};

/**
 * Common initialization data for agent runs
 */
export interface AgentRunContext {
  readonly agent: Agent;
  readonly actualConversationId: string;
  readonly context: ToolExecutionContext;
  readonly tools: ToolDefinition[];
  readonly expandedToolNames: readonly string[];
  readonly messages: ConversationMessages;
  readonly runMetrics: ReturnType<typeof createAgentRunMetrics>;
  readonly provider: ProviderName;
  readonly model: string;
  readonly connectedMCPServers: readonly string[];
  readonly maxRetries?: number;
  /** Iteration budget, already resolved from the call site, config, and default. */
  readonly maxIterations: number;
  readonly knownSkills: readonly {
    readonly name: string;
    readonly description: string;
    readonly path: string;
  }[];
}
