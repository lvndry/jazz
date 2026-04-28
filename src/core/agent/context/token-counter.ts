/**
 * Token counting for context-window decisions.
 *
 * Two tiers:
 *
 * 1. **Authoritative calibration.** After each LLM call, the AI SDK returns
 *    `usage.promptTokens` — the model's own count for the messages we sent.
 *    Pass it to `calibrate()` and the counter learns a per-model
 *    chars-per-token ratio. This is ground truth.
 *
 * 2. **Pre-call estimate.** Before the next call, `countMessages()` needs to
 *    decide whether to compact. For OpenAI-family encodings we use
 *    `gpt-tokenizer` (pure JS, no native deps) for an exact count. For
 *    everything else we use the calibrated ratio if we have one, else a
 *    family-default seed.
 *
 * The seed values (Claude ≈ 3.5 chars/token, Gemini ≈ 4.0, etc.) come from
 * empirical samples across long English+JSON traces. They drift toward truth
 * after the first round-trip via calibration.
 *
 * Why no Anthropic-specific tokenizer: `@anthropic-ai/tokenizer` is stale
 * (Claude-2 era) and the official `count_tokens` API requires a network call.
 * Calibration converges to the right ratio in one round trip and costs
 * nothing.
 */

import { countTokens as countCl100k } from "gpt-tokenizer/encoding/cl100k_base";
import { countTokens as countO200k } from "gpt-tokenizer/encoding/o200k_base";
import type { ChatMessage } from "@/core/types/message";

/** Tokenizer family — drives both encoding choice and default ratio. */
export type ModelFamily =
  | "openai-o200k" // gpt-4o, gpt-4.1, gpt-5.x
  | "openai-cl100k" // gpt-3.5, gpt-4, gpt-4-turbo
  | "anthropic"
  | "google"
  | "mistral"
  | "llama" // most open-weight models, served via Groq/Cerebras/Fireworks/Together
  | "qwen"
  | "deepseek"
  | "unknown";

/** Hint used to pick a tokenizer family. */
export interface ModelHint {
  /** Provider name (e.g. "openai", "anthropic"). May be empty when unknown. */
  readonly provider: string;
  /** Model id as understood by the provider. */
  readonly modelId: string;
}

/**
 * Family default chars-per-token ratios.
 *
 * These are starting points before calibration kicks in. Sources: empirical
 * samples on representative agent traces (markdown + JSON tool calls). They
 * drift toward the model's true ratio after the first authoritative usage
 * report. The clamp range in `calibrate()` ([2, 6]) bounds how far they can
 * move from outliers.
 */
const FAMILY_DEFAULT_RATIO: Record<ModelFamily, number> = {
  "openai-o200k": 4.0,
  "openai-cl100k": 4.0,
  anthropic: 3.5,
  google: 4.0,
  mistral: 3.8,
  llama: 3.6,
  qwen: 3.5,
  deepseek: 3.8,
  unknown: 4.0,
};

/** Per-message overhead (role tag, separators) in tokens. */
const MESSAGE_BASE_OVERHEAD = 4;
/** Bonus tokens for tool-result messages beyond the content cost. */
const TOOL_RESULT_OVERHEAD = 10;

/** Smoothing factor applied to new observations during calibration. */
const CALIBRATION_SMOOTHING = 0.7;
/** Lower bound on calibrated chars-per-token (anything lower is an accounting bug). */
const RATIO_MIN = 2.0;
/** Upper bound on calibrated chars-per-token. */
const RATIO_MAX = 6.0;

/**
 * Infer tokenizer family from a model hint.
 *
 * Routing is based on provider id first, then model-id substrings. When the
 * hint is empty, returns "unknown" (uses default 4.0 ratio).
 */
export function inferFamily(hint: ModelHint): ModelFamily {
  const provider = hint.provider.toLowerCase();
  const id = hint.modelId.toLowerCase();

  if (provider === "openai" || id.startsWith("gpt-") || id.startsWith("o1") || id.startsWith("o3")) {
    // o200k for gpt-4o, gpt-4.1, gpt-5.x; cl100k for older gpt-3.5/gpt-4
    if (
      id.startsWith("gpt-4o") ||
      id.startsWith("gpt-4.1") ||
      id.startsWith("gpt-5") ||
      id.startsWith("o1") ||
      id.startsWith("o3")
    ) {
      return "openai-o200k";
    }
    return "openai-cl100k";
  }
  if (provider === "anthropic" || id.includes("claude")) return "anthropic";
  if (provider === "google" || id.includes("gemini")) return "google";
  if (
    provider === "mistral" ||
    id.includes("mistral") ||
    id.includes("ministral") ||
    id.includes("magistral")
  ) {
    return "mistral";
  }
  if (id.includes("llama")) return "llama";
  if (provider === "alibaba" || id.includes("qwen")) return "qwen";
  if (
    provider === "moonshotai" ||
    provider === "minimax" ||
    id.includes("kimi") ||
    id.includes("minimax")
  ) {
    return "qwen"; // Chinese-language BPE family, ratio close to qwen
  }
  if (provider === "deepseek" || id.includes("deepseek")) return "deepseek";
  return "unknown";
}

/**
 * Per-model token counter with authoritative calibration.
 *
 * Thread-safe is not a goal — instances are owned by a single agent run.
 * Memoization uses a WeakMap keyed by message reference so trimmed messages
 * are garbage-collected automatically.
 */
export class TokenCounter {
  /** Per-model calibrated chars-per-token. Updated via calibrate(). */
  private calibratedRatio = new Map<string, number>();

  /**
   * Per-message memoization: maps message → cached count.
   * Stores modelKey at compute-time so a later calibration (which invalidates
   * the cache by replacing the WeakMap) doesn't mismatch.
   */
  private messageCache = new WeakMap<ChatMessage, number>();

  /**
   * Count tokens in a string under the given model.
   *
   * Uses gpt-tokenizer for OpenAI families (exact). Falls back to the
   * calibrated or family-default chars-per-token ratio for other providers.
   */
  countText(text: string, hint: ModelHint): number {
    if (text.length === 0) return 0;
    const family = inferFamily(hint);

    if (family === "openai-o200k") {
      try {
        return countO200k(text);
      } catch {
        // gpt-tokenizer can throw on malformed UTF-16 surrogate pairs.
        // Fall through to ratio-based estimate rather than crashing the run.
      }
    }
    if (family === "openai-cl100k") {
      try {
        return countCl100k(text);
      } catch {
        // Same defensive fallthrough as o200k above.
      }
    }

    const ratio = this.ratioFor(hint, family);
    return Math.ceil(text.length / ratio);
  }

  /**
   * Count tokens in a single ChatMessage (content + tool calls + overhead).
   * Memoized per (message reference, model).
   */
  countMessage(msg: ChatMessage, hint: ModelHint): number {
    const cached = this.messageCache.get(msg);
    if (cached !== undefined) return cached;

    let tokens = MESSAGE_BASE_OVERHEAD;
    if (msg.content) {
      tokens += this.countText(msg.content, hint);
    }
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      tokens += this.countText(JSON.stringify(msg.tool_calls), hint);
    } else if (msg.role === "tool" && msg.tool_call_id) {
      tokens += TOOL_RESULT_OVERHEAD;
    }

    this.messageCache.set(msg, tokens);
    return tokens;
  }

  /** Sum tokens across an array of messages. */
  countMessages(msgs: readonly ChatMessage[], hint: ModelHint): number {
    let total = 0;
    for (const msg of msgs) total += this.countMessage(msg, hint);
    return total;
  }

  /**
   * Update the per-model calibration based on an authoritative usage report.
   *
   * Call after each LLM response with `usage.promptTokens` and the message
   * list that produced it. Invalidates the per-message memoization for that
   * model so subsequent estimates use the new ratio.
   *
   * No-op when authoritativePromptTokens or content size is non-positive
   * (defensive: guards against bogus usage reports).
   */
  calibrate(
    authoritativePromptTokens: number,
    messagesAtCallTime: readonly ChatMessage[],
    hint: ModelHint,
  ): void {
    if (authoritativePromptTokens <= 0) return;

    let totalChars = 0;
    for (const msg of messagesAtCallTime) {
      if (msg.content) totalChars += msg.content.length;
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        totalChars += JSON.stringify(msg.tool_calls).length;
      }
    }
    if (totalChars === 0) return;

    const observedRatio = totalChars / authoritativePromptTokens;
    const modelKey = this.modelKey(hint);
    const prior = this.calibratedRatio.get(modelKey);
    const smoothed =
      prior !== undefined
        ? (1 - CALIBRATION_SMOOTHING) * prior + CALIBRATION_SMOOTHING * observedRatio
        : observedRatio;
    const clamped = Math.max(RATIO_MIN, Math.min(RATIO_MAX, smoothed));

    this.calibratedRatio.set(modelKey, clamped);

    // Invalidate the per-message cache. WeakMap can't be filtered, so we
    // discard it. Hot messages are recomputed on next access; cold messages
    // (already trimmed away) are GC'd by the WeakMap.
    this.messageCache = new WeakMap<ChatMessage, number>();
  }

  /**
   * Return the calibrated ratio for the given model, or the family default
   * if no calibration has happened yet. Exposed for tests and diagnostics.
   */
  getRatio(hint: ModelHint): number {
    return this.ratioFor(hint, inferFamily(hint));
  }

  /** Reset all calibration state. Useful for tests. */
  reset(): void {
    this.calibratedRatio.clear();
    this.messageCache = new WeakMap<ChatMessage, number>();
  }

  private ratioFor(hint: ModelHint, family: ModelFamily): number {
    const calibrated = this.calibratedRatio.get(this.modelKey(hint));
    if (calibrated !== undefined) return calibrated;
    return FAMILY_DEFAULT_RATIO[family];
  }

  private modelKey(hint: ModelHint): string {
    return `${hint.provider}::${hint.modelId}`;
  }
}

/**
 * Default singleton wired through DEFAULT_CONTEXT_WINDOW_MANAGER.
 * Held module-scoped so calibration accumulates across the session.
 */
export const DEFAULT_TOKEN_COUNTER = new TokenCounter();
