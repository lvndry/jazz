import type { ProviderName } from "../constants/models";
import type { Agent } from "../types";
import type { ChatMessage, ConversationMessages } from "../types/message";
import type { DisplayConfig } from "../types/output";
import type { ToolCall, ToolDefinition, ToolExecutionContext } from "../types/tools";
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
   * Optional conversation identifier for tracking multi-turn conversations.
   * If not provided, a new conversation ID will be generated automatically.
   * Use the same conversation ID across multiple turns to maintain context.
   */
  readonly conversationId?: string;
  /**
   * Session identifier for logging purposes.
   * This should be set to the sessionId created at the start of a chat session.
   * Used to route logs to session-specific log files.
   */
  readonly sessionId: string;
  /**
   * If true, this is an internal sub-agent run (e.g., summarization).
   * UI elements like thinking indicators will be suppressed.
   */
  readonly internal?: boolean;
  /**
   * Maximum number of iterations (agent reasoning loops) allowed for this run.
   * Each iteration may involve tool calls and LLM responses.
   * If not specified, defaults to `MAX_AGENT_STEPS` constant.
   * The agent will stop when it reaches this limit or completes its task.
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
   * @example
   * ```typescript
   * if (response.toolCalls) {
   *   response.toolCalls.forEach(call => {
   *     console.log(`Agent called: ${call.function.name}`);
   *   });
   * }
   * ```
   */
  readonly toolCalls?: ToolCall[];
  /**
   * Optional map of tool execution results, keyed by tool name.
   * Present when tools were executed during this turn.
   * Contains the results returned by each tool, which may include data, errors, or status information.
   *
   * @example
   * ```typescript
   * if (response.toolResults) {
   *   const emailResults = response.toolResults["gmail_list_emails"];
   *   console.log("Emails retrieved:", emailResults);
   * }
   * ```
   */
  readonly toolResults?: Record<string, unknown>;
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
}

/**
 * Default display configuration (applies to both modes)
 */
export const DEFAULT_DISPLAY_CONFIG: DisplayConfig = {
  showThinking: true,
  showToolExecution: true,
  mode: "markdown",
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
}
