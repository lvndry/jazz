/**
 * Semantic views of a replayed run, for scenario assertions.
 *
 * A scenario asserts what the run did, not what the words were: the order of roles, which tools
 * were called with what argument keys, how each tool result ended, whether a final answer
 * exists, and what usage was reported. These helpers reduce a transcript or a stream-event list
 * to that shape so a test reads as a statement about behavior, and an incidental wording change
 * in a prompt or a tool message cannot fail it, while a changed order, a missing result or a
 * dropped answer does.
 */

import type { StreamEvent } from "@jazz/core/types";
import type { ChatMessage } from "@jazz/core/types/message";

/** The roles of a transcript in order, without the system prompt. */
export function rolesOf(messages: readonly ChatMessage[]): string[] {
  return messages.filter((message) => message.role !== "system").map((message) => message.role);
}

export interface ToolCallShape {
  readonly name: string;
  readonly argumentKeys: readonly string[];
}

/** Every tool call the assistant made, in order, as a name and the sorted keys of its arguments. */
export function toolCallsOf(messages: readonly ChatMessage[]): ToolCallShape[] {
  const calls: ToolCallShape[] = [];
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      let argumentKeys: string[] = [];
      try {
        const parsed: unknown = JSON.parse(call.function.arguments);
        if (typeof parsed === "object" && parsed !== null) {
          argumentKeys = Object.keys(parsed).sort();
        }
      } catch {
        argumentKeys = ["<unparseable>"];
      }
      calls.push({ name: call.function.name, argumentKeys });
    }
  }
  return calls;
}

export interface ToolResultShape {
  readonly name: string;
  readonly answersACall: boolean;
  readonly content: string;
}

/**
 * Each tool message paired with whether its `tool_call_id` matches an earlier assistant call.
 * A result that answers no call is the bug that breaks the next provider request.
 */
export function toolResultsOf(messages: readonly ChatMessage[]): ToolResultShape[] {
  const openCallIds = new Set<string>();
  const results: ToolResultShape[] = [];
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      openCallIds.add(call.id);
    }
    if (message.role === "tool") {
      results.push({
        name: message.name ?? "",
        answersACall: message.tool_call_id !== undefined && openCallIds.has(message.tool_call_id),
        content: message.content ?? "",
      });
    }
  }
  return results;
}

/** Tool calls left without any tool message: a transcript that cannot be sent to a provider. */
export function unansweredToolCallIds(messages: readonly ChatMessage[]): string[] {
  const answered = new Set(
    messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id),
  );
  return messages
    .flatMap((message) => message.tool_calls ?? [])
    .map((call) => call.id)
    .filter((id) => !answered.has(id));
}

/** The text of the last assistant message that has any. */
export function finalAssistantText(messages: readonly ChatMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && (message.content ?? "").trim().length > 0) {
      return message.content;
    }
  }
  return undefined;
}

/** The distinct stream event types seen, in first-seen order. */
export function eventTypesOf(events: readonly StreamEvent[]): string[] {
  return [...new Set(events.map((event) => event.type))];
}

/** Sum of the usage the stream reported, or undefined when no usage event arrived. */
export function reportedUsage(
  events: readonly StreamEvent[],
): { readonly promptTokens: number; readonly completionTokens: number } | undefined {
  let found = false;
  let promptTokens = 0;
  let completionTokens = 0;
  for (const event of events) {
    if (event.type === "usage_update") {
      found = true;
      promptTokens += event.usage.promptTokens;
      completionTokens += event.usage.completionTokens;
    }
  }
  return found ? { promptTokens, completionTokens } : undefined;
}
