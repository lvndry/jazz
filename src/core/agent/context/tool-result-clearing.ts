import type { ChatMessage } from "@/core/types/message";
import { DEFAULT_TOKEN_COUNTER, type ModelHint, type TokenCounter } from "./token-counter";

/**
 * Reclaim context by clearing stale tool output, the cheapest rung of the ladder.
 *
 * A long run's tokens are overwhelmingly raw tool results — file contents, search
 * output, API responses — and most of them stop mattering the moment the model has
 * read them. Summarizing to recover that space costs an LLM call; clearing costs
 * nothing.
 *
 * The message and its `tool_call_id` are kept and only the content is replaced, so
 * assistant/tool pairing stays intact. Deleting the message instead would orphan the
 * assistant `tool_calls` that referenced it and provoke a provider error.
 */

/** Results smaller than this are left alone: clearing them costs structure for no gain. */
export const MIN_CLEARABLE_RESULT_TOKENS = 1_000;

/** How many of the most recent tool results are always kept verbatim. */
export const KEEP_RECENT_TOOL_RESULTS = 5;

export interface ClearToolResultsOptions {
  /** Messages at the end that must not be touched (the protected recent turns). */
  readonly protectedFromIndex: number;
  readonly modelHint: ModelHint;
  readonly tokenCounter?: TokenCounter;
  readonly minClearableTokens?: number;
  readonly keepRecent?: number;
}

export interface ClearToolResultsOutcome {
  readonly messages: ChatMessage[];
  readonly clearedCount: number;
  readonly tokensReclaimed: number;
}

function placeholderFor(toolName: string | undefined, tokens: number): string {
  const name = toolName && toolName.length > 0 ? toolName : "tool";
  return `[tool result cleared — ${name}, ~${tokens.toLocaleString()} tokens. Re-run the tool if you need this again.]`;
}

/**
 * Replace the content of old, large tool results with a placeholder.
 *
 * Returns the original array untouched when nothing qualifies, so callers can treat
 * an unchanged reference as "nothing to do" and skip the cache-invalidating rewrite.
 */
export function clearToolResults(
  messages: readonly ChatMessage[],
  options: ClearToolResultsOptions,
): ClearToolResultsOutcome {
  const counter = options.tokenCounter ?? DEFAULT_TOKEN_COUNTER;
  const minTokens = options.minClearableTokens ?? MIN_CLEARABLE_RESULT_TOKENS;
  const keepRecent = options.keepRecent ?? KEEP_RECENT_TOOL_RESULTS;

  const toolNameByCallId = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "assistant" && message.tool_calls) {
      for (const call of message.tool_calls) {
        toolNameByCallId.set(call.id, call.function.name);
      }
    }
  }

  // Candidates: tool results outside the protected zone, not already cleared, big
  // enough to be worth it. Walk backwards so "most recent" is cheap to determine.
  const candidateIndices: number[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.role !== "tool") continue;
    if (index >= options.protectedFromIndex) continue;
    if (message.cleared) continue;
    candidateIndices.push(index);
  }

  const clearable = candidateIndices.slice(keepRecent);
  if (clearable.length === 0) {
    return { messages: [...messages], clearedCount: 0, tokensReclaimed: 0 };
  }

  const toClear = new Map<number, number>();
  for (const index of clearable) {
    const message = messages[index];
    if (!message) continue;
    const tokens = counter.countMessage(message, options.modelHint);
    if (tokens < minTokens) continue;
    toClear.set(index, tokens);
  }

  if (toClear.size === 0) {
    return { messages: [...messages], clearedCount: 0, tokensReclaimed: 0 };
  }

  let tokensReclaimed = 0;
  const next = messages.map((message, index) => {
    const originalTokens = toClear.get(index);
    if (originalTokens === undefined) return message;

    const toolName = message.tool_call_id ? toolNameByCallId.get(message.tool_call_id) : undefined;
    const replacement: ChatMessage = {
      ...message,
      content: placeholderFor(toolName, originalTokens),
      cleared: true,
    };
    tokensReclaimed += originalTokens - counter.countMessage(replacement, options.modelHint);
    return replacement;
  });

  return { messages: next, clearedCount: toClear.size, tokensReclaimed };
}
