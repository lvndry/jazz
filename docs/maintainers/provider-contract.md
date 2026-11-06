---
description: "What Jazz's provider layer relies on from the AI SDK stream: event order, usage, tool-call arguments, reasoning replay, error paths, retries, and empty finishes."
---

# Provider contract

Jazz gets provider behavior from the AI SDK. It has no adapter interface of its own below
`LLMService`, so the obligations a provider package must meet are the ones Jazz's stream
boundary already depends on. This page states them as the code enforces them today. Each
obligation names its source and its test, and anything Jazz does not enforce is marked
**Not enforced**.

Source:
[`stream-processor.ts`](../../packages/adapters/src/llm/stream-processor.ts) ·
[`ai-sdk-service.ts`](../../packages/adapters/src/llm/ai-sdk-service.ts) ·
[`reasoning-replay.ts`](../../packages/adapters/src/llm/reasoning-replay.ts) ·
[`reasoning-parts.ts`](../../packages/adapters/src/llm/reasoning-parts.ts) ·
[`tool-call-parts.ts`](../../packages/adapters/src/llm/tool-call-parts.ts) ·
[`llm-error.ts`](../../packages/core/src/utils/llm-error.ts) ·
[`completion-validation.ts`](../../packages/core/src/agent/execution/completion-validation.ts) ·
[`answer-outcome.ts`](../../packages/core/src/agent/run/answer-outcome.ts)

Tests: [`provider-stream-contract.test.ts`](../../packages/adapters/src/llm/provider-stream-contract.test.ts)
runs one set of assertions over every case in
[`provider-stream-fixtures.ts`](../../packages/adapters/src/llm/provider-stream-fixtures.ts). A
failing assertion names its case. To cover a new provider behavior, add a case to the table.

---

## Where the boundary sits

`AISDKService` calls `streamText` and hands `result.fullStream` to a `StreamProcessor`. The
processor turns SDK parts into Jazz `StreamEvent`s and one `ChatCompletionResponse`. Jazz
passes `maxRetries: 0` to the SDK (`AI_SDK_MAX_RETRIES`), so every retry is Jazz's own and
happens in the executors, never inside the SDK.

## Stream event order

The processor emits, in this order:

1. `stream_start` first, always.
2. Between them, in arrival order: `thinking_start`, `thinking_chunk`, `thinking_complete`,
   `text_start`, `text_chunk`, `tool_call`.
3. `usage_update`, only when usage was found (see below).
4. `complete`, last, exactly once.

What the processor enforces:

- Reasoning closes (`thinking_complete`) before the first text. A `reasoning-end` part, a
  `text-delta`, or the end of the stream closes it. `thinking_start` is also emitted from a
  `reasoning-delta` that arrives without a `reasoning-start`.
- Empty `text-delta` parts are dropped.
- `tool-input-start`, `tool-input-delta` and `tool-input-end` produce no events. A tool call
  is emitted once, from the SDK's assembled `tool-call` part.
- The `finish` part ends processing. Parts after it are ignored, including a late `error`.
- Provider-native tool calls (for example OpenAI web search) are held until their
  `tool-result` arrives so the call carries its real query, and are flushed at `finish` if no
  result came.
- Inline `<think>` tags in text are parsed into reasoning only when a reasoning parser is
  selected for the provider and model (local providers), and only until a separate reasoning
  channel appears.

**Not enforced:** that `reasoning-start` precedes `reasoning-delta`, that `text-start` and
`text-end` exist, or that the SDK emits parts in any other particular order. The processor
reads only the part types listed above.

A stream that ends without a `finish` part fails the request with `Stream completed without
finish event`. A `finish` whose reason is `error` fails it too.

## Usage

Usage is read in this order, first hit wins:

1. `totalUsage` on the `finish` part, available in-stream.
2. `result.usage`, awaited for at most 2 seconds (`USAGE_SETTLE_TIMEOUT_MS`).

When usage is found the processor emits `usage_update` and then `complete`, so a consumer sees
usage before completion. When neither source yields usage, no `usage_update` is emitted and
the response carries no `usage`. Consumers treat a missing report as zero tokens.

Normalization into `TokenUsage`:

| Jazz field         | AI SDK field                                                    | Rule                                  |
| ------------------ | --------------------------------------------------------------- | ------------------------------------- |
| `promptTokens`     | `inputTokens`                                                   | `0` when absent; includes cache reads |
| `completionTokens` | `outputTokens`                                                  | `0` when absent                       |
| `totalTokens`      | `totalTokens`                                                   | `0` when absent                       |
| `cacheReadTokens`  | `inputTokenDetails.cacheReadTokens`                             | set only when reported                |
| `cacheWriteTokens` | `inputTokenDetails.cacheWriteTokens`                            | set only when reported                |
| `reasoningTokens`  | `reasoning-end` part, else `outputTokenDetails.reasoningTokens` | set only when reported                |

Cache reads are part of `promptTokens`. Cost code relies on this: `usage-cost.ts` clamps
`cacheReadTokens` to `promptTokens` and prices the remainder as uncached input. A provider
package that reports `inputTokens` excluding cached tokens would be over-discounted. Jazz does
not detect that case.

## Tool-call arguments

The SDK assembles streamed argument deltas and parses them. Jazz receives the parsed `input`
on the `tool-call` part and serializes it with `JSON.stringify` into
`ToolCall.function.arguments`. The result is a JSON string that parses back to the same
object; key order is kept but whitespace is not.

The raw model text survives in one case: when the SDK marks the call `invalid`, `input` is the
unparsed string and Jazz keeps it verbatim, with `invalidReason` describing the failure so the
executor answers the model instead of running the tool.

`thought_signature` (Google) is the only provider metadata kept on a tool call. When a stored
call is replayed, `arguments` is parsed back into an object for the SDK.

## Reasoning storage and replay

Stored on the response: `reasoning` holds the accumulated reasoning text for display.
`reasoningParts` holds the provider's own reasoning parts from `result.response.messages`,
each tagged with the provider name and carrying `providerOptions` verbatim (Anthropic's
signature, OpenAI's item id and encrypted content). A part with neither text nor
`providerOptions` is dropped. The response is awaited for at most 50 ms, and a failure to read
it never fails the completion, so `reasoningParts` can be missing on a slow response.

Replayed on the next request by `resolveReasoningReplay(provider, model)`:

| Provider                         | Scope          | Text required |
| -------------------------------- | -------------- | ------------- |
| `anthropic`, `openai`, `chatgpt` | `current-turn` | no            |
| `moonshotai`                     | `current-turn` | yes           |
| `deepseek`, V4 and later ids     | `all-turns`    | yes           |
| `deepseek`, legacy ids           | `current-turn` | yes           |
| every other provider             | `none`         | no            |

`current-turn` means assistant messages after the last non-ephemeral user message, which is
the in-flight tool loop. A stored part is replayed only when its `provider` equals the current
provider, so switching providers mid-conversation drops the old provider's reasoning rather
than sending it to a provider that cannot read it. A malformed stored part is skipped and
logged with a reason, never sent.

## Error paths

A request fails through exactly one of two paths, and both end in `convertToLLMError`:

1. **Thrown before the stream exists.** Setup (model resolution, message conversion,
   attachment loading) throws, and the service converts it.
2. **An `error` part in the stream.** The processor throws `part.error`. The service catches
   it, converts it, fails the Effect stream with the `LLMError`, and rejects the response.

The processor never emits a `StreamEvent` of type `error` itself, and it never completes after
failing. `process()` either returns a response or throws.

**Not enforced:** a provider that signals failure some third way (for example a `finish` with
a non-error reason and an empty body) is not an error. It reaches the empty-finish check below.

### Classification

`convertToLLMError` maps the thrown value to one of three tags. The checks run in this order:

| Condition                                                                                                                                                                                                                                                      | Result                                  | Retryable                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------- |
| `APICallError` with a 2xx status (unreadable body)                                                                                                                                                                                                             | `LLMRequestError`, `unreadableResponse` | yes                                      |
| Name in the permanent set (`AI_UnsupportedFunctionalityError`, `AI_InvalidArgumentError`, `AI_InvalidPromptError`, `AI_MessageConversionError`, `AI_TypeValidationError`, `AI_NoSuchModelError`, `AI_NoSuchToolError`, and others) anywhere in the cause chain | `LLMRequestError`, `permanent`          | no                                       |
| `StreamIdleTimeoutError`                                                                                                                                                                                                                                       | `LLMRequestError`, `streamStalled`      | yes                                      |
| 401, or a credential failure                                                                                                                                                                                                                                   | `LLMAuthenticationError`                | no                                       |
| 403 about billing or plan                                                                                                                                                                                                                                      | `LLMRequestError`, `permanent`          | no                                       |
| 429                                                                                                                                                                                                                                                            | `LLMRateLimitError`                     | yes, unless out of credits (`permanent`) |
| Other 4xx                                                                                                                                                                                                                                                      | `LLMRequestError` with `statusCode`     | no                                       |
| 5xx                                                                                                                                                                                                                                                            | `LLMRequestError` with `statusCode`     | yes                                      |
| No status (connection, DNS, stream cut off, missing `finish`)                                                                                                                                                                                                  | `LLMRequestError`, no `statusCode`      | yes                                      |

`isRetryableLLMError` is the single predicate: rate limits that are not `permanent`, and
`LLMRequestError`s that are not `permanent` and have no status or a 5xx. Authentication errors
never retry. A 4xx with `contextOverflow` is not retried either; the agent loop reacts to it by
compacting.

### Retry loop

The streaming and batch executors share one retry budget and schedule: exponential backoff
from 1 second, jittered, capped at `MAX_RETRY_DELAY_SECONDS`, replaced by `Retry-After` when
the provider sends one, and abandoned when that wait exceeds `MAX_RETRY_AFTER_MS`. The whole
step, retries included, is bounded by `LLM_TIMEOUT_SECONDS`.

In the streaming executor, after 3 transient streaming failures
(`STREAMING_FAILURES_BEFORE_FALLBACK`) the remaining attempts use the non-streaming request.
A 429 does not count toward the 3. A stalled stream or an unreadable stream goes to the
fallback at once.

The stream idle watchdog fails a stream that stays silent: 120 seconds between parts by
default (`llm.streamIdleTimeoutMs` or `JAZZ_STREAM_IDLE_TIMEOUT_MS` override), and at least
300 seconds before the first content part (`FIRST_CONTENT_TIMEOUT_MS`).

## Empty finish

A completion is an empty finish when it has no visible text, no reasoning text, no tool
calls, no artifacts, no reasoning tokens and zero completion tokens (a missing usage report
counts as zero), and its finish reason is neither `content-filter` nor `length`.

Both executors pass every completion through `validateCompletion`. An empty finish becomes
an `LLMRequestError` with `emptyResponse: true` and no status code, so it takes the transient
retry path under the same budget. The rejected response's request count and usage are
recorded before it is discarded, because it never reaches the agent loop.

After the budget is spent, or when a run ends with an empty answer, `judgeAnswer` reports the
run as failed with `empty_response`. A `content-filter` finish is `content_filtered` and is
never retried, since the same prompt is withheld the same way.

## Options a provider can reject

Jazz decides most option support before the request, from the model's resolved capabilities,
and adjusts the request instead of failing it:

- Tools are dropped when the model does not take tools (`toolsDisabled` is set on the
  response and an info log is written).
- `temperature` is dropped when the model reports `supportsTemperature: false`.
- A reasoning effort the model does not list is clamped to the nearest supported one, with a
  one-time warning per provider, model and effort.

These three are silent to the model and the user, and are the opposite of "throw on
unsupported options". **Not enforced:** failing fast on an option Jazz cannot honor.

When a provider package itself rejects a request with `AI_UnsupportedFunctionalityError` or
another name in the permanent set, the error is `permanent`, is not retried, and is reported
as a rejected request. Any other rejection arrives as a status code and follows the table
above.

---

## Adding a provider

Before a provider is wired in, confirm against this page:

- Its usage reports `inputTokens` including cached input tokens.
- Its reasoning parts survive the round trip: add the provider to `resolveReasoningReplay` if
  it needs them back, and add a case to the fixtures table that proves they are stored with the
  provider's name.
- Its failures arrive as thrown errors or `error` parts, with a status code where the remote
  gave one.

See [Add a model provider](./add-a-provider.md) for the wiring steps.
