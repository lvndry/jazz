import type { Effect } from "effect";
import type { ProviderName } from "@/core/constants/models";
import type { LLMAuthenticationError } from "./errors";

/**
 * @fileoverview LLM provider and model types
 *
 * Defines service contracts and data structures for interacting with various LLM
 * providers (OpenAI, Anthropic, Google, etc.), including model capabilities,
 * authentication, and provider listings.
 */

/**
 * Information about an LLM model's capabilities and characteristics
 *
 * Contains metadata about a specific LLM model including its ID, display name,
 * multimodal capabilities, tool usage support, and context window size.
 *
 */
export interface ModelInfo {
  readonly id: string;
  readonly displayName?: string;
  readonly isReasoningModel?: boolean;
  readonly supportsTools: boolean;
  /** Whether the model accepts image input (vision/multimodal). */
  readonly ingestImage?: boolean;
  /** Whether the model accepts PDF input natively. */
  readonly ingestPdf?: boolean;
  /** Whether the model accepts audio input. */
  readonly ingestAudio?: boolean;
  /** Whether the model accepts video input. */
  readonly ingestVideo?: boolean;
  /**
   * Whether the model produces images, from models.dev `modalities.output`.
   * Distinct from `ingestImage` (what it accepts): this is what it makes.
   */
  readonly generatesImage?: boolean;
  readonly generatesAudio?: boolean;
  readonly generatesVideo?: boolean;
  /** Input price in USD per 1M tokens, from the catalog. Absent when unpriced. */
  readonly inputPricePerMillion?: number;
  /** Output price in USD per 1M tokens, from the catalog. Absent when unpriced. */
  readonly outputPricePerMillion?: number;
  /** Whether the model accepts a custom temperature. Defaults to true when unknown. */
  readonly supportsTemperature?: boolean;
  /** Context window size in tokens. If not specified, defaults to 128000. */
  readonly contextWindow?: number;
  /** Raw chat template string (Jinja for llama.cpp, Go-template for ollama). Used for reasoning-parser selection. */
  readonly chatTemplate?: string;
  /** Provider-reported capability tags (e.g. ["completion", "tools", "thinking"] from ollama). */
  readonly capabilities?: readonly string[];
}

/**
 * A modality an agent can delegate to a capable model companion (`analyze_media`).
 *
 * Mirrors the attachment kinds such delegation can carry, minus `pdf`: every text
 * agent reads PDFs through `read_pdf`, so there is nothing to delegate.
 */
export type PerceptionCapability = "vision" | "audio" | "video";

export const PERCEPTION_CAPABILITIES: readonly PerceptionCapability[] = [
  "vision",
  "audio",
  "video",
];

export function isPerceptionCapability(value: string): value is PerceptionCapability {
  return (PERCEPTION_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Service contract for an LLM provider
 *
 * An LLM provider represents a configured connection to an LLM service (OpenAI,
 * Anthropic, Google, etc.) with capabilities and authentication logic. Providers
 * are implemented in the services layer and satisfy Core layer contracts.
 */
export interface LLMProvider {
  readonly name: ProviderName;
  readonly supportedModels: ModelInfo[];
  readonly defaultModel: string;
  readonly authenticate: () => Effect.Effect<void, LLMAuthenticationError>;
}

/**
 * Listed item representing an LLM provider in CLI/UI
 *
 * Used when displaying available providers to users, includes configuration
 * status to show which providers are ready to use.
 *
 */
export interface LLMProviderListItem {
  readonly name: ProviderName;
  readonly displayName?: string;
  readonly configured: boolean;
}
