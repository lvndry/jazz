import { Context, Effect, Layer, Schema } from "effect";
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
import { type Agent, type AgentConfig, type Task, TaskSchema } from "../types/index";
import { CommonSuggestions } from "../utils/error-handler";
import { normalizeToolConfig } from "./utils/tool-config";

/**
 * Agent service for managing agent lifecycle and operations
 */

export interface AgentService {
  readonly createAgent: (
    name: string,
    description: string,
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
  ) => Effect.Effect<Agent, StorageError | StorageNotFoundError | AgentConfigurationError>;
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
   * @param config - Optional configuration including timeout, retry policy, and tasks
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
   *   { timeout: 30000, retryPolicy: { maxRetries: 3, delay: 1000, backoff: "exponential" } }
   * );
   * ```
   */
  createAgent(
    name: string,
    description: string,
    config: Partial<AgentConfig> = {},
  ): Effect.Effect<
    Agent,
    StorageError | AgentAlreadyExistsError | AgentConfigurationError | ValidationError
  > {
    return Effect.gen(
      function* (this: DefaultAgentService) {
        // Validate input parameters
        yield* validateAgentName(name);
        yield* validateAgentDescription(description);

        const id = shortuuid.generate();

        // Create default agent configuration
        const defaultConfig: AgentConfig = {
          tasks: [],
          timeout: 30000,
          environment: {},
          agentType: "default",
          llmProvider: "openai",
          llmModel: "gpt-4o",
        };

        const normalizedTools = normalizeToolConfig(config.tools, { agentId: id });

        const baseConfig: AgentConfig = {
          ...defaultConfig,
          ...config,
          tasks: config.tasks ?? [],
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
          description,
          config: agentConfig,
          status: "idle",
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
   *   config: { timeout: 60000 }
   * });
   * ```
   */
  updateAgent(
    id: string,
    updates: Partial<Agent>,
  ): Effect.Effect<Agent, StorageError | StorageNotFoundError | AgentConfigurationError> {
    return Effect.gen(
      function* (this: DefaultAgentService) {
        const existingAgent = yield* this.storage.getAgent(id);

        const mergedConfig: AgentConfig = {
          ...existingAgent.config,
          ...updates.config,
          tasks: updates.config?.tasks ?? existingAgent.config.tasks,
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
   * - Task validation using schemas
   * - Timeout range validation (1000ms - 3600000ms)
   * - Retry policy validation (max retries 0-10, delay 100ms-60000ms)
   *
   * @param config - The agent configuration to validate
   * @returns An Effect that resolves if validation passes or fails with configuration errors
   *
   * @throws {AgentConfigurationError} When any part of the configuration is invalid
   *
   * @example
   * ```typescript
   * const config: AgentConfig = {
   *   tasks: [],
   *   timeout: 30000,
   *   retryPolicy: { maxRetries: 3, delay: 1000, backoff: "exponential" }
   * };
   *
   * yield* agentService.validateAgentConfig(config);
   * ```
   */
  validateAgentConfig(config: AgentConfig): Effect.Effect<void, AgentConfigurationError> {
    return Effect.gen(function* (this: DefaultAgentService) {
      // Validate tasks
      for (const task of config.tasks) {
        yield* validateTask(task);
      }

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

      // Validate timeout
      if (config.timeout && (config.timeout < 1000 || config.timeout > 3600000)) {
        return yield* Effect.fail(
          new AgentConfigurationError({
            agentId: "unknown",
            field: "timeout",
            message: "Timeout must be between 1000ms and 3600000ms (1 hour)",
            suggestion: `Use a timeout between 1000ms and 3600000ms. Current value: ${config.timeout}ms`,
          }),
        );
      }

      // Validate retry policy if provided
      if (config.retryPolicy) {
        if (config.retryPolicy.maxRetries < 0 || config.retryPolicy.maxRetries > 10) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: "retryPolicy.maxRetries",
              message: "Max retries must be between 0 and 10",
              suggestion: `Use a value between 0 and 10. Current value: ${config.retryPolicy.maxRetries}`,
            }),
          );
        }

        if (config.retryPolicy.delay < 100 || config.retryPolicy.delay > 60000) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: "retryPolicy.delay",
              message: "Retry delay must be between 100ms and 60000ms",
              suggestion: `Use a delay between 100ms and 60000ms. Current value: ${config.retryPolicy.delay}ms`,
            }),
          );
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
 * - Not empty or whitespace-only
 * - Maximum 500 characters
 *
 * @param description - The agent description to validate
 * @returns An Effect that resolves if validation passes or fails with validation errors
 *
 * @throws {ValidationError} When the description doesn't meet the requirements
 *
 * @example
 * ```typescript
 * yield* validateAgentDescription("Processes emails and categorizes them"); // ✅ Valid
 * yield* validateAgentDescription(""); // ❌ Throws ValidationError
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

/**
 * Validate a task configuration using its schema
 *
 * Uses the TaskSchema to validate the task structure and properties.
 * This ensures the task meets all required fields and type constraints.
 *
 * @param task - The task to validate
 * @returns An Effect that resolves if validation passes or fails with configuration errors
 *
 * @throws {AgentConfigurationError} When the task configuration is invalid
 *
 * @example
 * ```typescript
 * const task: Task = {
 *   id: "task-1",
 *   name: "Process Email",
 *   type: "gmail",
 *   config: { gmailOperation: "list_emails" }
 * };
 * yield* validateTask(task);
 * ```
 */
function validateTask(task: Task): Effect.Effect<void, AgentConfigurationError> {
  return Effect.gen(function* () {
    // Validate task using schema
    yield* Effect.try({
      try: () => Schema.decodeUnknownSync(TaskSchema)(task),
      catch: (error) =>
        new AgentConfigurationError({
          agentId: "unknown",
          field: `task.${task.id}`,
          message: `Invalid task structure: ${String(error)}`,
        }),
    });

    // Additional business logic validation
    if (!task.name || task.name.trim().length === 0) {
      return yield* Effect.fail(
        new AgentConfigurationError({
          agentId: "unknown",
          field: `task.${task.id}.name`,
          message: "Task name cannot be empty",
        }),
      );
    }

    // Validate task type specific requirements
    switch (task.type) {
      case "command":
        if (!task.config.command || task.config.command.trim().length === 0) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: `task.${task.id}.config.command`,
              message: "Command tasks must have a command specified",
            }),
          );
        }
        break;
      case "script":
        if (!task.config.script || task.config.script.trim().length === 0) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: `task.${task.id}.config.script`,
              message: "Script tasks must have a script specified",
            }),
          );
        }
        break;
      case "api":
        if (!task.config.url || task.config.url.trim().length === 0) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: `task.${task.id}.config.url`,
              message: "API tasks must have a URL specified",
            }),
          );
        }
        break;
      case "file":
        if (!task.config.filePath || task.config.filePath.trim().length === 0) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: `task.${task.id}.config.filePath`,
              message: "File tasks must have a file path specified",
            }),
          );
        }
        break;
      case "gmail":
        if (!task.config.gmailOperation) {
          return yield* Effect.fail(
            new AgentConfigurationError({
              agentId: "unknown",
              field: `task.${task.id}.config.gmailOperation`,
              message: "Gmail tasks must have an operation specified",
            }),
          );
        }
        break;
    }
  });
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
  description: string,
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
