import { Effect } from "effect";
import { AgentServiceTag, type AgentService } from "../interfaces/agent-service";
import type {
  AgentAlreadyExistsError,
  AgentConfigurationError,
  StorageError,
  ValidationError,
} from "../types/errors";
import { StorageNotFoundError } from "../types/errors";
import type { Agent, AgentConfig } from "../types/index";

/**
 * Helper functions for common agent operations
 *
 * These convenience functions provide a simpler API for using the AgentService
 * from the Effect context. They handle retrieving the service and calling the
 * appropriate methods.
 */

/**
 * Create a new agent using the AgentService
 *
 * This is a convenience function that uses the AgentService from the Effect context
 * to create a new agent.
 *
 * @param name - The unique name for the agent
 * @param description - A description of what the agent does
 * @param config - Optional partial agent configuration
 * @returns An Effect that resolves to the created Agent
 *
 * @throws {ValidationError} When name or description validation fails
 * @throws {AgentAlreadyExistsError} When an agent with the same name already exists
 * @throws {AgentConfigurationError} When the configuration is invalid
 * @throws {StorageError} When the agent cannot be saved to storage
 *
 * @example
 * ```typescript
 * const agent = yield* createAgent(
 *   "email-processor",
 *   "Processes incoming emails and categorizes them",
 * );
 * ```
 */
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

/**
 * Retrieve an agent by ID using the AgentService
 *
 * This is a convenience function that uses the AgentService from the Effect context
 * to retrieve an agent by its unique identifier.
 *
 * @param id - The unique identifier of the agent
 * @returns An Effect that resolves to the Agent or fails if not found
 *
 * @throws {StorageError} When there's an error accessing storage
 * @throws {StorageNotFoundError} When the agent with the given ID doesn't exist
 *
 * @example
 * ```typescript
 * const agent = yield* getAgentById("agent-123");
 * console.log(`Found agent: ${agent.name}`);
 * ```
 */
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
 *
 * @example
 * ```typescript
 * // Can use either ID or name
 * const agent1 = yield* getAgentByIdentifier("abc123");
 * const agent2 = yield* getAgentByIdentifier("my-agent");
 * ```
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
