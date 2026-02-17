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
 * An Agent in Jazz is a configured entity with a specific model provider, persona,
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
 * and model to use, the persona for behavioral specialization, available tools, and
 * reasoning effort level for supported models.
 *
 * @see {@link ProviderName} for available LLM providers
 */
export interface AgentConfig {
  /**
   * The persona applied to this agent. Determines the agent's communication style,
   * tone, and behavioral rules via a system prompt.
   *
   * Built-in personas: "default", "coder", "researcher"
   * Custom personas: stored in .jazz/personas/ and referenced by name or ID.
   *
   * Defaults to "default" when not specified.
   */
  readonly persona: string;
  readonly llmProvider: ProviderName;
  readonly llmModel: string;
  readonly reasoningEffort?: "disable" | "low" | "medium" | "high";
  readonly tools?: readonly string[];
}
