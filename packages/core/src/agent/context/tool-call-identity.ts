/**
 * Repairs lost call identities when loading historical transcripts, without changing stored
 * events. Synthetic IDs avoid all existing call/result IDs; repaired calls retain their results.
 */
import type { ChatMessage } from "@/core/types/message";

/** The name given to a stored call whose name was lost, so a provider still accepts the request. */
export const REPAIRED_TOOL_NAME = "unknown_tool";

/** Whether an id or name is a string a provider will accept: present and not blank. */
export function isUsableToolCallField(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** What {@link repairToolCallIdentities} changed. */
export interface ToolCallIdentityRepair {
  readonly messages: readonly ChatMessage[];
  /** Calls given a synthetic id and/or the placeholder name. */
  readonly repairedCalls: number;
  /** Results re-attached to a repaired call. */
  readonly pairedResults: number;
}

/** The id a repaired call gets: a function of where it sits, so every load agrees on it. */
export function repairedToolCallId(anchor: string, callIndex: number): string {
  return `repaired-${anchor}-${callIndex}`;
}

/**
 * Makes a stored transcript sendable when an assistant call lost its id or name (an older
 * version persisted calls whose identity a gateway had blanked). A call without an id gets
 * `repaired-<anchor>-<callIndex>`, where `anchor` is the message's entry id or its position;
 * a call without a name gets {@link REPAIRED_TOOL_NAME}. The tool results that follow the
 * assistant message and carry no id are paired to the repaired calls in order. A repaired call
 * no result answers stays unanswered, which `closeUnansweredToolCalls` closes before a run.
 *
 * Returns the input untouched when no call needs repair. Never mutates `messages`.
 */
export function repairToolCallIdentities(
  messages: readonly ChatMessage[],
  anchorOf: (message: ChatMessage, index: number) => string = (_message, index) => String(index),
): ToolCallIdentityRepair {
  const needsRepair = messages.some(
    (message) =>
      message.role === "assistant" &&
      message.tool_calls?.some(
        (toolCall) =>
          !isUsableToolCallField(toolCall.id) || !isUsableToolCallField(toolCall.function?.name),
      ) === true,
  );
  if (!needsRepair) {
    return { messages, repairedCalls: 0, pairedResults: 0 };
  }

  const repaired: ChatMessage[] = [...messages];
  const reserved = new Set<string>();
  for (const message of messages) {
    if (isUsableToolCallField(message.tool_call_id)) {
      reserved.add(message.tool_call_id);
    }
    for (const call of message.tool_calls ?? []) {
      if (isUsableToolCallField(call.id)) {
        reserved.add(call.id);
      }
    }
  }
  let repairedCalls = 0;
  let pairedResults = 0;

  for (let index = 0; index < repaired.length; index += 1) {
    const message = repaired[index] as ChatMessage;
    if (message.role !== "assistant" || message.tool_calls === undefined) {
      continue;
    }
    const anchor = anchorOf(message, index);
    const idlessCalls: { id: string; name: string }[] = [];
    const toolCalls = message.tool_calls.map((toolCall, callIndex) => {
      const hasId = isUsableToolCallField(toolCall.id);
      const hasName = isUsableToolCallField(toolCall.function?.name);
      if (hasId && hasName) {
        return toolCall;
      }
      repairedCalls += 1;
      let id = hasId ? toolCall.id : repairedToolCallId(anchor, callIndex);
      if (!hasId) {
        const base = id;
        let suffix = 0;
        while (reserved.has(id)) {
          id = `${base}-${String(++suffix)}`;
        }
        reserved.add(id);
      }
      const name = hasName ? toolCall.function.name : REPAIRED_TOOL_NAME;
      if (!hasId || !hasName) {
        idlessCalls.push({ id, name });
      }
      return { ...toolCall, id, function: { ...toolCall.function, name } };
    });
    repaired[index] = { ...message, tool_calls: toolCalls };

    const answered = new Set<string>();
    for (
      let resultIndex = index + 1;
      resultIndex < repaired.length && repaired[resultIndex]?.role === "tool";
      resultIndex += 1
    ) {
      const id = repaired[resultIndex]?.tool_call_id;
      if (isUsableToolCallField(id)) {
        answered.add(id);
      }
    }
    const unmatched = idlessCalls.filter((call) => !answered.has(call.id));
    let pending = 0;
    for (
      let resultIndex = index + 1;
      resultIndex < repaired.length && (repaired[resultIndex] as ChatMessage).role === "tool";
      resultIndex += 1
    ) {
      const result = repaired[resultIndex] as ChatMessage;
      if (isUsableToolCallField(result.tool_call_id)) {
        continue;
      }
      const call = unmatched[pending];
      if (call === undefined) {
        continue;
      }
      pending += 1;
      pairedResults += 1;
      repaired[resultIndex] = { ...result, tool_call_id: call.id, name: call.name };
    }
  }

  return { messages: repaired, repairedCalls, pairedResults };
}
