import { describe, expect, it, mock } from "bun:test";
import { Chunk, Effect } from "effect";
import { selectParser } from "./reasoning";
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

  it("synthesises thinking_complete when text-delta arrives with reasoning still open", async () => {
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
        yield { type: "reasoning-delta", text: "thoughts" };
        // No reasoning-end — provider transitions straight to text-delta.
        yield { type: "text-delta", text: "answer" };
        yield { type: "finish", finishReason: "stop" };
      })(),
      usage: Promise.resolve({}),
    } as any;

    await processor.process(mockResult);

    const thinkingCompleteIdx = events.findIndex((e) => e.type === "thinking_complete");
    const firstTextChunkIdx = events.findIndex((e) => e.type === "text_chunk");
    expect(thinkingCompleteIdx).toBeGreaterThanOrEqual(0);
    expect(firstTextChunkIdx).toBeGreaterThan(thinkingCompleteIdx);
  });

  // -------------------------------------------------------------------------
  // Integration: selectParser → StreamProcessor end-to-end routing
  //
  // These tests cross the seam between the parser registry and the stream
  // processor. They guard the bug-class where a local model emits
  // <think>...</think> at runtime without surfacing any chat-template hint or
  // "thinking" capability — and the strict-gate registry would have left the
  // parser unwired, leaking reasoning into the response channel as literal
  // tagged text. Per-component unit tests on either side miss this seam.
  // -------------------------------------------------------------------------
  describe("selectParser → StreamProcessor integration", () => {
    function runWithParser(
      parser: ReturnType<typeof selectParser>,
      deltas: readonly string[],
    ): Promise<{
      events: any[];
      finalContent: string;
    }> {
      const events: any[] = [];
      const emit = (eff: Effect.Effect<Chunk.Chunk<any>, any>): void => {
        const chunk = Effect.runSync(eff);
        events.push(...Chunk.toArray(chunk));
      };
      const processor = new StreamProcessor(
        {
          providerName: "llamacpp",
          modelName: "no-metadata-local-model",
          hasReasoningEnabled: false,
          startTime: Date.now(),
          ...(parser ? { reasoningParser: parser } : {}),
        },
        emit,
        mockLogger,
      );
      const mockResult = {
        fullStream: (async function* () {
          for (const delta of deltas) {
            yield { type: "text-delta", text: delta };
          }
          yield { type: "finish", finishReason: "stop" };
        })(),
        usage: Promise.resolve({}),
      } as any;
      return processor
        .process(mockResult)
        .then((response) => ({ events, finalContent: response.content ?? "" }));
    }

    it("routes <think>…</think> to reasoning even when no chatTemplate or capability hints are set", async () => {
      // The model declares no metadata that would tip off the registry. Before
      // the selectParser fallback this returned null and reasoning leaked.
      const parser = selectParser({
        provider: "llamacpp",
        modelId: "no-metadata-local-model",
      });
      expect(parser).not.toBeNull();

      const { events, finalContent } = await runWithParser(parser, [
        "<think>let me deliberate first</think>",
        "actual answer",
      ]);

      const thinkingChunks = events.filter((e) => e.type === "thinking_chunk");
      const textChunks = events.filter((e) => e.type === "text_chunk");

      // Reasoning content lands on the reasoning channel.
      expect(thinkingChunks.map((c) => c.content).join("")).toContain("let me deliberate first");
      // The visible response never contains the raw tags or the deliberation.
      expect(finalContent).toBe("actual answer");
      expect(textChunks.every((c) => !String(c.delta).includes("<think>"))).toBe(true);
      expect(textChunks.every((c) => !String(c.delta).includes("deliberate"))).toBe(true);
      expect(events.some((e) => e.type === "thinking_start")).toBe(true);
      expect(events.some((e) => e.type === "thinking_complete")).toBe(true);
    });

    it("passes through plain text untouched when the model emits no reasoning tags", async () => {
      // Same no-metadata context — fallback parser is wired — but the stream
      // is plain prose. The parser should be a complete no-op.
      const parser = selectParser({
        provider: "llamacpp",
        modelId: "no-metadata-local-model",
      });

      const { events, finalContent } = await runWithParser(parser, [
        "Hello",
        " there, ",
        "no reasoning here.",
      ]);

      expect(finalContent).toBe("Hello there, no reasoning here.");
      expect(events.some((e) => e.type === "thinking_start")).toBe(false);
      expect(events.some((e) => e.type === "thinking_chunk")).toBe(false);
      expect(events.some((e) => e.type === "thinking_complete")).toBe(false);
    });

    it("does not wire a parser for Harmony format (would otherwise mangle delimiters)", async () => {
      // Harmony explicitly returns null from selectParser. Any reasoning-style
      // output from such a model leaks into the response — this is the known
      // limitation pending a dedicated Harmony parser. The test pins the
      // current behaviour so a future Harmony parser landing flips this case.
      const parser = selectParser({
        provider: "llamacpp",
        modelId: "gpt-oss-style",
        chatTemplate: "messages with <|channel|>analysis<|message|>...",
      });
      expect(parser).toBeNull();

      const { events, finalContent } = await runWithParser(parser, [
        "<|channel|>analysis<|message|>raw deliberation text",
      ]);

      expect(events.some((e) => e.type === "thinking_chunk")).toBe(false);
      expect(finalContent).toContain("raw deliberation text");
    });

    it("handles tags split across multiple text-delta chunks", async () => {
      // Real streams break tags across chunk boundaries — the parser must
      // buffer the partial open/close and not emit until the tag resolves.
      const parser = selectParser({
        provider: "llamacpp",
        modelId: "no-metadata-local-model",
      });

      const { events, finalContent } = await runWithParser(parser, [
        "<thi",
        "nk>partial",
        " thought</think>visible",
      ]);

      const thinkingChunks = events.filter((e) => e.type === "thinking_chunk");
      expect(thinkingChunks.map((c) => c.content).join("")).toContain("partial thought");
      expect(finalContent).toBe("visible");
    });
  });
});
