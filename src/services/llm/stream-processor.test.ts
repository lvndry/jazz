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

  it("surfaces reasoning even when reasoning was not user-enabled", async () => {
    // Local OpenAI-compatible servers (e.g. llama.cpp with --jinja) may emit
    // reasoning_content for any chat completion regardless of whether the
    // caller asked for reasoning. The processor should still capture and
    // expose that text rather than silently drop it.
    const events: any[] = [];
    const emit = (eff: Effect.Effect<Chunk.Chunk<any>, any>) => {
      const chunk = Effect.runSync(eff);
      events.push(...Chunk.toArray(chunk));
    };

    const processor = new StreamProcessor(
      {
        providerName: "llamacpp",
        modelName: "qwen",
        hasReasoningEnabled: false,
        startTime: Date.now(),
      },
      emit,
      mockLogger,
    );

    const mockResult = {
      fullStream: (async function* () {
        yield { type: "reasoning-start" };
        yield { type: "reasoning-delta", text: "let me think... " };
        yield { type: "reasoning-delta", text: "the answer is 42." };
        yield { type: "reasoning-end" };
        yield { type: "finish", finishReason: "stop" };
      })(),
      usage: Promise.resolve({}),
    } as any;

    const finalResponse = await processor.process(mockResult);

    expect(finalResponse.content).toBe("");
    expect(finalResponse.reasoning).toBe("let me think... the answer is 42.");
    expect(events.some((e) => e.type === "thinking_start")).toBe(true);
    expect(
      events.some((e) => e.type === "thinking_chunk" && e.content === "let me think... "),
    ).toBe(true);
    expect(events.some((e) => e.type === "thinking_complete")).toBe(true);
  });

  it("populates response.reasoning alongside content when both are present", async () => {
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
        yield { type: "reasoning-delta", text: "deliberation" };
        yield { type: "reasoning-end" };
        yield { type: "text-delta", text: "answer" };
        yield { type: "finish", finishReason: "stop" };
      })(),
      usage: Promise.resolve({}),
    } as any;

    const finalResponse = await processor.process(mockResult);

    expect(finalResponse.content).toBe("answer");
    expect(finalResponse.reasoning).toBe("deliberation");
  });

  it("with no reasoningParser, text-delta events stream as today (regression)", async () => {
    const events: any[] = [];
    const emit = (eff: Effect.Effect<Chunk.Chunk<any>, any>) => {
      const chunk = Effect.runSync(eff);
      events.push(...Chunk.toArray(chunk));
    };

    const processor = new StreamProcessor(
      {
        providerName: "anthropic",
        modelName: "claude",
        hasReasoningEnabled: false,
        startTime: Date.now(),
      },
      emit,
      mockLogger,
    );

    const mockResult = {
      fullStream: (async function* () {
        yield { type: "text-delta", text: "Hello" };
        yield { type: "text-delta", text: " <think> not parsed </think> world" };
        yield { type: "finish", finishReason: "stop" };
      })(),
      usage: Promise.resolve({ inputTokens: 5, outputTokens: 5, totalTokens: 10 }),
    } as any;

    const finalResponse = await processor.process(mockResult);
    expect(finalResponse.content).toBe("Hello <think> not parsed </think> world");
    expect(events.some((e) => e.type === "thinking_start")).toBe(false);
  });

  it("with reasoningParser, splits inline <think> content into thinking_* and text_chunk events", async () => {
    const events: any[] = [];
    const emit = (eff: Effect.Effect<Chunk.Chunk<any>, any>) => {
      const chunk = Effect.runSync(eff);
      events.push(...Chunk.toArray(chunk));
    };

    const { TagPairParser } = await import("./reasoning/tag-pair-parser");

    const processor = new StreamProcessor(
      {
        providerName: "llamacpp",
        modelName: "qwen3-4b",
        hasReasoningEnabled: true,
        startTime: Date.now(),
        reasoningParser: new TagPairParser(),
      },
      emit,
      mockLogger,
    );

    const mockResult = {
      fullStream: (async function* () {
        yield { type: "text-delta", text: "<think>let me think</think>The answer is 4" };
        yield { type: "finish", finishReason: "stop" };
      })(),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 5, totalTokens: 6 }),
    } as any;

    const finalResponse = await processor.process(mockResult);

    expect(finalResponse.content).toBe("The answer is 4");

    const thinkingStart = events.find((e) => e.type === "thinking_start");
    const thinkingChunks = events.filter((e) => e.type === "thinking_chunk");
    const thinkingComplete = events.find((e) => e.type === "thinking_complete");
    const textChunks = events.filter((e) => e.type === "text_chunk");

    expect(thinkingStart).toBeDefined();
    expect(thinkingChunks.map((c) => c.content).join("")).toBe("let me think");
    expect(thinkingComplete).toBeDefined();
    expect(textChunks.map((c) => c.delta).join("")).toBe("The answer is 4");
  });

  it("with reasoningParser, suppresses thinking_start for whitespace-only blocks", async () => {
    const events: any[] = [];
    const emit = (eff: Effect.Effect<Chunk.Chunk<any>, any>) => {
      const chunk = Effect.runSync(eff);
      events.push(...Chunk.toArray(chunk));
    };
    const { TagPairParser } = await import("./reasoning/tag-pair-parser");

    const processor = new StreamProcessor(
      {
        providerName: "llamacpp",
        modelName: "qwen3-4b",
        hasReasoningEnabled: false,
        startTime: Date.now(),
        reasoningParser: new TagPairParser(),
      },
      emit,
      mockLogger,
    );

    const mockResult = {
      fullStream: (async function* () {
        yield { type: "text-delta", text: "<think>\n\n</think>The answer is 4" };
        yield { type: "finish", finishReason: "stop" };
      })(),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 5, totalTokens: 6 }),
    } as any;

    await processor.process(mockResult);
    expect(events.some((e) => e.type === "thinking_start")).toBe(false);
    expect(events.some((e) => e.type === "thinking_chunk")).toBe(false);
  });

  it("flushes the reasoningParser when the stream ends mid-thinking", async () => {
    const events: any[] = [];
    const emit = (eff: Effect.Effect<Chunk.Chunk<any>, any>) => {
      const chunk = Effect.runSync(eff);
      events.push(...Chunk.toArray(chunk));
    };
    const { TagPairParser } = await import("./reasoning/tag-pair-parser");

    const processor = new StreamProcessor(
      {
        providerName: "llamacpp",
        modelName: "qwen3-4b",
        hasReasoningEnabled: true,
        startTime: Date.now(),
        reasoningParser: new TagPairParser(),
      },
      emit,
      mockLogger,
    );

    const mockResult = {
      fullStream: (async function* () {
        yield { type: "text-delta", text: "<think>truncated thought" };
        yield { type: "finish", finishReason: "length" };
      })(),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 5, totalTokens: 6 }),
    } as any;

    await processor.process(mockResult);

    const thinkingChunks = events.filter((e) => e.type === "thinking_chunk");
    const thinkingComplete = events.find((e) => e.type === "thinking_complete");

    expect(thinkingChunks.map((c) => c.content).join("")).toBe("truncated thought");
    expect(thinkingComplete).toBeDefined();
  });
});
