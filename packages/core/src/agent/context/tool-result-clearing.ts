import type { ChatMessage } from "@/core/types/message";
import { DEFAULT_TOKEN_COUNTER, type ModelHint, type TokenCounter } from "./token-counter";

/**
 * Reclaim context by replacing stale tool output with a pointer, the cheapest
 * rung of the ladder.
 *
 * A long run's tokens are overwhelmingly raw tool results, and most of them
 * stop mattering once the model has acted on them. The last few tool cycles
 * stay verbatim so the model can still compare what it read against what it
 * is about to change; older large results are stubbed. When the bytes were persisted, the stub names
 * `retrieve_tool_result`. When the disk would not take them (read-only CI,
 * container, Telegram host), the stub tells the model to re-run the original
 * tool instead. Either way the message and `tool_call_id` stay, so
 * assistant/tool pairing remains valid.
 */

/**
 * Smallest tool result that gets offloaded to disk and stubbed. Below this,
 * keeping it inline is cheaper than the one-time cost of a clear: a cache-miss
 * prefix rewrite plus one disk write (or a clean skip on read-only hosts).
 *
 * 256 tokens ≈ 850 chars on Claude / ~1k on GPT — about a 20-line file. The
 * bar is low because the body is persisted and `retrieve_tool_result` brings it
 * back, so a small stub is cheap to undo.
 */
export const MIN_CLEARABLE_RESULT_TOKENS = 256;

/**
 * Tool cycles kept verbatim, counting back from the live one.
 *
 * One cycle is not enough: a model that reads a file, then lists a directory,
 * then edits has already lost the file by the time it edits, and refetches it
 * every turn. Five covers a read-compare-edit sequence with room to spare.
 */
export const PROTECTED_TOOL_CYCLES = 5;

export interface ClearToolResultsOptions {
  /** Messages at this index and after must not be touched (the live tool cycle). */
  readonly protectedFromIndex: number;
  readonly modelHint: ModelHint;
  readonly tokenCounter?: TokenCounter;
  readonly minClearableTokens?: number;
  /** Tool-call ids whose original body is on disk and can be retrieved. */
  readonly retrievableIds?: ReadonlySet<string>;
}

export interface ClearToolResultsOutcome {
  readonly messages: ChatMessage[];
  readonly clearedCount: number;
  readonly tokensReclaimed: number;
}

/**
 * Index from which tool results stay verbatim: the assistant message that opened
 * the `cycles`-th most recent tool cycle, through the end of the list.
 *
 * Fewer cycles than that in the transcript means every result is still recent;
 * none at all means there is nothing to clear.
 */
export function toolResultsProtectFromIndex(
  messages: readonly ChatMessage[],
  cycles = PROTECTED_TOOL_CYCLES,
): number {
  let protectFrom = messages.length;
  let seen = 0;
  for (let index = messages.length - 1; index >= 0 && seen < cycles; index--) {
    const message = messages[index];
    if (message?.role !== "assistant" || !message.tool_calls?.length) continue;
    protectFrom = index;
    seen++;
  }
  return protectFrom;
}

function placeholderFor(
  toolName: string | undefined,
  tokens: number,
  toolCallId: string | undefined,
  retrievable: boolean,
): string {
  const name = toolName && toolName.length > 0 ? toolName : "tool";
  const size = `~${tokens.toLocaleString()} tokens`;
  if (retrievable && toolCallId) {
    return `[tool result offloaded — ${name}, ${size}. Call retrieve_tool_result with tool_call_id "${toolCallId}" to read the original.]`;
  }
  return `[tool result cleared — ${name}, ${size}. Re-run the tool if you need this again.]`;
}

/**
 * Replace the content of old, large tool results with a placeholder.
 *
 * Returns the original array untouched when nothing qualifies, so callers can
 * treat an unchanged reference as "nothing to do" and skip rewriting history.
 */
export function clearToolResults(
  messages: readonly ChatMessage[],
  options: ClearToolResultsOptions,
): ClearToolResultsOutcome {
  const counter = options.tokenCounter ?? DEFAULT_TOKEN_COUNTER;
  const minTokens = options.minClearableTokens ?? MIN_CLEARABLE_RESULT_TOKENS;
  const retrievableIds = options.retrievableIds;

  const toolNameByCallId = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "assistant" && message.tool_calls) {
      for (const call of message.tool_calls) {
        toolNameByCallId.set(call.id, call.function.name);
      }
    }
  }

  const toClear = new Map<number, number>();
  for (let index = 0; index < messages.length; index++) {
    if (index >= options.protectedFromIndex) break;
    const message = messages[index];
    if (!message || message.role !== "tool") continue;
    if (message.cleared) continue;
    const tokens = counter.countMessage(message, options.modelHint);
    if (tokens < minTokens) continue;
    toClear.set(index, tokens);
  }

  if (toClear.size === 0) {
    return { messages: messages as ChatMessage[], clearedCount: 0, tokensReclaimed: 0 };
  }

  let tokensReclaimed = 0;
  const next = messages.map((message, index) => {
    const originalTokens = toClear.get(index);
    if (originalTokens === undefined) return message;

    const toolCallId = message.tool_call_id;
    const toolName = toolCallId ? toolNameByCallId.get(toolCallId) : undefined;
    const retrievable = toolCallId !== undefined && retrievableIds?.has(toolCallId) === true;
    const replacement: ChatMessage = {
      ...message,
      content: placeholderFor(toolName, originalTokens, toolCallId, retrievable),
      cleared: true,
    };
    tokensReclaimed += originalTokens - counter.countMessage(replacement, options.modelHint);
    return replacement;
  });

  return { messages: next, clearedCount: toClear.size, tokensReclaimed };
}
