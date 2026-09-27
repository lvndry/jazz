import type { ChatMessage } from "@/core/types/message";

/**
 * Give every assistant `tool_calls` entry without a `role: "tool"` answer a synthetic one,
 * placed right after that call's existing answers so the transcript stays valid to send.
 *
 * A saved conversation can legitimately end on an unanswered call: a parked run's transcript
 * is persisted so the next turn remembers it, and a parked run whose resume fails never
 * writes the answer. Providers reject such a transcript outright, so a new run on it would
 * fail before doing any work. Resuming the parked run itself must not use this: the
 * unanswered call is what the resume answers.
 *
 * Returns the input unchanged when nothing is unanswered.
 */
export function closeUnansweredToolCalls<Messages extends readonly ChatMessage[]>(
  messages: Messages,
  content: string,
): Messages {
  const answered = new Set(
    messages
      .filter((message) => message.role === "tool" && message.tool_call_id !== undefined)
      .map((message) => message.tool_call_id),
  );
  const hasUnanswered = messages.some(
    (message) =>
      message.role === "assistant" &&
      message.tool_calls?.some((toolCall) => !answered.has(toolCall.id)) === true,
  );
  if (!hasUnanswered) {
    return messages;
  }

  const closed: ChatMessage[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index] as ChatMessage;
    closed.push(message);
    index += 1;
    const toolCalls = message.role === "assistant" ? message.tool_calls : undefined;
    if (toolCalls === undefined || toolCalls.length === 0) {
      continue;
    }
    while (index < messages.length && (messages[index] as ChatMessage).role === "tool") {
      closed.push(messages[index] as ChatMessage);
      index += 1;
    }
    for (const toolCall of toolCalls) {
      if (answered.has(toolCall.id)) {
        continue;
      }
      closed.push({
        role: "tool",
        name: toolCall.function.name,
        content,
        tool_call_id: toolCall.id,
      });
    }
  }
  return closed as unknown as Messages;
}
