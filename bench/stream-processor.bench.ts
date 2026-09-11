// The producer end of the streaming chain. `activity-reducer`, `store-writes`
// and `transcript-rows` all measure what happens *after* a stream event
// exists; this measures making them. One provider text-delta becomes one
// `text_chunk` event, and each carries the whole reply so far
// (`accumulated`), so the per-delta cost of that field alone grows with the
// reply — a 2k-delta reply copies its own text 2k times.
//
// The provider is replaced by an already-resolved async iterable, so no
// network or provider latency lands in these numbers: what is left is the
// switch, the accumulation, the idle-timeout wrapper's per-step timer, and
// event construction. `emit` is a no-op, so the Effect stream's own queueing
// is out of scope — this is the processor's share, not the pipeline's.
import { Effect } from "effect";
import { bench, benchAsync, report } from "./harness";
import { TagPairParser } from "../packages/adapters/src/llm/reasoning/tag-pair-parser";
import {
  StreamProcessor,
  resolveStreamIdleTimeoutMs,
} from "../packages/adapters/src/llm/stream-processor";
import type { LoggerService } from "../packages/core/src/interfaces/logger";

const DELTAS = Number(process.env["BENCH_DELTAS"] ?? 2_000);

// Silent, allocation-free: the processor logs timing lines on the hot path, so
// a logger that formatted or wrote anything would be measuring the logger.
const silentLogger = {
  debug: () => Effect.void,
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
  writeToFile: () => Effect.void,
  logToolCall: () => Effect.void,
  setLogGroup: () => Effect.void,
  clearLogGroup: () => Effect.void,
} as unknown as LoggerService;

type StreamPart = Record<string, unknown>;

/** A plain reply: text deltas, then finish. */
function textParts(deltaCount: number): StreamPart[] {
  const parts: StreamPart[] = [];
  for (let index = 0; index < deltaCount; index += 1) {
    parts.push({ type: "text-delta", text: `token${String(index)} ` });
  }
  parts.push({ type: "finish", finishReason: "stop" });
  return parts;
}

/** A reasoning model: structured reasoning parts, then the visible answer. */
function reasoningParts(deltaCount: number): StreamPart[] {
  const parts: StreamPart[] = [{ type: "reasoning-start" }];
  for (let index = 0; index < deltaCount / 2; index += 1) {
    parts.push({ type: "reasoning-delta", text: `thought${String(index)} ` });
  }
  parts.push({ type: "reasoning-end" });
  for (let index = 0; index < deltaCount / 2; index += 1) {
    parts.push({ type: "text-delta", text: `token${String(index)} ` });
  }
  parts.push({ type: "finish", finishReason: "stop" });
  return parts;
}

/** A tool-calling turn: some text, then a batch of calls. */
function toolCallParts(callCount: number): StreamPart[] {
  const parts: StreamPart[] = [{ type: "text-delta", text: "Reading the files first. " }];
  for (let index = 0; index < callCount; index += 1) {
    parts.push({
      type: "tool-call",
      toolCallId: `call-${String(index)}`,
      toolName: "read_file",
      input: { path: `src/module-${String(index)}.ts`, startLine: 1, endLine: 200 },
    });
  }
  parts.push({ type: "finish", finishReason: "tool-calls" });
  return parts;
}

const usage = Promise.resolve({ inputTokens: 1_200, outputTokens: 800, totalTokens: 2_000 });
const response = Promise.resolve({ messages: [] });

/**
 * Stand-in for the AI SDK's `StreamTextResult`. `fullStream` is re-created per
 * run (an async generator is single-shot), while `usage` and `response` are
 * pre-resolved so `buildFinalResponse` never waits on its 50ms races.
 */
function fakeResult(parts: readonly StreamPart[]): Parameters<StreamProcessor["process"]>[0] {
  return {
    get fullStream() {
      return (async function* () {
        for (const part of parts) {
          yield part;
        }
      })();
    },
    usage,
    response,
  } as unknown as Parameters<StreamProcessor["process"]>[0];
}

function processor(reasoningParser?: TagPairParser): StreamProcessor {
  return new StreamProcessor(
    {
      providerName: "openai",
      modelName: "gpt-4o",
      hasReasoningEnabled: reasoningParser !== undefined,
      startTime: Date.now(),
      ...(reasoningParser ? { reasoningParser } : {}),
    },
    () => undefined,
    silentLogger,
  );
}

const plain = textParts(DELTAS);
const short = textParts(50);
const reasoning = reasoningParts(DELTAS);
const toolCalls = toolCallParts(20);
// In-band reasoning tags, the local-model shape: the parser sits between the
// provider delta and the emitted event.
const tagged = [
  { type: "text-delta", text: "<think>" },
  ...textParts(DELTAS).slice(0, -1),
  { type: "text-delta", text: "</think>" },
  { type: "text-delta", text: "Here is the answer. " },
  { type: "finish", finishReason: "stop" },
];

const results = [
  await benchAsync(
    `process ${String(DELTAS)} text deltas`,
    async () => {
      await processor().process(fakeResult(plain));
    },
    { iterations: 20, warmupIterations: 3 },
  ),
  // A short reply, where fixed per-stream work (start/finish events, final
  // response assembly) dominates instead of the per-delta path.
  await benchAsync(
    "process 50 text deltas (short reply)",
    async () => {
      await processor().process(fakeResult(short));
    },
    { iterations: 60, warmupIterations: 5 },
  ),
  await benchAsync(
    `process ${String(DELTAS)} deltas, structured reasoning`,
    async () => {
      await processor().process(fakeResult(reasoning));
    },
    { iterations: 20, warmupIterations: 3 },
  ),
  await benchAsync(
    `process ${String(DELTAS)} deltas through TagPairParser`,
    async () => {
      await processor(new TagPairParser()).process(fakeResult(tagged));
    },
    { iterations: 20, warmupIterations: 3 },
  ),
  await benchAsync(
    "process 20 tool calls",
    async () => {
      await processor().process(fakeResult(toolCalls));
    },
    { iterations: 60, warmupIterations: 5 },
  ),
  bench("resolveStreamIdleTimeoutMs", () => {
    resolveStreamIdleTimeoutMs(undefined, {});
  }),
];

report("stream-processor", results);
