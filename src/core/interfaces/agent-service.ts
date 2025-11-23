import { Context, Effect } from "effect";
import type {
  AgentAlreadyExistsError,
  AgentConfigurationError,
  StorageError,
  StorageNotFoundError,
  ValidationError,
} from "../types/errors";
import type { Agent, AgentConfig } from "../types/index";

/**
 * Agent service interface for managing agent lifecycle and operations
 *
 * Provides methods for creating, retrieving, updating, deleting, and validating agents.
 * All operations are wrapped in Effect for proper error handling and dependency injection.
 */
export interface AgentService {
  /**
   * Create a new agent with the specified configuration
   *
   * Validates the agent name and description, checks for duplicates, and creates
   * a new agent with the provided configuration. The agent will be assigned a
   * unique ID and timestamps for creation and updates.
   *
   * @param name - The unique name for the agent (must be alphanumeric with underscores/hyphens)
   * @param description - A description of what the agent does (1-500 characters)
   * @param config - Optional partial agent configuration
   * @returns An Effect that resolves to the created Agent or fails with validation/configuration errors
   *
   * @throws {ValidationError} When name or description validation fails
   * @throws {AgentAlreadyExistsError} When an agent with the same name already exists
   * @throws {AgentConfigurationError} When the configuration is invalid
   * @throws {StorageError} When the agent cannot be saved to storage
   */
  readonly createAgent: (
    name: string,
    description: string | undefined,
    config?: Partial<AgentConfig>,
  ) => Effect.Effect<
    Agent,
    StorageError | AgentAlreadyExistsError | AgentConfigurationError | ValidationError
  >;

  /**
   * Retrieve an agent by its unique identifier
   *
   * @param id - The unique identifier of the agent to retrieve
   * @returns An Effect that resolves to the Agent or fails if not found
   *
   * @throws {StorageError} When there's an error accessing storage
   * @throws {StorageNotFoundError} When the agent with the given ID doesn't exist
   */
  readonly getAgent: (id: string) => Effect.Effect<Agent, StorageError | StorageNotFoundError>;

  /**
   * List all available agents
   *
   * @returns An Effect that resolves to an array of all agents in storage
   *
   * @throws {StorageError} When there's an error accessing storage
   */
  readonly listAgents: () => Effect.Effect<readonly Agent[], StorageError>;

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
   * @throws {AgentConfigurationError} When the updated configuration is invalid
   * @throws {AgentAlreadyExistsError} When updating the name to one that already exists
   * @throws {ValidationError} When name validation fails
   */
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

  /**
   * Delete an agent by its unique identifier
   *
   * @param id - The unique identifier of the agent to delete
   * @returns An Effect that resolves when the agent is successfully deleted
   *
   * @throws {StorageError} When there's an error accessing storage
   * @throws {StorageNotFoundError} When the agent with the given ID doesn't exist
   */
  readonly deleteAgent: (id: string) => Effect.Effect<void, StorageError | StorageNotFoundError>;

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
   */
  readonly validateAgentConfig: (
    config: AgentConfig,
  ) => Effect.Effect<void, AgentConfigurationError>;
}

export const AgentServiceTag = Context.GenericTag<AgentService>("AgentService");
