/**
 * LLM message types
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
}
