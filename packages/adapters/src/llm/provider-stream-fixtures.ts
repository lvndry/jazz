/**
 * Hand-built AI SDK `fullStream` fixtures, one per provider behavior Jazz's stream boundary
 * must normalize. Each case names itself, so a failing contract assertion points at the case.
 * The shapes follow the `ai` stream part types; when an SDK upgrade changes one, the contract
 * test fails under the name of the case that depends on it.
 */
import type { FinishReason } from "@jazz/core/types/chat";
import { APICallError, UnsupportedFunctionalityError } from "ai";

export type StreamPartFixture = Record<string, unknown> & { readonly type: string };

export interface UsageFixture {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly inputTokenDetails?: {
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
  };
}

/** Where the provider reports usage: on the `finish` part, on the `result.usage` promise only, or nowhere. */
export type UsageDelivery = "finish-part" | "result-promise-only" | "never";

export interface ExpectedToolCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export interface CompletedExpectation {
  readonly text: string;
  readonly toolCalls: readonly ExpectedToolCall[];
  readonly reasoningText: string | undefined;
  readonly reasoningParts: ReadonlyArray<{
    readonly provider: string;
    readonly hasProviderOptions: boolean;
  }>;
  readonly finishReason: FinishReason;
  readonly promptTokens: number | undefined;
  readonly cacheReadTokens: number | undefined;
  readonly cacheWriteTokens: number | undefined;
  readonly emptyFinishRetried: boolean;
}

export interface FailedExpectation {
  readonly errorTag: "LLMRequestError" | "LLMRateLimitError" | "LLMAuthenticationError";
  readonly retryable: boolean;
  readonly permanent: boolean;
}

export interface ProviderStreamCase {
  readonly name: string;
  readonly providerName: string;
  readonly modelName: string;
  readonly parts: readonly StreamPartFixture[];
  readonly usage: UsageFixture | undefined;
  readonly usageDelivery: UsageDelivery;
  readonly responseMessages: readonly Record<string, unknown>[];
  readonly expected:
    | { readonly outcome: "completed"; readonly completion: CompletedExpectation }
    | { readonly outcome: "failed"; readonly failure: FailedExpectation };
}

const SMALL_USAGE: UsageFixture = { inputTokens: 40, outputTokens: 12, totalTokens: 52 };

function finishPart(finishReason: string, usage?: UsageFixture): StreamPartFixture {
  return {
    type: "finish",
    finishReason,
    ...(usage ? { totalUsage: usage } : {}),
  };
}

/** The part sequence the SDK emits for one streamed tool call: raw deltas, then the parsed call. */
function toolInputParts(
  toolCallId: string,
  toolName: string,
  rawJsonSplit: readonly string[],
): StreamPartFixture[] {
  const input: unknown = JSON.parse(rawJsonSplit.join(""));
  return [
    { type: "tool-input-start", id: toolCallId, toolName },
    ...rawJsonSplit.map((delta) => ({ type: "tool-input-delta", id: toolCallId, delta })),
    { type: "tool-input-end", id: toolCallId },
    { type: "tool-call", toolCallId, toolName, input },
  ];
}

function statusError(statusCode: number): APICallError {
  return new APICallError({
    message: `provider answered ${statusCode}`,
    url: "https://provider.invalid/v1/chat",
    requestBodyValues: {},
    statusCode,
  });
}

const NO_COMPLETION_DEFAULTS = {
  text: "",
  toolCalls: [],
  reasoningText: undefined,
  reasoningParts: [],
  finishReason: "stop",
  promptTokens: undefined,
  cacheReadTokens: undefined,
  cacheWriteTokens: undefined,
  emptyFinishRetried: false,
} satisfies CompletedExpectation;

export const PROVIDER_STREAM_CASES: readonly ProviderStreamCase[] = [
  {
    name: "deepseek thinking then a tool call",
    providerName: "deepseek",
    modelName: "deepseek-v4-pro",
    parts: [
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", text: "I should list " },
      { type: "reasoning-delta", id: "r1", text: "the directory." },
      { type: "reasoning-end", id: "r1" },
      ...toolInputParts("call_1", "list_dir", ['{"path"', ':"/tmp"}']),
      finishPart("tool-calls", SMALL_USAGE),
    ],
    usage: SMALL_USAGE,
    usageDelivery: "finish-part",
    responseMessages: [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "I should list the directory." },
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "list_dir",
            input: { path: "/tmp" },
          },
        ],
      },
    ],
    expected: {
      outcome: "completed",
      completion: {
        ...NO_COMPLETION_DEFAULTS,
        toolCalls: [{ name: "list_dir", input: { path: "/tmp" } }],
        reasoningText: "I should list the directory.",
        reasoningParts: [{ provider: "deepseek", hasProviderOptions: false }],
        finishReason: "tool-calls",
        promptTokens: 40,
      },
    },
  },
  {
    name: "anthropic signed thinking then text",
    providerName: "anthropic",
    modelName: "claude-sonnet-4-5",
    parts: [
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", text: "Weigh the options." },
      { type: "reasoning-end", id: "r1" },
      { type: "text-delta", id: "t1", text: "Go with " },
      { type: "text-delta", id: "t1", text: "option B." },
      finishPart("stop", SMALL_USAGE),
    ],
    usage: SMALL_USAGE,
    usageDelivery: "finish-part",
    responseMessages: [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "Weigh the options.",
            providerOptions: { anthropic: { signature: "sig-abc" } },
          },
          { type: "text", text: "Go with option B." },
        ],
      },
    ],
    expected: {
      outcome: "completed",
      completion: {
        ...NO_COMPLETION_DEFAULTS,
        text: "Go with option B.",
        reasoningText: "Weigh the options.",
        reasoningParts: [{ provider: "anthropic", hasProviderOptions: true }],
        promptTokens: 40,
      },
    },
  },
  {
    name: "openai tool call with raw json arguments split across deltas",
    providerName: "openai",
    modelName: "gpt-5",
    parts: [
      ...toolInputParts("call_9", "write_file", [
        '{"pa',
        'th":"notes.txt","con',
        'tent":"line one\\nline two"}',
      ]),
      finishPart("tool-calls", SMALL_USAGE),
    ],
    usage: SMALL_USAGE,
    usageDelivery: "finish-part",
    responseMessages: [],
    expected: {
      outcome: "completed",
      completion: {
        ...NO_COMPLETION_DEFAULTS,
        toolCalls: [
          { name: "write_file", input: { path: "notes.txt", content: "line one\nline two" } },
        ],
        finishReason: "tool-calls",
        promptTokens: 40,
      },
    },
  },
  {
    name: "cache reads stay inside prompt tokens",
    providerName: "anthropic",
    modelName: "claude-sonnet-4-5",
    parts: [
      { type: "text-delta", id: "t1", text: "cached answer" },
      finishPart("stop", {
        inputTokens: 1000,
        outputTokens: 20,
        totalTokens: 1020,
        inputTokenDetails: { cacheReadTokens: 800, cacheWriteTokens: 100 },
      }),
    ],
    usage: {
      inputTokens: 1000,
      outputTokens: 20,
      totalTokens: 1020,
      inputTokenDetails: { cacheReadTokens: 800, cacheWriteTokens: 100 },
    },
    usageDelivery: "finish-part",
    responseMessages: [],
    expected: {
      outcome: "completed",
      completion: {
        ...NO_COMPLETION_DEFAULTS,
        text: "cached answer",
        promptTokens: 1000,
        cacheReadTokens: 800,
        cacheWriteTokens: 100,
      },
    },
  },
  {
    name: "usage only on the result promise, after finish",
    providerName: "openai",
    modelName: "gpt-5",
    parts: [{ type: "text-delta", id: "t1", text: "late usage" }, finishPart("stop")],
    usage: SMALL_USAGE,
    usageDelivery: "result-promise-only",
    responseMessages: [],
    expected: {
      outcome: "completed",
      completion: { ...NO_COMPLETION_DEFAULTS, text: "late usage", promptTokens: 40 },
    },
  },
  {
    name: "no usage reported anywhere",
    providerName: "ollama",
    modelName: "llama3.1",
    parts: [{ type: "text-delta", id: "t1", text: "unmetered" }, finishPart("stop")],
    usage: undefined,
    usageDelivery: "never",
    responseMessages: [],
    expected: {
      outcome: "completed",
      completion: { ...NO_COMPLETION_DEFAULTS, text: "unmetered" },
    },
  },
  {
    name: "empty finish with zero output tokens",
    providerName: "openai",
    modelName: "gpt-5",
    parts: [finishPart("stop", { inputTokens: 40, outputTokens: 0, totalTokens: 40 })],
    usage: { inputTokens: 40, outputTokens: 0, totalTokens: 40 },
    usageDelivery: "finish-part",
    responseMessages: [],
    expected: {
      outcome: "completed",
      completion: { ...NO_COMPLETION_DEFAULTS, promptTokens: 40, emptyFinishRetried: true },
    },
  },
  {
    name: "server error part mid-stream after text",
    providerName: "openai",
    modelName: "gpt-5",
    parts: [
      { type: "text-delta", id: "t1", text: "partial " },
      { type: "error", error: statusError(503) },
    ],
    usage: undefined,
    usageDelivery: "never",
    responseMessages: [],
    expected: {
      outcome: "failed",
      failure: { errorTag: "LLMRequestError", retryable: true, permanent: false },
    },
  },
  {
    name: "rate limit error part",
    providerName: "anthropic",
    modelName: "claude-sonnet-4-5",
    parts: [{ type: "error", error: statusError(429) }],
    usage: undefined,
    usageDelivery: "never",
    responseMessages: [],
    expected: {
      outcome: "failed",
      failure: { errorTag: "LLMRateLimitError", retryable: true, permanent: false },
    },
  },
  {
    name: "stream ends without a finish part",
    providerName: "deepseek",
    modelName: "deepseek-v4-flash",
    parts: [{ type: "text-delta", id: "t1", text: "cut off" }],
    usage: undefined,
    usageDelivery: "never",
    responseMessages: [],
    expected: {
      outcome: "failed",
      failure: { errorTag: "LLMRequestError", retryable: true, permanent: false },
    },
  },
  {
    name: "unsupported option rejected by the provider",
    providerName: "openai",
    modelName: "gpt-5",
    parts: [
      {
        type: "error",
        error: new UnsupportedFunctionalityError({
          functionality: "file part media type video/mp4",
        }),
      },
    ],
    usage: undefined,
    usageDelivery: "never",
    responseMessages: [],
    expected: {
      outcome: "failed",
      failure: { errorTag: "LLMRequestError", retryable: false, permanent: true },
    },
  },
];
