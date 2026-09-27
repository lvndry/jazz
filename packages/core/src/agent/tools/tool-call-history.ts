/**
 * @fileoverview Reading a run's messages for the calls it made to one tool.
 */

/** The message fields a lookup needs; satisfied by `ChatMessage` and by stored transcripts. */
export interface ToolCallMessage {
  readonly role: string;
  readonly content?: unknown;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly {
    readonly id: string;
    readonly function: { readonly name: string; readonly arguments: string };
  }[];
}

/**
 * The last call to `toolName` whose result came back without an error, as its raw JSON
 * arguments; undefined when there is none. A call with no result yet does not count.
 */
export function lastSucceededToolCall(
  messages: readonly ToolCallMessage[],
  toolName: string,
): string | undefined {
  const results = messages.filter((message) => message.role === "tool");
  const answered = new Set(results.map((message) => message.tool_call_id));
  const failed = new Set(
    results
      .filter(
        (message) =>
          typeof message.content === "string" &&
          /"success"\s*:\s*false|"error"\s*:/.test(message.content),
      )
      .map((message) => message.tool_call_id),
  );
  const calls = messages.flatMap((message) =>
    message.role === "assistant" ? (message.tool_calls ?? []) : [],
  );
  return [...calls]
    .reverse()
    .find(
      (call) => call.function.name === toolName && answered.has(call.id) && !failed.has(call.id),
    )?.function.arguments;
}
