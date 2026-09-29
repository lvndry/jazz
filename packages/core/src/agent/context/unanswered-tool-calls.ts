import type { ChatMessage } from "@/core/types/message";

/** The answer given to one unanswered call: its text, or its text plus the host's taint flag. */
export type UnansweredToolCallAnswer =
  string | { readonly content: string; readonly egressTainted?: true };

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
 * `content` is the answer, or a function choosing one per call (a stopped batch answers a call
 * that completed with its real result, framed and flagged like any delivered result, and one
 * that did not with why).
 *
 * Returns the input unchanged when nothing is unanswered.
 */
export function closeUnansweredToolCalls<Messages extends readonly ChatMessage[]>(
  messages: Messages,
  content:
    | string
    | ((toolCall: { readonly id: string; readonly name: string }) => UnansweredToolCallAnswer),
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
      const answer =
        typeof content === "string"
          ? content
          : content({ id: toolCall.id, name: toolCall.function.name });
      closed.push({
        role: "tool",
        name: toolCall.function.name,
        content: typeof answer === "string" ? answer : answer.content,
        tool_call_id: toolCall.id,
        ...(typeof answer !== "string" && answer.egressTainted === true
          ? { egressTainted: true as const }
          : {}),
      });
    }
  }
  return closed as unknown as Messages;
}
