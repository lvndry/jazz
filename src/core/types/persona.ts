/**
 * @fileoverview Persona domain model types
 *
 * Defines the core data structures for custom personas in Jazz.
 * A Persona is a reusable character/identity that can be applied to any agent,
 * controlling how the agent communicates (tone, style, vocabulary, behavior).
 * Personas are model-agnostic and stored as persona.md files in ~/.jazz/personas/<name>/.
 */

/**
 * Core Persona entity representing a reusable agent identity
 *
 * A Persona defines the behavioral and communication style for an agent.
 * It includes a system prompt that shapes how the agent responds, along with
 * optional tone, style, and behavioral constraints.
 *
 * Personas are decoupled from agents and models -- the same persona can be
 * used with any agent running on any LLM provider/model.
 */
export interface Persona {
  /** Unique identifier (short UUID) */
  readonly id: string;
  /** User-chosen name (alphanumeric, _, -). Used for CLI references. */
  readonly name: string;
  /** Brief human-readable description of what this persona does */
  readonly description: string;
  /**
   * System prompt injected into the agent's conversation.
   * This is the core of the persona -- it defines the character, tone,
   * vocabulary, and behavioral rules the agent should follow.
   */
  readonly systemPrompt: string;
  /**
   * Optional tone descriptor (e.g., "sarcastic", "formal", "friendly", "academic")
   * Used for display/filtering purposes.
   */
  readonly tone?: string;
  /**
   * Optional style descriptor (e.g., "concise", "verbose", "technical", "casual")
   * Used for display/filtering purposes.
   */
  readonly style?: string;
  /** Creation timestamp */
  readonly createdAt: Date;
  /** Last update timestamp */
  readonly updatedAt: Date;
}

/**
 * Configuration for creating a new persona
 */
export interface CreatePersonaInput {
  readonly name: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly tone?: string;
  readonly style?: string;
}
