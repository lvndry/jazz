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
import type { WebSearchProviderName } from "@/core/types/config";

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
   * Custom personas: stored in ~/.jazz/personas/ and referenced by name or ID.
   *
   * Defaults to "default" when not specified.
   */
  readonly persona: string;
  readonly llmProvider: ProviderName;
  readonly llmModel: string;
  /** Optional per-agent API key overrides by provider. Falls back to global config, then env vars. */
  readonly llmApiKeys?: Partial<Record<ProviderName, string>>;
  readonly reasoningEffort?: "disable" | "low" | "medium" | "high";
  readonly temperature?: number;
  readonly tools?: readonly string[];
  readonly webSearchProvider?: WebSearchProviderName;
  /**
   * Env var names exempted from the `execute_command` shell env scrub, even
   * when they match the sensitive-name regex (API|KEY|SECRET|TOKEN|PASSWORD|
   * CREDENTIAL|AUTH). Each name must match `^[A-Z][A-Z0-9_]{0,63}$`; at most
   * 32 names. Does not affect `grep`/`find`/`git` tool spawns.
   */
  readonly envAllowlist?: readonly string[];
  /**
   * User-declared tools this agent can call, in addition to built-in tools.
   * At most 16 entries; names must be unique within the array and must not
   * start with `mcp_` (reserved for MCP-sourced tools). Collisions with
   * registered builtin tool names are rejected at registration time, not here.
   */
  readonly customTools?: readonly CustomToolDefinition[];
}

/**
 * A custom tool handler that always returns a fixed response without
 * executing anything, useful for stubbing or documentation-style tools.
 */
export interface CustomToolRecordHandler {
  readonly type: "record";
  /** Fixed response returned when the tool is invoked. Defaults to an empty response when omitted. */
  readonly response?: string;
}

/**
 * A custom tool handler that shells out to an external command when invoked.
 */
export interface CustomToolCommandHandler {
  readonly type: "command";
  /** Command and arguments to execute, e.g. `["echo", "hello"]`. Must be non-empty. */
  readonly command: readonly string[];
  /** Maximum execution time in milliseconds before the command is killed. Must be a positive integer, at most 300_000 (5 minutes). */
  readonly timeoutMs?: number;
}

/**
 * User-declared custom tool exposed to an agent's LLM in addition to built-in tools.
 *
 * The `parameters` field is a JSON Schema object describing the tool's input,
 * following the same shape LLM providers expect for function/tool calling.
 */
export interface CustomToolDefinition {
  /** Unique tool name. Must match `^[a-z][a-z0-9_]{1,63}$` and must not start with `mcp_`. */
  readonly name: string;
  /** Human-readable description of what the tool does, shown to the LLM. 1-1024 characters. */
  readonly description: string;
  /** JSON Schema object describing the tool's parameters. Must have `type: "object"`. */
  readonly parameters: Record<string, unknown>;
  /** How the tool behaves when invoked: return a fixed response, or run a command. */
  readonly handler: CustomToolRecordHandler | CustomToolCommandHandler;
}
