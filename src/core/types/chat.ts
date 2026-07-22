import type { ProviderName } from "@/core/constants/models";
import type { ChatMessage, StoredReasoningPart } from "./message";
import type { ToolCall, ToolDefinition } from "./tools";

export interface ChatCompletionResponse {
  id: string;
  model: string;
  content: string;
  /**
   * Reasoning / chain-of-thought text emitted by the model, when the provider
   * exposes it as a separate channel (e.g. OpenAI-compatible servers returning
   * `reasoning_content`). Surfaced so callers can detect reasoning-only
   * responses where `content` would otherwise look empty.
   */
  reasoning?: string;
  /** Structured reasoning blocks with provider payloads, for replay in conversation history. */
  reasoningParts?: ReadonlyArray<StoredReasoningPart>;
  toolCalls?: ToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  toolsDisabled?: boolean;
  /** Estimated character count of tool definitions sent in this request (for telemetry). */
  toolDefinitionChars?: number;
  /** Number of tool definitions sent in this request (for telemetry). */
  toolDefinitionCount?: number;
}

export interface ChatCompletionOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none" | { type: "function"; function: { name: string } };
  stream?: boolean;
  reasoning_effort?: "disable" | "low" | "medium" | "high";
  /** Ollama runtime context window, sent as `num_ctx`. Ignored by other providers. */
  num_ctx?: number;
  /** Optional per-request API key overrides by provider (typically from agent config). */
  providerApiKeys?: Partial<Record<ProviderName, string>>;
}
