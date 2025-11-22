import { Context, Effect, Layer } from "effect";
import shortuuid from "short-uuid";
import type { StorageService } from "../../services/storage/service";
import { StorageServiceTag } from "../../services/storage/service";
import {
  AgentAlreadyExistsError,
  AgentConfigurationError,
  StorageError,
  StorageNotFoundError,
  ValidationError,
} from "../types/errors";
import { type Agent, type AgentConfig } from "../types/index";
import { CommonSuggestions } from "../utils/error-handler";
import { normalizeToolConfig } from "./utils/tool-config";

/**
 * Agent service for managing agent lifecycle and operations
 */

export interface AgentService {
  readonly createAgent: (
    name: string,
    description: string | undefined,
    config?: Partial<AgentConfig>,
  ) => Effect.Effect<
    Agent,
    StorageError | AgentAlreadyExistsError | AgentConfigurationError | ValidationError
  >;
  readonly getAgent: (id: string) => Effect.Effect<Agent, StorageError | StorageNotFoundError>;
  readonly listAgents: () => Effect.Effect<readonly Agent[], StorageError>;
  readonly updateAgent: (
    id: string,
    updates: Partial<Agent>,
  ) => Effect.Effect<
    Agent,
    | StorageError
    | StorageNotFoundError
    | AgentConfigurationError
    | AgentAlreadyExistsError
    | ValidationError
  >;
  readonly deleteAgent: (id: string) => Effect.Effect<void, StorageError | StorageNotFoundError>;
  readonly validateAgentConfig: (
    config: AgentConfig,
  ) => Effect.Effect<void, AgentConfigurationError>;
}

export class DefaultAgentService implements AgentService {
  constructor(private readonly storage: StorageService) {}

  /**
   * Create a new agent with the specified configuration
   *
   * Validates the agent name and description, checks for duplicates, and creates
   * a new agent with the provided configuration. The agent will be assigned a
   * unique ID and timestamps for creation and updates.
   *
   * @param name - The unique name for the agent (must be alphanumeric with underscores/hyphens)
   * @param description - A description of what the agent does (1-500 characters)
   * @returns An Effect that resolves to the created Agent or fails with validation/configuration errors
   *
   * @throws {ValidationError} When name or description validation fails
   * @throws {AgentAlreadyExistsError} When an agent with the same name already exists
   * @throws {AgentConfigurationError} When the configuration is invalid
   * @throws {StorageError} When the agent cannot be saved to storage
   *
   * @example
   * ```typescript
   * const agent = yield* agentService.createAgent(
   *   "email-processor",
   *   "Processes incoming emails and categorizes them",
   * );
   * ```
   */
  createAgent(
    name: string,
    description: string | undefined,
    config: Partial<AgentConfig> = {},
  ): Effect.Effect<
    Agent,
    StorageError | AgentAlreadyExistsError | AgentConfigurationError | ValidationError
  > {
    return Effect.gen(
      function* (this: DefaultAgentService) {
        // Validate input parameters
        yield* validateAgentName(name);
        if (description !== undefined) {
          yield* validateAgentDescription(description);
        }

        const id = shortuuid.generate();

        // Create default agent configuration
        const defaultConfig: AgentConfig = {
          environment: {},
          agentType: "default",
          llmProvider: "openai",
          llmModel: "gpt-4o",
        };

        const normalizedTools = normalizeToolConfig(config.tools, { agentId: id });

        const baseConfig: AgentConfig = {
          ...defaultConfig,
          ...config,
          environment: { ...defaultConfig.environment, ...(config.environment ?? {}) },
        };

        const agentConfig: AgentConfig =
          normalizedTools.length > 0 ? { ...baseConfig, tools: normalizedTools } : baseConfig;

        // Validate the complete agent configuration
        yield* this.validateAgentConfig(agentConfig);

        // Check if agent with same name already exists
        const existingAgents = yield* this.storage.listAgents();
        const nameExists = existingAgents.some((agent: Agent) => agent.name === name);

        if (nameExists) {
          return yield* Effect.fail(
            new AgentAlreadyExistsError({
              agentId: name,
              suggestion: CommonSuggestions.checkAgentExists(name),
            }),
          );
        }

        // Create the agent
        const now = new Date();
        const agent: Agent = {
          id,
          name,
          ...(description !== undefined && { description }),
          model: `${agentConfig.llmProvider}/${agentConfig.llmModel}`,
          config: agentConfig,
          createdAt: now,
          updatedAt: now,
        };

        // Save the agent
        yield* this.storage.saveAgent(agent);

        return agent;
      }.bind(this),
    );
  }

  /**
   * Retrieve an agent by its unique identifier
   *
   * @param id - The unique identifier of the agent to retrieve
   * @returns An Effect that resolves to the Agent or fails if not found
   *
   * @throws {StorageError} When there's an error accessing storage
   * @throws {StorageNotFoundError} When the agent with the given ID doesn't exist
   *
   * @example
   * ```typescript
   * const agent = yield* agentService.getAgent("agent-123");
   * console.log(`Found agent: ${agent.name}`);
   * ```
   */
  getAgent(id: string): Effect.Effect<Agent, StorageError | StorageNotFoundError> {
    return this.storage.getAgent(id);
  }

  /**
   * List all available agents
   *
   * @returns An Effect that resolves to an array of all agents in storage
   *
   * @throws {StorageError} When there's an error accessing storage
   *
   * @example
   * ```typescript
   * const agents = yield* agentService.listAgents();
   * console.log(`Found ${agents.length} agents`);
   * agents.forEach(agent => console.log(`- ${agent.name}: ${agent.description}`));
   * ```
   */
  listAgents(): Effect.Effect<readonly Agent[], StorageError> {
    return this.storage.listAgents();
  }

  /**
   * Update an existing agent with new data
   *
   * Updates the specified agent with the provided changes. The agent's ID and
   * creation timestamp cannot be changed. The updatedAt timestamp will be
   * automatically set to the current time.
   *
   * @param id - The unique identifier of the agent to update
   * @param updates - Partial agent data containing the fields to update
   * @returns An Effect that resolves to the updated Agent or fails if not found
   *
   * @throws {StorageError} When there's an error accessing storage
   * @throws {StorageNotFoundError} When the agent with the given ID doesn't exist
   *
   * @example
   * ```typescript
   * const updatedAgent = yield* agentService.updateAgent("agent-123", {
   *   description: "Updated description",
   * });
   * ```
   */
  updateAgent(
    id: string,
    updates: Partial<Agent>,
  ): Effect.Effect<
    Agent,
    | StorageError
    | StorageNotFoundError
    | AgentConfigurationError
    | AgentAlreadyExistsError
    | ValidationError
  > {
    return Effect.gen(
      function* (this: DefaultAgentService) {
        const existingAgent = yield* this.storage.getAgent(id);

        if (updates.name && updates.name !== existingAgent.name) {
          yield* validateAgentName(updates.name);

          const agents = yield* this.storage.listAgents();
          const duplicateExists = agents.some(
            (agent) => agent.name === updates.name && agent.id !== existingAgent.id,
          );

          if (duplicateExists) {
            return yield* Effect.fail(
              new AgentAlreadyExistsError({
                agentId: updates.name,
                suggestion: CommonSuggestions.checkAgentExists(updates.name),
              }),
            );
          }
        }

        const mergedConfig: AgentConfig = {
          ...existingAgent.config,
          ...updates.config,
        };

        const normalizedTools = normalizeToolConfig(mergedConfig.tools, {
          agentId: existingAgent.id,
        });

        const { tools: _existingTools, ...configWithoutTools } = mergedConfig;
        void _existingTools;

        const baseConfig: AgentConfig = configWithoutTools as AgentConfig;
        const updatedConfig: AgentConfig =
          normalizedTools.length > 0 ? { ...baseConfig, tools: normalizedTools } : baseConfig;

        const updatedAgent: Agent = {
          ...existingAgent,
          ...updates,
          id: existingAgent.id, // Ensure ID cannot be changed
          createdAt: existingAgent.createdAt, // Ensure createdAt cannot be changed
          updatedAt: new Date(),
          model: `${updatedConfig.llmProvider}/${updatedConfig.llmModel}`,
          config: updatedConfig,
        };

        yield* this.validateAgentConfig(updatedAgent.config);

        yield* this.storage.saveAgent(updatedAgent);
        return updatedAgent;
      }.bind(this),
    );
  }

  /**
   * Delete an agent by its unique identifier
   *
   * @param id - The unique identifier of the agent to delete
   * @returns An Effect that resolves when the agent is successfully deleted
   *
   * @throws {StorageError} When there's an error accessing storage
   * @throws {StorageNotFoundError} When the agent with the given ID doesn't exist
   *
   * @example
   * ```typescript
   * yield* agentService.deleteAgent("agent-123");
   * console.log("Agent deleted successfully");
   * ```
   */
  deleteAgent(id: string): Effect.Effect<void, StorageError | StorageNotFoundError> {
    return this.storage.deleteAgent(id);
  }

  /**
   * Validate an agent configuration for correctness
   *
   * Performs comprehensive validation of the agent configuration including:
   * - Tool validation
   *
   * @param config - The agent configuration to validate
   * @returns An Effect that resolves if validation passes or fails with configuration errors
   *
   * @throws {AgentConfigurationError} When any part of the configuration is invalid
   *
   * @example
   * ```typescript
   * const config: AgentConfig = {
   *   agentType: "default",
   *   llmProvider: "openai",
   *   llmModel: "gpt-4o",
   *   environment: {}
   * };
   *
   * yield* agentService.validateAgentConfig(config);
   * ```
   */
  validateAgentConfig(config: AgentConfig): Effect.Effect<void, AgentConfigurationError> {
    return Effect.gen(function* (this: DefaultAgentService) {
      // Validate tools
      if (config.tools) {
        if (!Array.isArray(config.tools)) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: "config.tools",
              message: "Tools must be provided as an array of tool names",
              suggestion: "Select tools using the CLI or supply an array of tool identifiers.",
            }),
          );
        }

        for (const tool of config.tools) {
          if (typeof tool !== "string" || tool.trim().length === 0) {
            return yield* Effect.fail(
              new AgentConfigurationError({
                agentId: "unknown",
                field: "config.tools",
                message: "Each tool entry must be a non-empty string",
              }),
            );
          }
        }
      }
    });
  }
}

/**
 * Validation helper functions for agent data
 */

/**
 * Validate an agent name for correctness
 *
 * Ensures the agent name meets the following criteria:
 * - Not empty or whitespace-only
 * - Maximum 100 characters
 * - Only contains letters, numbers, underscores, and hyphens
 *
 * @param name - The agent name to validate
 * @returns An Effect that resolves if validation passes or fails with validation errors
 *
 * @throws {ValidationError} When the name doesn't meet the requirements
 *
 * @example
 *
 * yield validateAgentName("my-agent-1"); // ✅ Valid
 * yield validateAgentName("invalid@name"); // ❌ Throws ValidationError
 * ```
 */
function validateAgentName(name: string): Effect.Effect<void, ValidationError> {
  if (!name || name.trim().length === 0) {
    return Effect.fail(
      new ValidationError({
        field: "name",
        message: "Agent name cannot be empty",
        value: name,
        suggestion:
          "Provide a descriptive name for your agent, e.g., 'email-processor' or 'data-backup'",
      }),
    );
  }

  if (name.length > 100) {
    return Effect.fail(
      new ValidationError({
        field: "name",
        message: "Agent name cannot exceed 100 characters",
        value: name,
        suggestion: `Use a shorter name (${name.length}/100 characters). Consider using abbreviations or removing unnecessary words`,
      }),
    );
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return Effect.fail(
      new ValidationError({
        field: "name",
        message: "Agent name can only contain letters, numbers, underscores, and hyphens",
        value: name,
        suggestion:
          "Use only letters (a-z, A-Z), numbers (0-9), underscores (_), and hyphens (-). Example: 'my-agent-1'",
      }),
    );
  }

  return Effect.void;
}

/**
 * Validate an agent description for correctness
 *
 * Ensures the agent description meets the following criteria:
 * - Not empty or whitespace-only (if provided)
 * - Maximum 500 characters (if provided)
 *
 * @param description - The agent description to validate (optional)
 * @returns An Effect that resolves if validation passes or fails with validation errors
 *
 * @throws {ValidationError} When the description doesn't meet the requirements
 *
 * @example
 * ```typescript
 * yield* validateAgentDescription("Processes emails and categorizes them"); // ✅ Valid
 * yield* validateAgentDescription(""); // ❌ Throws ValidationError
 * yield* validateAgentDescription(undefined); // ✅ Valid (optional)
 * ```
 */
function validateAgentDescription(description: string): Effect.Effect<void, ValidationError> {
  if (!description || description.trim().length === 0) {
    return Effect.fail(
      new ValidationError({
        field: "description",
        message: "Agent description cannot be empty",
        value: description,
        suggestion:
          "Provide a clear description of what this agent does, e.g., 'Processes incoming emails and categorizes them'",
      }),
    );
  }

  if (description.length > 500) {
    return Effect.fail(
      new ValidationError({
        field: "description",
        message: "Agent description cannot exceed 500 characters",
        value: description,
        suggestion: `Use a shorter description (${description.length}/500 characters). Focus on the main purpose and key functionality`,
      }),
    );
  }

  return Effect.void;
}

export const AgentServiceTag = Context.GenericTag<AgentService>("AgentService");

export function createAgentServiceLayer(): Layer.Layer<AgentService, never, StorageService> {
  return Layer.effect(
    AgentServiceTag,
    Effect.map(StorageServiceTag, (storage) => new DefaultAgentService(storage)),
  );
}

// Helper functions for common agent operations
export function createAgent(
  name: string,
  description: string | undefined,
  config?: Partial<AgentConfig>,
): Effect.Effect<
  Agent,
  StorageError | AgentAlreadyExistsError | AgentConfigurationError | ValidationError,
  AgentService
> {
  return Effect.gen(function* () {
    const agentService = yield* AgentServiceTag;
    return yield* agentService.createAgent(name, description, config);
  });
}

export function getAgentById(
  id: string,
): Effect.Effect<Agent, StorageError | StorageNotFoundError, AgentService> {
  return Effect.gen(function* () {
    const agentService = yield* AgentServiceTag;
    return yield* agentService.getAgent(id);
  });
}

/**
 * Retrieve an agent by identifier, matching ID first then falling back to name
 *
 * This helper improves CLI ergonomics by allowing users to reference agents
 * using either their unique ID or their human-friendly name. The lookup order
 * prioritizes IDs so that explicit references always take precedence, even if
 * someone gives an agent a name that resembles an ID.
 *
 * @param identifier - The agent ID or name provided by the user
 * @returns An Effect that resolves to the matching Agent
 *
 * @throws {StorageError} When there's an error accessing storage
 * @throws {StorageNotFoundError} When no agent matches the provided identifier
 */
export function getAgentByIdentifier(
  identifier: string,
): Effect.Effect<Agent, StorageError | StorageNotFoundError, AgentService> {
  return Effect.gen(function* () {
    const agentService = yield* AgentServiceTag;

    const agent = yield* agentService.getAgent(identifier).pipe(
      Effect.catchAll((error) => {
        if (error instanceof StorageNotFoundError) {
          return Effect.gen(function* () {
            const agents = yield* agentService.listAgents();
            const match = agents.find((candidate) => candidate.name === identifier);

            if (match) {
              return match;
            }

            return yield* Effect.fail(error);
          });
        }

        return Effect.fail(error);
      }),
    );

    return agent;
  });
}

/**
 * List all available agents using the AgentService
 *
 * This is a convenience function that uses the AgentService from the Effect context
 * to retrieve all agents.
 *
 * @returns An Effect that resolves to an array of all agents
 *
 * @throws {StorageError} When there's an error accessing storage
 *
 * @example
 * ```typescript
 * const agents = yield* listAllAgents();
 * console.log(`Found ${agents.length} agents`);
 * agents.forEach(agent => console.log(`- ${agent.name}`));
 * ```
 */
export function listAllAgents(): Effect.Effect<readonly Agent[], StorageError, AgentService> {
  return Effect.gen(function* () {
    const agentService = yield* AgentServiceTag;
    return yield* agentService.listAgents();
  });
}
