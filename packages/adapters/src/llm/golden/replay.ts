/**
 * A replay `LLMService` that serves recorded model calls in order.
 *
 * Each streaming call is answered with the next fixture entry: its recorded AI SDK `fullStream`
 * parts run through the real `StreamProcessor`, so stream events, usage, tool-call parsing and
 * the final `ChatCompletionResponse` come from shipping code. The provider is the only thing
 * faked.
 *
 * Replay fails loudly when the run drifts from the recording. A call beyond the fixture, a
 * different set of tools offered, or a different message-role sequence raises a
 * `GoldenReplayDivergence` defect whose message is a diff of expected against actual, and the
 * divergence is also kept in `replay.divergences` so a test can assert there were none even if
 * the run swallowed the defect. `replay.assertExhausted()` fails when the run made fewer calls
 * than recorded.
 *
 * Use `createGoldenReplay(fixture)` and provide `replay.layer` as the `LLMService`.
 */

import type { LLMService } from "@jazz/core/interfaces/llm";
import { LLMServiceTag } from "@jazz/core/interfaces/llm";
import type { ChatCompletionOptions, ChatCompletionResponse, StreamEvent } from "@jazz/core/types";
import { LLMRequestError, type LLMError } from "@jazz/core/types/errors";
import { Chunk, Effect, Layer, Stream } from "effect";
import type { GoldenCall, GoldenFixture, GoldenRequestSummary } from "./fixture";
import { summarizeRequest } from "./record-env";
import { StreamProcessor, type StreamTextResult } from "../stream-processor";

export class GoldenReplayDivergence extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoldenReplayDivergence";
  }
}

export interface GoldenReplay {
  readonly layer: Layer.Layer<LLMService>;
  readonly service: LLMService;
  /** The requests the run made, in order, summarized the way the recording summarizes them. */
  readonly requests: GoldenRequestSummary[];
  readonly divergences: string[];
  /** Fails when the run made fewer model calls than the fixture holds. */
  assertExhausted(): void;
}

/** A diff-like description of how a request differs from the recorded one, empty when it matches. */
export function describeRequestDrift(
  callIndex: number,
  expected: GoldenRequestSummary,
  actual: GoldenRequestSummary,
): string {
  const lines: string[] = [];
  const expectedTools = [...expected.toolNames].sort();
  const actualTools = [...actual.toolNames].sort();
  if (expectedTools.join("\0") !== actualTools.join("\0")) {
    for (const name of expectedTools.filter((tool) => !actualTools.includes(tool))) {
      lines.push(`  - tool offered in recording but missing now: ${name}`);
    }
    for (const name of actualTools.filter((tool) => !expectedTools.includes(tool))) {
      lines.push(`  + tool offered now but absent from recording: ${name}`);
    }
  }
  if (expected.messageRoles.join(",") !== actual.messageRoles.join(",")) {
    lines.push(`  - roles in recording: ${expected.messageRoles.join(" ")}`);
    lines.push(`  + roles now:          ${actual.messageRoles.join(" ")}`);
  }
  return lines.length === 0
    ? ""
    : `model call #${callIndex + 1} drifted from the recording:\n${lines.join("\n")}`;
}

function replayStream(
  call: GoldenCall,
  provider: string,
  model: string,
): {
  readonly stream: Stream.Stream<StreamEvent, LLMError>;
  readonly response: Effect.Effect<ChatCompletionResponse, LLMError>;
} {
  let run: Promise<{ events: StreamEvent[]; response: ChatCompletionResponse }> | undefined;

  const ensureRun = (): Promise<{ events: StreamEvent[]; response: ChatCompletionResponse }> => {
    run ??= (async () => {
      const events: StreamEvent[] = [];
      const processor = new StreamProcessor(
        {
          providerName: provider,
          modelName: model,
          hasReasoningEnabled: false,
          startTime: Date.now(),
        },
        (effect) => {
          const exit = Effect.runSyncExit(effect);
          if (exit._tag === "Success") {
            events.push(...Chunk.toArray(exit.value));
          }
        },
        silentLogger,
      );
      const result = {
        fullStream: Stream.toAsyncIterable(Stream.fromIterable(call.parts)),
        usage: Promise.resolve(undefined),
        providerMetadata: Promise.resolve(undefined),
        response: Promise.resolve({ messages: [] }),
        files: Promise.resolve([]),
      } as unknown as StreamTextResult;
      const response = await processor.process(result);
      return { events, response };
    })();
    return run;
  };

  const toRequestError = (error: unknown): LLMError =>
    new LLMRequestError({
      provider,
      message: error instanceof Error ? error.message : String(error),
    });

  return {
    stream: Stream.fromEffect(Effect.tryPromise({ try: ensureRun, catch: toRequestError })).pipe(
      Stream.flatMap(({ events }) => Stream.fromIterable(events)),
    ),
    response: Effect.tryPromise({ try: ensureRun, catch: toRequestError }).pipe(
      Effect.map(({ response }) => response),
    ),
  };
}

const silentLogger = new Proxy(
  {},
  { get: () => () => Effect.void },
) as unknown as ConstructorParameters<typeof StreamProcessor>[2];

export function createGoldenReplay(fixture: GoldenFixture): GoldenReplay {
  const requests: GoldenRequestSummary[] = [];
  const divergences: string[] = [];
  let nextCall = 0;

  const diverge = (message: string): Effect.Effect<never> => {
    divergences.push(message);
    return Effect.die(new GoldenReplayDivergence(message));
  };

  const service = {
    getProvider: () =>
      Effect.succeed({
        name: fixture.provider,
        supportedModels: [{ id: fixture.model, supportsTools: true }],
        defaultModel: fixture.model,
        authenticate: () => Effect.void,
      }),
    listProviders: () => Effect.succeed([]),
    supportsNativeWebSearch: () => Effect.succeed(false),
    resolveReasoningControl: () => Effect.succeed({ kind: "unknown" as const }),
    createChatCompletion: () =>
      diverge(
        `unexpected non-streaming model call; the recording holds only streamed calls (${fixture.calls.length})`,
      ),
    createStreamingChatCompletion: (_provider: string, options: ChatCompletionOptions) =>
      Effect.suspend(() => {
        const summary = summarizeRequest(options.messages, options.tools);
        requests.push(summary);
        const index = nextCall;
        nextCall += 1;
        const call = fixture.calls[index];
        if (call === undefined) {
          return diverge(
            `model call #${index + 1} has no recording: scenario "${fixture.scenario}" holds ${fixture.calls.length} call(s) but the run asked for more`,
          );
        }
        const drift = describeRequestDrift(index, call.request, summary);
        if (drift !== "") {
          return diverge(drift);
        }
        const replayed = replayStream(call, fixture.provider, fixture.model);
        return Effect.succeed({ ...replayed, cancel: Effect.void });
      }),
  } as unknown as LLMService;

  return {
    layer: Layer.succeed(LLMServiceTag, service),
    service,
    requests,
    divergences,
    assertExhausted() {
      if (nextCall !== fixture.calls.length) {
        throw new GoldenReplayDivergence(
          `scenario "${fixture.scenario}" recorded ${fixture.calls.length} model call(s) but the run made ${nextCall}`,
        );
      }
    },
  };
}
