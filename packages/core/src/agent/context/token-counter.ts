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
 * The `gpt-tokenizer` encoders (~3.5 MB of BPE tables, hundreds of ms to
 * evaluate) are deferred past startup: statically imported they sit on every
 * startup's critical path, and even a top-level dynamic import just moves the
 * evaluation into startup's event-loop gaps, which is still startup. The
 * preload starts ~1.5 s after module load (well after first paint) and, as a
 * backstop, at the first OpenAI-family count. Until it lands, OpenAI text is
 * priced with the same ratio estimate other families use; such estimates are
 * deliberately not message-cached, so the first exact count after the
 * encoders arrive supersedes them.
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

import { describeAttachment, inlineAttachmentMessageIndices } from "@/core/types/attachment";
import type { ChatMessage } from "@/core/types/message";
import { estimateAttachmentsTokens } from "./attachment-tokens";

type CountTokens = (text: string) => number;

interface GptEncoders {
  readonly cl100k: CountTokens;
  readonly o200k: CountTokens;
}

/** Tokenizer family — drives both encoding choice and default ratio. */
export type ModelFamily =
  | "openai-o200k" // gpt-4o, gpt-4.1, gpt-5.x
  | "openai-cl100k" // gpt-3.5, gpt-4, gpt-4-turbo
  | "anthropic"
  | "gemini"
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
  gemini: 4.0,
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
/** Characters of already-counted text one counter keeps BPE results for. */
const BPE_CACHE_MAX_CHARS = 4_000_000;

/** Smoothing factor applied to new observations during calibration. */
const CALIBRATION_SMOOTHING = 0.7;
/** Lower bound on calibrated chars-per-token (anything lower is an accounting bug). */
const RATIO_MIN = 2.0;
/** Upper bound on calibrated chars-per-token. */
const RATIO_MAX = 6.0;

/**
 * The gpt-tokenizer encoders once the background preload has resolved, or
 * undefined until then (or forever, if the package failed to load — the
 * ratio fallback keeps counting in that case).
 */
let gptEncoders: GptEncoders | undefined;
let gptEncodersReady: Promise<void> | undefined;

/**
 * How long after module load the background encoder preload starts.
 *
 * Interactive startup (config load, agent catalog, TUI init, first paint) takes
 * several hundred ms; starting the preload inside that window just reschedules
 * ~300 ms of encoder evaluation into startup's event-loop gaps and buys nothing
 * (measured). Starting it after first paint moves the cost out of the window
 * users actually feel, and any real count — the first LLM round trip is always
 * later than this — finds the encoders loaded.
 */
const DEFER_ENCODER_PRELOAD_MS = 1500;

async function loadGptEncoders(): Promise<void> {
  if (gptEncoders !== undefined) return;
  const [cl100k, o200k] = await Promise.all([
    import("gpt-tokenizer/encoding/cl100k_base"),
    import("gpt-tokenizer/encoding/o200k_base"),
  ]);
  gptEncoders = { cl100k: cl100k.countTokens, o200k: o200k.countTokens };
}

/**
 * Await the encoder preload. Callers that need exact counts immediately
 * (tests, one-shot scripts) can await this; the agent loop never does — it
 * tolerates the short estimate window described above.
 */
export function ensureGptEncoders(): Promise<void> {
  gptEncodersReady ??= loadGptEncoders().catch((error) => {
    gptEncoders = undefined;
    process.stderr.write(
      `jazz: gpt-tokenizer failed to load; OpenAI models fall back to ratio estimates: ${String(error)}\n`,
    );
  });
  return gptEncodersReady;
}

/** Test hook: forget the loaded encoders to exercise the not-yet-loaded path. */
export function resetGptEncodersForTests(): void {
  gptEncoders = undefined;
  gptEncodersReady = undefined;
}

// Unreferenced so a one-shot invocation that never counts an OpenAI model
// (and exits before the delay) never pays for the tables at all.
const deferredEncoderPreload = setTimeout(() => {
  void ensureGptEncoders();
}, DEFER_ENCODER_PRELOAD_MS);
deferredEncoderPreload.unref();

/**
 * True for families counted with a real tokenizer rather than a ratio.
 *
 * Two things follow from it: the count is exact and cacheable by text, and it
 * does not depend on the calibrated ratio — so calibration has nothing to
 * invalidate for these models.
 */
function isTokenizerBacked(family: ModelFamily): boolean {
  return family === "openai-o200k" || family === "openai-cl100k";
}

/** One model's learned token economics, persisted across runs. */
export interface CalibratedModel {
  /** The counter's per-model key: `"provider::modelId"`. */
  readonly model: string;
  /** Calibrated characters-per-token ratio. */
  readonly ratio: number;
  /** Tokens each request carries beyond the message list (tool schemas etc.). */
  readonly overhead: number;
}
/**
 * Infer tokenizer family from a model hint.
 *
 * Routing is based on provider id first, then model-id substrings. When the
 * hint is empty, returns "unknown" (uses default 4.0 ratio).
 */
export function inferFamily(hint: ModelHint): ModelFamily {
  const provider = hint.provider.toLowerCase();
  const id = hint.modelId.toLowerCase();

  if (
    provider === "openai" ||
    id.startsWith("gpt-") ||
    id.startsWith("o1") ||
    id.startsWith("o3")
  ) {
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
  if (provider === "gemini" || id.includes("gemini")) return "gemini";
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
    provider === "zhipuai" ||
    id.includes("kimi") ||
    id.includes("minimax") ||
    id.includes("glm")
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

/**
 * Family of a persisted model key (`"provider::modelId"`), used to decide
 * whether a rehydrated ratio is still meaningful for that model.
 */
function familyForModelKey(modelKey: string): ModelFamily {
  const separator = modelKey.indexOf("::");
  const provider = separator === -1 ? modelKey : modelKey.slice(0, separator);
  const modelId = separator === -1 ? "" : modelKey.slice(separator + 2);
  return inferFamily({ provider, modelId });
}
export class TokenCounter {
  /** Per-model calibrated chars-per-token. Updated via calibrate(). */
  private calibratedRatio = new Map<string, number>();

  /**
   * Per-model request overhead in tokens: everything the provider counts that is
   * not in our message list — tool schemas above all, plus system scaffolding.
   *
   * Measured rather than derived. `toolDefinitionChars` reports only the schemas,
   * while `promptTokens - estimatedMessageTokens` captures the whole gap, which is
   * what a future estimate needs to match the provider.
   */
  private overheadTokens = new Map<string, number>();

  /**
   * Memoized text cost per message, per model. Keyed by reference, so a
   * message that survives between calls is counted once.
   */
  private messageCache = new WeakMap<ChatMessage, number>();

  /**
   * Per-family cache of exact BPE counts.
   *
   * Re-tokenizing is the expensive path this exists to skip: resuming a
   * session parses every message fresh out of the log, and compaction
   * rebuilds history around a summary. Both then re-tokenize a
   * whole conversation that was already tokenized, and for OpenAI families
   * that is a real BPE pass rather than a division.
   *
   * Keyed on `text`, this stays correct without invalidation: the BPE branch
   * is a pure function of (text, family), and calibration only moves the ratio
   * used by the other branch. Keys are the caller's own strings, so nothing is
   * copied; `bpeCacheChars` bounds what the map keeps alive after the caller
   * lets go.
   */
  private bpeCaches = new Map<ModelFamily, Map<string, number>>();
  private bpeCacheChars = 0;

  /**
   * Count tokens in a string under the given model.
   *
   * Uses gpt-tokenizer for OpenAI families (exact). Falls back to the
   * calibrated or family-default chars-per-token ratio for other providers,
   * and temporarily for OpenAI families until the encoder preload lands.
   */
  countText(text: string, hint: ModelHint): number {
    if (text.length === 0) return 0;
    const family = inferFamily(hint);

    if (isTokenizerBacked(family)) {
      const cached = this.bpeCaches.get(family)?.get(text);
      if (cached !== undefined) return cached;
      const encoders = gptEncoders;
      if (encoders !== undefined) {
        try {
          const counted = family === "openai-o200k" ? encoders.o200k(text) : encoders.cl100k(text);
          this.rememberBpeCount(family, text, counted);
          return counted;
        } catch {
          // gpt-tokenizer can throw on malformed UTF-16 surrogate pairs. Fall
          // through to the ratio estimate rather than crashing the run — and do
          // not cache, so the failure is never mistaken for a count.
        }
      } else {
        // Backstop for a count that arrives before the deferred preload ran:
        // start loading now (this call still estimates), the next one is exact.
        void ensureGptEncoders();
      }
      // The encoders have not finished loading. Price the text the same way
      // every non-tokenizer family is priced; countMessageText keeps such
      // estimates out of the message cache so the next call is exact.
    }

    const ratio = this.ratioFor(hint, family);
    return Math.ceil(text.length / ratio);
  }

  /**
   * Store one BPE result, evicting oldest-first to stay inside the char budget.
   *
   * Text longer than the budget is counted and returned but never stored: one
   * such string would evict everything else to hold a single entry.
   */
  private rememberBpeCount(family: ModelFamily, text: string, counted: number): void {
    if (text.length > BPE_CACHE_MAX_CHARS) return;
    let cache = this.bpeCaches.get(family);
    if (!cache) {
      cache = new Map<string, number>();
      this.bpeCaches.set(family, cache);
    }
    cache.set(text, counted);
    this.bpeCacheChars += text.length;
    if (this.bpeCacheChars <= BPE_CACHE_MAX_CHARS) return;
    // Map iterates in insertion order, so this drops the least recently added.
    for (const [otherFamily, otherCache] of this.bpeCaches) {
      for (const [key] of otherCache) {
        otherCache.delete(key);
        this.bpeCacheChars -= key.length;
        if (this.bpeCacheChars <= BPE_CACHE_MAX_CHARS) return;
      }
      if (otherCache.size === 0) this.bpeCaches.delete(otherFamily);
    }
  }

  /**
   * Count tokens in a single ChatMessage (content + tool calls + overhead).
   * Memoized per (message reference, model).
   */
  countMessage(msg: ChatMessage, hint: ModelHint): number {
    // Attachments are priced as if sent, which is right for a message considered on its own.
    // `countMessages` overrides this for messages whose attachments have aged out of the
    // inline window — it is the only caller that knows a message's position.
    return this.countMessageText(msg, hint) + estimateAttachmentsTokens(msg.attachments);
  }

  /**
   * Text-only cost of a message: content, tool calls, and per-message overhead.
   *
   * Separate from attachment cost because the two have different lifetimes. Text is sent on
   * every turn for as long as the message survives; an attachment is sent only while it is
   * inside `ATTACHMENT_INLINE_TURN_WINDOW`. Memoization applies here, where the value is
   * genuinely a property of the message alone.
   */
  private countMessageText(msg: ChatMessage, hint: ModelHint): number {
    // An estimate made while the BPE encoders are still loading is not the
    // exact count, so it must not be cached — a cached estimate would pin the
    // message at a value the real tokenizer would not produce. Everything
    // else (ratio-backed families, and exact BPE counts) is safe to cache.
    const cacheable = !isTokenizerBacked(inferFamily(hint)) || gptEncoders !== undefined;
    const cached = cacheable ? this.messageCache.get(msg) : undefined;
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

    if (cacheable) this.messageCache.set(msg, tokens);
    return tokens;
  }

  /**
   * Sum tokens across a message list, pricing attachments the way the request will actually
   * send them.
   *
   * Attachments contribute no characters but thousands of real prompt tokens, so a list
   * containing them would otherwise be estimated as comfortably small while the request
   * overflows the window. Past the inline window an attachment costs only its text
   * description, matching what `toCoreMessages` emits.
   */
  countMessages(msgs: readonly ChatMessage[], hint: ModelHint): number {
    const inlineIndices = inlineAttachmentMessageIndices(msgs);
    let total = 0;
    for (let messageIndex = 0; messageIndex < msgs.length; messageIndex++) {
      const msg = msgs[messageIndex];
      if (msg === undefined) continue;
      total += this.countMessageText(msg, hint);

      const attachments = msg.attachments;
      if (attachments === undefined || attachments.length === 0) continue;

      if (inlineIndices.has(messageIndex)) {
        total += estimateAttachmentsTokens(attachments);
      } else {
        for (const attachment of attachments) {
          total += this.countText(describeAttachment(attachment), hint);
        }
      }
    }
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

    const modelKey = this.modelKey(hint);

    // Attribute only the message share of promptTokens to the ratio. Dividing by the
    // raw total (which includes tool schemas) depressed the ratio and silently
    // inflated every later estimate — compensation proportional to message size
    // rather than to the overhead actually being missed.
    const priorOverhead = this.overheadTokens.get(modelKey) ?? 0;
    const messageTokens = Math.max(1, authoritativePromptTokens - priorOverhead);

    const observedRatio = totalChars / messageTokens;
    const prior = this.calibratedRatio.get(modelKey);
    const smoothed =
      prior !== undefined
        ? (1 - CALIBRATION_SMOOTHING) * prior + CALIBRATION_SMOOTHING * observedRatio
        : observedRatio;
    const clamped = Math.max(RATIO_MIN, Math.min(RATIO_MAX, smoothed));

    this.calibratedRatio.set(modelKey, clamped);

    // Invalidate the per-message cache, but only for the models whose counts
    // actually moved. A tokenizer-backed family never consults the ratio, so
    // discarding its memo would re-tokenize the whole history on the next
    // estimate — every turn, since this runs after every response — to arrive
    // at the same numbers. WeakMap can't be filtered, so ratio-backed models
    // still discard the lot: hot messages are recomputed on next access, cold
    // ones (already trimmed away) are GC'd.
    if (!isTokenizerBacked(inferFamily(hint))) {
      this.messageCache = new WeakMap<ChatMessage, number>();
    }

    // Now that the ratio is fresh, whatever the provider counted beyond our
    // messages is the request overhead. Exact for tokenizer-backed families,
    // smoothed for the rest so a single odd report cannot swing the budget.
    const estimatedMessageTokens = this.countMessages(messagesAtCallTime, hint);
    const observedOverhead = Math.max(0, authoritativePromptTokens - estimatedMessageTokens);
    const priorOverheadValue = this.overheadTokens.get(modelKey);
    const smoothedOverhead =
      priorOverheadValue !== undefined
        ? (1 - CALIBRATION_SMOOTHING) * priorOverheadValue +
          CALIBRATION_SMOOTHING * observedOverhead
        : observedOverhead;
    this.overheadTokens.set(modelKey, Math.round(smoothedOverhead));
  }

  /**
   * Tokens each request carries beyond the message list — tool schemas and provider
   * scaffolding. Zero until the first authoritative usage report arrives.
   */
  overheadFor(hint: ModelHint): number {
    return this.overheadTokens.get(this.modelKey(hint)) ?? 0;
  }

  /**
   * The per-model values learned so far, for persisting across runs.
   *
   * Every model with a calibrated entry is included; an overhead of 0 means
   * no authoritative report has separated it from the messages yet.
   */
  calibratedSnapshot(): readonly CalibratedModel[] {
    const models: CalibratedModel[] = [];
    for (const [model, ratio] of this.calibratedRatio) {
      models.push({ model, ratio, overhead: this.overheadTokens.get(model) ?? 0 });
    }
    return models;
  }

  /**
   * Seed the counter with values learned by a previous run (see
   * {@link calibratedSnapshot}) so a resumed session starts calibrated instead
   * of at family defaults.
   *
   * Deliberately conservative: out-of-range or non-finite ratios are ignored
   * as corrupt rather than trusted, and ratios for models that now count with
   * an exact tokenizer are dropped (dead weight). Overhead is different — the
   * window budget consults it for every family, tokenizer-backed ones included
   * — so a sane overhead is restored even when its ratio is not.
   */
  hydrate(models: readonly CalibratedModel[]): void {
    for (const { model, ratio, overhead } of models) {
      if (Number.isFinite(overhead) && overhead > 0) {
        this.overheadTokens.set(model, Math.round(overhead));
      }
      if (!Number.isFinite(ratio) || ratio < RATIO_MIN || ratio > RATIO_MAX) continue;
      if (isTokenizerBacked(familyForModelKey(model))) continue;
      this.calibratedRatio.set(model, ratio);
    }
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
    this.overheadTokens.clear();
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
