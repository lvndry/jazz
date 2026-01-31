import type { Effect } from "effect";
import type { ProviderName } from "@/core/constants/models";
import type { LLMAuthenticationError } from "./errors";

/**
 * Model Information
 */
export interface ModelInfo {
  readonly id: string;
  readonly displayName?: string;
  readonly isReasoningModel?: boolean;
  readonly supportsTools: boolean;
  /** Context window size in tokens. If not specified, defaults to 128000. */
  readonly contextWindow?: number;
}

/**
 * LLM Provider
 * Represents a configured LLM provider with its capabilities
 */
export interface LLMProvider {
  readonly name: ProviderName;
  readonly supportedModels: ModelInfo[];
  readonly defaultModel: string;
  readonly authenticate: () => Effect.Effect<void, LLMAuthenticationError>;
}

/**
 * LLM Provider Listing
 * Used for presenting providers in CLI/UI.
 */
export interface LLMProviderListItem {
  readonly name: ProviderName;
  readonly displayName?: string;
  readonly configured: boolean;
}
