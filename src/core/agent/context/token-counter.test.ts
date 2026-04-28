import { describe, expect, it } from "bun:test";
import { countTokens as countCl100k } from "gpt-tokenizer/encoding/cl100k_base";
import { countTokens as countO200k } from "gpt-tokenizer/encoding/o200k_base";
import type { ChatMessage } from "@/core/types/message";
import { inferFamily, type ModelHint, TokenCounter } from "./token-counter";

const sysMsg = (content: string): ChatMessage => ({ role: "system", content });
const userMsg = (content: string): ChatMessage => ({ role: "user", content });
const assistantMsg = (content: string): ChatMessage => ({ role: "assistant", content });

describe("inferFamily", () => {
  const cases: Array<[ModelHint, ReturnType<typeof inferFamily>]> = [
    [{ provider: "openai", modelId: "gpt-4o" }, "openai-o200k"],
    [{ provider: "openai", modelId: "gpt-4o-mini" }, "openai-o200k"],
    [{ provider: "openai", modelId: "gpt-5" }, "openai-o200k"],
    [{ provider: "openai", modelId: "gpt-5-mini" }, "openai-o200k"],
    [{ provider: "openai", modelId: "gpt-4.1" }, "openai-o200k"],
    [{ provider: "openai", modelId: "gpt-4-turbo" }, "openai-cl100k"],
    [{ provider: "openai", modelId: "gpt-3.5-turbo" }, "openai-cl100k"],
    [{ provider: "openai", modelId: "o1-mini" }, "openai-o200k"],
    [{ provider: "openai", modelId: "o3-mini" }, "openai-o200k"],
    [{ provider: "anthropic", modelId: "claude-opus-4-6" }, "anthropic"],
    [{ provider: "openrouter", modelId: "anthropic/claude-3.5-sonnet" }, "anthropic"],
    [{ provider: "google", modelId: "gemini-2.5-pro" }, "google"],
    [{ provider: "openrouter", modelId: "google/gemini-2.5-flash" }, "google"],
    [{ provider: "mistral", modelId: "mistral-large-latest" }, "mistral"],
    [{ provider: "mistral", modelId: "ministral-8b-latest" }, "mistral"],
    [{ provider: "groq", modelId: "llama-3.1-70b" }, "llama"],
    [{ provider: "alibaba", modelId: "qwen3-max" }, "qwen"],
    [{ provider: "moonshotai", modelId: "kimi-k2" }, "qwen"],
    [{ provider: "minimax", modelId: "MiniMax-M2" }, "qwen"],
    [{ provider: "deepseek", modelId: "deepseek-chat" }, "deepseek"],
    [{ provider: "xai", modelId: "grok-4-fast-reasoning" }, "unknown"],
    [{ provider: "", modelId: "" }, "unknown"],
  ];

  for (const [hint, expected] of cases) {
    it(`infers ${expected} for ${hint.provider}/${hint.modelId}`, () => {
      expect(inferFamily(hint)).toBe(expected);
    });
  }
});

describe("TokenCounter — OpenAI families use gpt-tokenizer (exact)", () => {
  it("o200k encoding matches gpt-tokenizer count for plain text", () => {
    const counter = new TokenCounter();
    const hint: ModelHint = { provider: "openai", modelId: "gpt-4o" };
    const text = "The quick brown fox jumps over the lazy dog. Repeat 3 times.";

    expect(counter.countText(text, hint)).toBe(countO200k(text));
  });

  it("cl100k encoding matches gpt-tokenizer count for plain text", () => {
    const counter = new TokenCounter();
    const hint: ModelHint = { provider: "openai", modelId: "gpt-4-turbo" };
    const text = "The quick brown fox jumps over the lazy dog.";

    expect(counter.countText(text, hint)).toBe(countCl100k(text));
  });

  it("o200k handles JSON tool-call content via the encoder, not heuristic", () => {
    const counter = new TokenCounter();
    const hint: ModelHint = { provider: "openai", modelId: "gpt-5-mini" };
    const json = JSON.stringify({
      tool: "git_status",
      args: { porcelain: true, branch: "main" },
      meta: { iteration: 3 },
    });

    // Native encoder typically counts JSON in noticeably different counts than
    // length/4. Just assert we used the encoder (which we can verify by
    // matching its output exactly).
    expect(counter.countText(json, hint)).toBe(countO200k(json));
  });

  it("returns 0 for empty text", () => {
    const counter = new TokenCounter();
    expect(counter.countText("", { provider: "openai", modelId: "gpt-4o" })).toBe(0);
  });
});

describe("TokenCounter — non-OpenAI families use ratio fallback", () => {
  it("Anthropic uses ~3.5 chars/token by default", () => {
    const counter = new TokenCounter();
    const hint: ModelHint = { provider: "anthropic", modelId: "claude-opus-4-6" };
    // 70 chars / 3.5 = 20 tokens (ceil applies)
    const text = "a".repeat(70);

    expect(counter.countText(text, hint)).toBe(Math.ceil(70 / 3.5));
  });

  it("Google uses ~4.0 chars/token by default", () => {
    const counter = new TokenCounter();
    const hint: ModelHint = { provider: "google", modelId: "gemini-2.5-pro" };
    const text = "a".repeat(80);

    expect(counter.countText(text, hint)).toBe(Math.ceil(80 / 4.0));
  });

  it("Llama-style models use ~3.6 chars/token by default", () => {
    const counter = new TokenCounter();
    const hint: ModelHint = { provider: "groq", modelId: "llama-3.1-70b" };
    const text = "a".repeat(72);

    expect(counter.countText(text, hint)).toBe(Math.ceil(72 / 3.6));
  });

  it("Unknown family falls back to 4.0 chars/token", () => {
    const counter = new TokenCounter();
    const hint: ModelHint = { provider: "xai", modelId: "grok-4-fast-reasoning" };
    const text = "a".repeat(40);

    expect(counter.countText(text, hint)).toBe(10);
  });
});

describe("TokenCounter — message-level counting", () => {
  it("includes per-message overhead", () => {
    const counter = new TokenCounter();
    const hint: ModelHint = { provider: "openai", modelId: "gpt-4o" };
    const tokens = counter.countMessage(userMsg(""), hint);

    // Just the per-message base overhead (4) when content is empty
    expect(tokens).toBe(4);
  });

  it("adds tool_calls JSON to the count", () => {
    const counter = new TokenCounter();
    const hint: ModelHint = { provider: "openai", modelId: "gpt-4o" };
    const withCalls: ChatMessage = {
      role: "assistant",
      content: "I'll check the status.",
      tool_calls: [{ id: "1", type: "function", function: { name: "git_status", arguments: "{}" } }],
    };

    const without = counter.countMessage(assistantMsg("I'll check the status."), hint);
    const with_ = counter.countMessage(withCalls, hint);

    expect(with_).toBeGreaterThan(without);
  });

  it("counts tool result messages with overhead", () => {
    const counter = new TokenCounter();
    const hint: ModelHint = { provider: "openai", modelId: "gpt-4o" };
    const tool: ChatMessage = {
      role: "tool",
      content: "On branch main, working tree clean.",
      tool_call_id: "1",
    };

    expect(counter.countMessage(tool, hint)).toBeGreaterThan(0);
  });

  it("memoizes per (message, model) — repeated calls return cached value", () => {
    const counter = new TokenCounter();
    const hint: ModelHint = { provider: "openai", modelId: "gpt-4o" };
    const msg = userMsg("Hello world");

    const first = counter.countMessage(msg, hint);
    const second = counter.countMessage(msg, hint);

    expect(first).toBe(second);
  });

  it("countMessages sums across the array", () => {
    const counter = new TokenCounter();
    const hint: ModelHint = { provider: "openai", modelId: "gpt-4o" };
    const msgs = [sysMsg("System"), userMsg("Hi"), assistantMsg("Hello")];

    const sum = counter.countMessages(msgs, hint);
    const individual = msgs.reduce((acc, m) => acc + counter.countMessage(m, hint), 0);

    expect(sum).toBe(individual);
  });
});

describe("TokenCounter — calibration converges to authoritative truth", () => {
  it("first calibration sets the ratio to the observed value", () => {
    const counter = new TokenCounter();
    const hint: ModelHint = { provider: "anthropic", modelId: "claude-opus-4-6" };
    const msgs = [userMsg("a".repeat(700))];

    // Before calibration: 700 / 3.5 = 200 tokens
    expect(counter.countText("a".repeat(700), hint)).toBe(200);

    // Provider says actual was 175 tokens. Ratio should now be 700/175 = 4.0
    counter.calibrate(175, msgs, hint);
    expect(counter.getRatio(hint)).toBeCloseTo(4.0, 2);

    // Subsequent estimate uses the new ratio
    expect(counter.countText("a".repeat(700), hint)).toBe(Math.ceil(700 / 4.0));
  });

  it("subsequent calibrations smooth toward the new value (not whiplash)", () => {
    const counter = new TokenCounter();
    const hint: ModelHint = { provider: "anthropic", modelId: "claude-opus-4-6" };
    const msgs = [userMsg("a".repeat(700))];

    // Calibration 1: ratio = 4.0
    counter.calibrate(175, msgs, hint);
    expect(counter.getRatio(hint)).toBeCloseTo(4.0, 2);

    // Calibration 2: observed ratio 3.0 (700/233 ≈ 3.0). Smoothing 0.7 means
    // new = 0.7 * 3.0 + 0.3 * 4.0 = 3.3
    counter.calibrate(233, msgs, hint);
    const ratio = counter.getRatio(hint);
    expect(ratio).toBeGreaterThan(3.0);
    expect(ratio).toBeLessThan(4.0);
  });

  it("clamps ratios outside the [2.0, 6.0] sane range", () => {
    const counter = new TokenCounter();
    const hint: ModelHint = { provider: "anthropic", modelId: "claude-opus-4-6" };
    const msgs = [userMsg("a".repeat(100))];

    // Bogus usage report: 10000 tokens for 100 chars (ratio 0.01).
    // Should clamp to 2.0.
    counter.calibrate(10_000, msgs, hint);
    expect(counter.getRatio(hint)).toBe(2.0);

    // Reset and try the high end.
    counter.reset();
    // Bogus usage: 5 tokens for 100 chars (ratio 20). Clamp to 6.0.
    counter.calibrate(5, msgs, hint);
    expect(counter.getRatio(hint)).toBe(6.0);
  });

  it("ignores calibration with zero or negative authoritative count", () => {
    const counter = new TokenCounter();
    const hint: ModelHint = { provider: "anthropic", modelId: "claude-opus-4-6" };
    const before = counter.getRatio(hint);

    counter.calibrate(0, [userMsg("x".repeat(100))], hint);
    counter.calibrate(-1, [userMsg("x".repeat(100))], hint);

    expect(counter.getRatio(hint)).toBe(before);
  });

  it("ignores calibration with empty messages", () => {
    const counter = new TokenCounter();
    const hint: ModelHint = { provider: "anthropic", modelId: "claude-opus-4-6" };
    const before = counter.getRatio(hint);

    counter.calibrate(100, [], hint);
    counter.calibrate(100, [userMsg("")], hint);

    expect(counter.getRatio(hint)).toBe(before);
  });

  it("calibration is per-model (anthropic ratio doesn't affect google)", () => {
    const counter = new TokenCounter();
    const anthropicHint: ModelHint = { provider: "anthropic", modelId: "claude-opus-4-6" };
    const googleHint: ModelHint = { provider: "google", modelId: "gemini-2.5-pro" };

    counter.calibrate(175, [userMsg("a".repeat(700))], anthropicHint);

    expect(counter.getRatio(anthropicHint)).toBeCloseTo(4.0, 2);
    expect(counter.getRatio(googleHint)).toBe(4.0); // google default unchanged
  });

  it("calibration invalidates the message cache so new ratio takes effect", () => {
    const counter = new TokenCounter();
    const hint: ModelHint = { provider: "anthropic", modelId: "claude-opus-4-6" };
    const msg = userMsg("a".repeat(700));

    const before = counter.countMessage(msg, hint);
    counter.calibrate(175, [msg], hint); // ratio 4.0 vs default 3.5
    const after = counter.countMessage(msg, hint);

    expect(after).toBeLessThan(before);
  });
});

describe("TokenCounter — defensive paths", () => {
  it("does not throw on a hint with no provider or model", () => {
    const counter = new TokenCounter();
    expect(() => counter.countText("hello", { provider: "", modelId: "" })).not.toThrow();
  });

  it("reset clears all calibration state", () => {
    const counter = new TokenCounter();
    const hint: ModelHint = { provider: "anthropic", modelId: "claude-opus-4-6" };

    counter.calibrate(175, [userMsg("a".repeat(700))], hint);
    expect(counter.getRatio(hint)).toBeCloseTo(4.0, 2);

    counter.reset();
    expect(counter.getRatio(hint)).toBe(3.5);
  });
});
