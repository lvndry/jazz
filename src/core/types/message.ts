/**
 * @fileoverview Chat message types for LLM communication
 *
 * Defines the data structures used for communicating with LLMs, including
 * message roles (system, user, assistant, tool), content, and tool call metadata.
 * These types follow the OpenAI API format and are compatible with multiple
 * LLM providers through adapter layers.
 */

/**
 * LLM message types
 */

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface StoredReasoningPart {
  /** Stored verbatim — never sanitized or trimmed; provider signatures validate exact bytes. */
  text: string;
  /** Provider that produced this part (e.g. "anthropic"); replay is gated on exact match. */
  provider: string;
  /** Opaque provider payload from the AI SDK reasoning part (signatures, encrypted content, item ids). */
  providerOptions?: Record<string, Record<string, JsonValue>>;
}

/**
 * Individual chat message in a conversation with an LLM
 *
 * Messages form the conversation context between a user and an AI assistant.
 * Each message has a role, content, and optionally tool-specific metadata.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  /**
   * For role === "tool": the id of the tool call this message responds to
   */
  tool_call_id?: string;
  /**
   * Set when this message's original content has been replaced by a placeholder to
   * reclaim context (see `clearToolResults`). Marks the message as already reclaimed
   * so later passes skip it, and distinguishes a stub from a genuinely short result.
   */
  cleared?: true;
  /**
   * Marks an assistant message as a compaction summary rather than model output.
   * Identified by flag rather than position so summarization can carry it forward
   * as prior state instead of re-summarizing its own previous summary.
   */
  kind?: "summary";
  /**
   * For role === "assistant": include tool calls emitted by the model so that
   * subsequent tool messages are valid according to the OpenAI API.
   *
   * For Google/Gemini models, thought_signature must be preserved to maintain
   * reasoning context across function calls.
   */
  tool_calls?: ReadonlyArray<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
    /**
     * Google Gemini thought_signature - encrypted representation of model's
     * internal reasoning. Must be preserved when present to maintain context.
     */
    thought_signature?: string;
  }>;
  /**
   * For role === "assistant": reasoning blocks captured from the provider,
   * replayed on subsequent requests within the same turn (Anthropic thinking
   * signatures, OpenAI encrypted reasoning, OpenRouter reasoning_details).
   */
  reasoning_parts?: ReadonlyArray<StoredReasoningPart>;
}

/**
 * A non-empty list of chat messages, usually starting with a system message.
 * This type helps ensure that we always have at least one message (typically the system prompt)
 * when communicating with LLMs.
 */
/* Non-empty array of chat messages for LLM requests
 *
 * Ensures that conversations always contain at least one message (typically the
 * system prompt) when sending requests to LLMs. This type-level constraint helps
 * prevent malformed API calls.
 *
 */
export type ConversationMessages = [ChatMessage, ...ChatMessage[]];
