import { describe, expect, it, mock } from "bun:test";
import { Chunk, Effect } from "effect";
import { StreamProcessor } from "./stream-processor";
import { type LoggerService } from "../../core/interfaces/logger";

describe("StreamProcessor", () => {
  const mockLogger = {
    debug: mock(() => {}),
    warn: mock(() => {}),
  } as unknown as LoggerService;

  it("should process text deltas and emit events", async () => {
    const events: any[] = [];
    const emit = (eff: Effect.Effect<Chunk.Chunk<any>, any>) => {
      const chunk = Effect.runSync(eff);
      events.push(...Chunk.toArray(chunk));
    };

    const processor = new StreamProcessor(
      { providerName: "p1", modelName: "m1", hasReasoningEnabled: false, startTime: Date.now() },
      emit,
      mockLogger,
    );

    // Mock fullStream iterator
    const mockResult = {
      fullStream: (async function* () {
        yield { type: "text-delta", text: "Hello" };
        yield { type: "text-delta", text: " world" };
        yield { type: "finish", finishReason: "stop" };
      })(),
      usage: Promise.resolve({ inputTokens: 5, outputTokens: 5, totalTokens: 10 }),
    } as any;

    const finalResponse = await processor.process(mockResult);

    expect(finalResponse.content).toBe("Hello world");
    expect(events.some((e) => e.type === "stream_start")).toBe(true);
    expect(events.some((e) => e.type === "text_chunk" && e.delta === "Hello")).toBe(true);
    expect(events.some((e) => e.type === "complete")).toBe(true);
  });

  it("should handle reasoning deltas when enabled", async () => {
    const events: any[] = [];
    const emit = (eff: Effect.Effect<Chunk.Chunk<any>, any>) => {
      const chunk = Effect.runSync(eff);
      events.push(...Chunk.toArray(chunk));
    };

    const processor = new StreamProcessor(
      { providerName: "p1", modelName: "m1", hasReasoningEnabled: true, startTime: Date.now() },
      emit,
      mockLogger,
    );

    const mockResult = {
      fullStream: (async function* () {
        yield { type: "reasoning-start" };
        yield { type: "reasoning-delta", text: "thinking..." };
        yield { type: "reasoning-end" };
        yield { type: "text-delta", text: "result" };
        yield { type: "finish", finishReason: "stop" };
      })(),
      usage: Promise.resolve({}),
    } as any;

    await processor.process(mockResult);

    expect(events.some((e) => e.type === "thinking_start")).toBe(true);
    expect(events.some((e) => e.type === "thinking_chunk" && e.content === "thinking...")).toBe(
      true,
    );
    expect(events.some((e) => e.type === "thinking_complete")).toBe(true);
  });
});
