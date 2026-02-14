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
  readonly supportsVision?: boolean;
  /** Whether the model accepts PDF input natively. */
  readonly supportsPdf?: boolean;
  /** Context window size in tokens. If not specified, defaults to 128000. */
  readonly contextWindow?: number;
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
