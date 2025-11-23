import { Effect } from "effect";
import { getAgentByIdentifier, listAllAgents } from "../../core/agent/agent-service";
import { AgentServiceTag, type AgentService } from "../../core/interfaces/agent-service";
import { TerminalServiceTag, type TerminalService } from "../../core/interfaces/terminal";
import { StorageError, StorageNotFoundError } from "../../core/types/errors";

/**
 * CLI commands for agent management
 *
 * These commands handle basic CRUD operations for agents including
 * listing, viewing details, and deletion.
 */

/**
 * List all agents via CLI command
 *
 * Retrieves and displays all available agents in a formatted table showing
 * their ID, name, description, and creation date. When verbose mode
 * is enabled, shows additional details including tools, reasoning effort,
 * LLM provider, and model information.
 *
 * @param options - Command options including verbose mode
 * @returns An Effect that resolves when the agents are listed successfully
 *
 * @throws {StorageError} When there's an error accessing storage
 *
 * @example
 * ```typescript
 * yield* listAgentsCommand({ verbose: true });
 * // Output: Detailed table showing all agents with tools and LLM info
 * ```
 */
export function listAgentsCommand(
  options: { verbose?: boolean } = {},
): Effect.Effect<void, StorageError, AgentService | TerminalService> {
  return Effect.gen(function* () {
    const agents = yield* listAllAgents();
    const terminal = yield* TerminalServiceTag;

    if (agents.length === 0) {
      yield* terminal.info("No agents found. Create your first agent with: jazz agent create");
      return;
    }

    yield* terminal.log(`Found ${agents.length} agent(s):`);
    yield* terminal.log("");

    for (const [index, agent] of agents.entries()) {
      yield* terminal.log(`${index + 1}. ${agent.name} (${agent.id})`);
      yield* terminal.log(`   Description: ${agent.description}`);

      // Always show LLM provider and model
      const llmProvider = agent.config.llmProvider;
      const llmModel = agent.config.llmModel;
      yield* terminal.log(`   Model: ${llmProvider}/${llmModel}`);
      yield* terminal.log(`   Reasoning Effort: ${agent.config.reasoningEffort}`);
      yield* terminal.log(`   Agent Type: ${agent.config.agentType}`);

      yield* terminal.log(`   Created: ${agent.createdAt.toISOString()}`);
      yield* terminal.log(`   Updated: ${agent.updatedAt.toISOString()}`);

      // Show verbose details if requested
      if (options.verbose) {
        yield* terminal.log(`   Agent Type: ${agent.config.agentType || "default"}`);
        yield* terminal.log(`   Reasoning Effort: ${agent.config.reasoningEffort || "low"}`);

        const toolNames = agent.config.tools ?? [];
        if (toolNames.length > 0) {
          yield* terminal.log(`   Tools (${toolNames.length}):`);
          yield* terminal.log(`     ${toolNames.join(", ")}`);
        } else {
          yield* terminal.log(`   Tools: None configured`);
        }

        if (agent.config.environment && Object.keys(agent.config.environment).length > 0) {
          yield* terminal.log(
            `   Environment Variables: ${Object.keys(agent.config.environment).length} configured`,
          );
        }
      }

      yield* terminal.log("");
    }
  });
}

/**
 * Delete an agent via CLI command
 *
 * Removes the specified agent from storage after confirming the deletion.
 * This operation is irreversible and will permanently delete the agent
 * and all its associated data.
 *
 * @param agentId - The unique identifier of the agent to delete
 * @returns An Effect that resolves when the agent is deleted successfully
 *
 * @throws {StorageError} When there's an error accessing storage
 * @throws {StorageNotFoundError} When the agent with the given ID doesn't exist
 *
 * @example
 * ```typescript
 * yield* deleteAgentCommand("agent-123");
 * // Output: Confirmation message and deletion success
 * ```
 */
export function deleteAgentCommand(
  agentIdentifier: string,
): Effect.Effect<void, StorageError | StorageNotFoundError, AgentService | TerminalService> {
  return Effect.gen(function* () {
    const agentService = yield* AgentServiceTag;
    const terminal = yield* TerminalServiceTag;

    // Resolve identifier (ID first, then fall back to matching by name)
    const agent = yield* getAgentByIdentifier(agentIdentifier);

    // Delete the agent
    yield* agentService.deleteAgent(agent.id);

    yield* terminal.success("Agent deleted successfully!");
    yield* terminal.log(`   Name: ${agent.name}`);
    yield* terminal.log(`   ID: ${agent.id}`);
  });
}

/**
 * Get agent details via CLI command
 *
 * Retrieves and displays detailed information about a specific agent including
 * its configuration and metadata in a formatted output.
 *
 * @param agentIdentifier - The agent ID or name to retrieve
 * @returns An Effect that resolves when the agent details are displayed
 *
 * @throws {StorageError} When there's an error accessing storage
 * @throws {StorageNotFoundError} When no agent matches the provided identifier
 *
 * @example
 * ```typescript
 * yield* getAgentCommand("agent-123");
 * yield* getAgentCommand("email-helper");
 * // Output: Detailed agent information including configuration
 * ```
 */
export function getAgentCommand(
  agentIdentifier: string,
): Effect.Effect<void, StorageError | StorageNotFoundError, AgentService | TerminalService> {
  return Effect.gen(function* () {
    const agent = yield* getAgentByIdentifier(agentIdentifier);
    const terminal = yield* TerminalServiceTag;

    yield* terminal.log(`📋 Agent Details:`);
    yield* terminal.log(`   ID: ${agent.id}`);
    yield* terminal.log(`   Name: ${agent.name}`);
    yield* terminal.log(`   Description: ${agent.description}`);
    yield* terminal.log(`   Model: ${agent.model}`);
    yield* terminal.log(`   Created: ${agent.createdAt.toISOString()}`);
    yield* terminal.log(`   Updated: ${agent.updatedAt.toISOString()}`);
    yield* terminal.log("");

    yield* terminal.log(`⚙️  Configuration:`);
    yield* terminal.log(`   Agent Type: ${agent.config.agentType || "default"}`);
    yield* terminal.log(`   LLM Provider: ${agent.config.llmProvider}`);
    yield* terminal.log(`   LLM Model: ${agent.config.llmModel}`);
    yield* terminal.log(`   Reasoning Effort: ${agent.config.reasoningEffort || "low"}`);

    const toolNames = agent.config.tools ?? [];
    if (toolNames.length > 0) {
      yield* terminal.log(`   Tools (${toolNames.length}):`);
      yield* terminal.log(`     ${toolNames.join(", ")}`);
    } else {
      yield* terminal.log(`   Tools: None configured`);
    }

    if (agent.config.environment && Object.keys(agent.config.environment).length > 0) {
      yield* terminal.log(
        `   Environment Variables: ${Object.keys(agent.config.environment).length}`,
      );
    }

    yield* terminal.log("");
  });
}
