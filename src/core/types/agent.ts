/**
 * @fileoverview Agent domain model types
 *
 * Defines the core data structures for AI agents in Jazz, including agent configuration
 * and metadata. These types are framework-agnostic and contain only pure data structures
 * with no external dependencies.
 */

/**
 * Agent types
 */

import type { ProviderName } from "@/core/constants/models";

/**
 * Core Agent entity representing an AI agent configuration
 *
 * An Agent in Jazz is a configured entity with a specific model provider, agent type,
 * and optional toolset. Agents are immutable after creation and stored in the storage layer.
 *
 */
export interface Agent {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly model: `${string}/${string}`;
  readonly config: AgentConfig;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Agent configuration specifying LLM provider, model, and runtime behavior
 *
 * The agent configuration defines how an agent operates, including which LLM provider
 * and model to use, the agent's type for specialized behavior, available tools, and
 * reasoning effort level for supported models (OpenAI o1 series).
 *
 * @see {@link ProviderName} for available LLM providers
 */
export interface AgentConfig {
  readonly agentType: string;
  readonly llmProvider: ProviderName;
  readonly llmModel: string;
  readonly reasoningEffort?: "disable" | "low" | "medium" | "high";
  readonly tools?: readonly string[];
  /**
   * Optional persona ID or name to apply to this agent.
   * When set, the persona's system prompt is injected into the agent's conversation,
   * shaping its tone, style, and behavior independently of the agent type.
   */
  readonly persona?: string;
}
