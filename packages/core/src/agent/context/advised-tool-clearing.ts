/**
 * Decision-advised variant of the clear rung: instead of stubbing every old, large tool result by age,
 * ask a decision provider (via the `compact.tools` hook) to keep, truncate, or drop each one. Like
 * the deterministic clearer, it never removes a message — it only replaces content — so
 * assistant/tool pairing stays valid. It fails open: when the provider abstains, `answered` is false
 * and the caller runs the deterministic clearer instead.
 */

import { Effect } from "effect";
import type { ChatMessage, ConversationMessages } from "@/core/types/message";
import type {
  CompactToolAction,
  CompactToolsInput,
  CompactToolsOutcome,
} from "@/core/types/plugin";
import { DEFAULT_TOKEN_COUNTER, type ModelHint, type TokenCounter } from "./token-counter";
import { MIN_CLEARABLE_RESULT_TOKENS, placeholderFor } from "./tool-result-clearing";

const PREVIEW_HEAD = 320;
const PREVIEW_TAIL = 140;

export interface AdvisedReduceOptions {
  /** Messages at or after this index are recent/protected and never candidates. */
  readonly protectedFromIndex: number;
  /** The run's goal or current request, for judging what is still relevant. */
  readonly goal: string;
  /** Tool-call ids whose bodies were offloaded to disk, so a drop stub points at retrieval. */
  readonly retrievableIds?: ReadonlySet<string> | undefined;
  readonly modelHint: ModelHint;
  readonly tokenCounter?: TokenCounter;
  /** Runs the `compact.tools` hook; supplied by the host so this module stays provider-neutral. */
  readonly decide: (input: CompactToolsInput) => Effect.Effect<CompactToolsOutcome>;
  readonly minClearableTokens?: number;
}

export interface AdvisedReduceOutcome {
  readonly messages: ChatMessage[];
  readonly clearedCount: number;
  readonly tokensReclaimed: number;
  /** True when the provider returned decisions; false means it abstained and the caller should fall back. */
  readonly answered: boolean;
}

/**
 * The run-facing shape of the advised clear rung: the host passes the live message list, the
 * index below which messages are protected, and any offloaded tool-call ids, and gets back an
 * outcome that either replaces content or abstains. Both the live loop (clear rung) and the
 * summarizer (manual `/compact` pre-pass) hold one of these; `buildAdvisedReducer` produces it
 * from a plugin session so callers never reassemble the option bag.
 */
export type ReduceToolResultsFn = (
  messages: ConversationMessages,
  protectedFromIndex: number,
  retrievableIds: ReadonlySet<string> | undefined,
) => Effect.Effect<AdvisedReduceOutcome>;

/**
 * Bind a `compact.tools` decision provider into a `ReduceToolResultsFn`, so the goal and model
 * hint are fixed once and every call site shares the same option assembly instead of duplicating
 * it.
 */
export function buildAdvisedReducer(params: {
  readonly goal: string;
  readonly provider: string;
  readonly model: string;
  readonly decide: (input: CompactToolsInput) => Effect.Effect<CompactToolsOutcome>;
}): ReduceToolResultsFn {
  return (messages, protectedFromIndex, retrievableIds) =>
    reduceToolResultsAdvised(messages, {
      protectedFromIndex,
      goal: params.goal,
      retrievableIds,
      modelHint: { provider: params.provider, modelId: params.model },
      decide: params.decide,
    });
}

function contentString(message: ChatMessage): string {
  return typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content ?? "");
}

function preview(text: string): string {
  if (text.length <= PREVIEW_HEAD + PREVIEW_TAIL + 60) return text;
  return `${text.slice(0, PREVIEW_HEAD)}\n…[${text.length - PREVIEW_HEAD - PREVIEW_TAIL} chars of the middle omitted]…\n${text.slice(-PREVIEW_TAIL)}`;
}

function truncatedContent(text: string, toolName: string | undefined): string {
  const name = toolName && toolName.length > 0 ? toolName : "tool";
  return `${text.slice(0, PREVIEW_HEAD)}\n[… ${text.length - PREVIEW_HEAD - PREVIEW_TAIL} chars of this ${name} result truncated; re-run the tool if you need the rest …]\n${text.slice(-PREVIEW_TAIL)}`;
}

/** Ask the provider what to do with each old, large tool result, then apply keep/truncate/drop. */
export function reduceToolResultsAdvised(
  messages: readonly ChatMessage[],
  options: AdvisedReduceOptions,
): Effect.Effect<AdvisedReduceOutcome> {
  return Effect.gen(function* () {
    const counter = options.tokenCounter ?? DEFAULT_TOKEN_COUNTER;
    const minTokens = options.minClearableTokens ?? MIN_CLEARABLE_RESULT_TOKENS;

    const toolNameByCallId = new Map<string, string>();
    for (const message of messages) {
      if (message.role === "assistant" && message.tool_calls) {
        for (const call of message.tool_calls) toolNameByCallId.set(call.id, call.function.name);
      }
    }

    const candidateTokens = new Map<number, number>();
    for (let index = 0; index < messages.length && index < options.protectedFromIndex; index++) {
      const message = messages[index];
      if (!message || message.role !== "tool" || message.cleared || !message.tool_call_id) continue;
      const tokens = counter.countMessage(message, options.modelHint);
      if (tokens < minTokens) continue;
      candidateTokens.set(index, tokens);
    }

    const unchanged: AdvisedReduceOutcome = {
      messages: messages as ChatMessage[],
      clearedCount: 0,
      tokensReclaimed: 0,
      answered: false,
    };
    if (candidateTokens.size === 0) return unchanged;

    const input: CompactToolsInput = {
      goal: options.goal,
      candidates: [...candidateTokens.keys()].map((index) => {
        const message = messages[index] as ChatMessage;
        const text = contentString(message);
        return {
          id: message.tool_call_id as string,
          tool: toolNameByCallId.get(message.tool_call_id as string) ?? "tool",
          resultPreview: preview(text),
          resultChars: text.length,
          isError: false,
        };
      }),
    };

    const outcome = yield* options.decide(input);
    if (outcome.status !== "answered") return unchanged;

    const actionByCallId = new Map<string, CompactToolAction>(
      outcome.decisions.map((decision) => [decision.id, decision.action]),
    );

    let clearedCount = 0;
    let tokensReclaimed = 0;
    const next = messages.map((message, index) => {
      const originalTokens = candidateTokens.get(index);
      if (originalTokens === undefined) return message;
      const toolCallId = message.tool_call_id as string;
      const action = actionByCallId.get(toolCallId) ?? "keep";
      if (action === "keep") return message;
      const toolName = toolNameByCallId.get(toolCallId);
      const content =
        action === "truncate"
          ? truncatedContent(contentString(message), toolName)
          : placeholderFor(
              toolName,
              originalTokens,
              toolCallId,
              options.retrievableIds?.has(toolCallId) === true,
            );
      const replacement: ChatMessage = { ...message, content, cleared: true };
      clearedCount += 1;
      tokensReclaimed += originalTokens - counter.countMessage(replacement, options.modelHint);
      return replacement;
    });

    return { messages: next, clearedCount, tokensReclaimed, answered: true };
  });
}
