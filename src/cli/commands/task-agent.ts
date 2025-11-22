import { Effect } from "effect";
import {
  AgentServiceTag,
  getAgentById,
  getAgentByIdentifier,
  listAllAgents,
  type AgentService,
} from "../../core/agent/agent-service";
import { executeGmailTask } from "../../core/agent/gmail-agent";
import {
  AgentAlreadyExistsError,
  AgentConfigurationError,
  StorageError,
  StorageNotFoundError,
  ValidationError,
} from "../../core/types/errors";
import type { AgentConfig } from "../../core/types/index";
import type { GmailEmail, GmailService } from "../../services/gmail";
import { TerminalServiceTag, type TerminalService } from "../../services/terminal";

/**
 * CLI commands for task-based agent management
 *
 * These commands handle traditional automation agents that execute predefined tasks
 * like Gmail operations, shell commands, API calls, etc. They focus on workflow
 * automation rather than conversational AI interactions.
 */

/**
 * Create a new agent via CLI command
 *
 * Creates a new agent with the specified name, description, and configuration options.
 * The command validates input parameters and displays success information including
 * the agent ID, configuration details, and timestamps.
 *
 * @param name - The unique name for the agent
 * @param description - A description of what the agent does
 * @returns An Effect that resolves when the agent is created successfully
 *
 * @throws {StorageError} When there's an error saving the agent
 * @throws {AgentAlreadyExistsError} When an agent with the same name already exists
 * @throws {AgentConfigurationError} When the configuration is invalid
 * @throws {ValidationError} When input validation fails
 *
 * @example
 * ```typescript
 * yield* createAgentCommand(
 *   "email-processor",
 *   "Processes incoming emails",
 * );
 * ```
 */
export function createAgentCommand(
  name: string,
  description: string,
  options: {
    description?: string;
  },
): Effect.Effect<
  void,
  StorageError | AgentAlreadyExistsError | AgentConfigurationError | ValidationError,
  AgentService | TerminalService
> {
  return Effect.gen(function* () {
    const agentService = yield* AgentServiceTag;
    const terminal = yield* TerminalServiceTag;

    // Use provided description or default
    const agentDescription = description || options.description || `Agent for ${name}`;

    // Build agent configuration from options
    const config: Partial<AgentConfig> = {};

    // Create the agent
    const agent = yield* agentService.createAgent(name, agentDescription, config);

    // Display success message
    yield* terminal.success("Agent created successfully!");
    yield* terminal.log(`   ID: ${agent.id}`);
    yield* terminal.log(`   Name: ${agent.name}`);
    yield* terminal.log(`   Description: ${agent.description}`);
    yield* terminal.log(`   Created: ${agent.createdAt.toISOString()}`);

    yield* terminal.log(`   Model: ${agent.model}`);
  });
}

/**
 * List all agents via CLI command
 *
 * Retrieves and displays all available agents in a formatted table showing
 * their ID, name, description, status, and creation date. When verbose mode
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
      const llmProvider = agent.config.llmProvider || "openai";
      const llmModel = agent.config.llmModel || "gpt-4o-mini";
      yield* terminal.log(`   LLM: ${llmProvider}/${llmModel}`);

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

        if (agent.config.schedule) {
          yield* terminal.log(
            `   Schedule: ${agent.config.schedule.type} - ${agent.config.schedule.value}`,
          );
        }
      }

      yield* terminal.log("");
    }
  });
}

/**
 * Run an agent via CLI command
 *
 * Executes the specified agent, including all its configured tasks. Supports
 * dry-run mode for testing and watch mode for continuous execution. For Gmail
 * tasks, it displays formatted email results including subject, sender, date,
 * and snippet information.
 *
 * @param agentId - The unique identifier of the agent to run
 * @param options - Execution options including watch and dry-run modes
 * @returns An Effect that resolves when the agent execution completes
 *
 * @throws {StorageError} When there's an error accessing storage
 * @throws {StorageNotFoundError} When the agent with the given ID doesn't exist
 *
 * @example
 * ```typescript
 * yield* runAgentCommand("agent-123", { dryRun: true });
 * ```
 */
export function runAgentCommand(
  agentId: string,
  options: {
    watch?: boolean;
    dryRun?: boolean;
  },
): Effect.Effect<
  void,
  StorageError | StorageNotFoundError,
  AgentService | GmailService | TerminalService
> {
  return Effect.gen(function* () {
    const agent = yield* getAgentById(agentId);
    const terminal = yield* TerminalServiceTag;

    yield* terminal.info(`Running agent: ${agent.name} (${agent.id})`);
    yield* terminal.log(`   Description: ${agent.description}`);
    yield* terminal.log(`   Tasks: ${agent.config.tasks.length}`);

    if (options.dryRun) {
      yield* terminal.log(`   Mode: DRY RUN (no actual execution)`);
      yield* terminal.log("");
      yield* terminal.log("Tasks that would be executed:");
      for (const [index, task] of agent.config.tasks.entries()) {
        yield* terminal.log(`   ${index + 1}. ${task.name} (${task.type})`);
        yield* terminal.log(`      Description: ${task.description}`);
        if (task.dependencies && task.dependencies.length > 0) {
          yield* terminal.log(`      Dependencies: ${task.dependencies.join(", ")}`);
        }
      }
      return;
    }

    if (options.watch) {
      yield* terminal.log(`   Mode: WATCH (continuous execution)`);
    }

    yield* terminal.log("");

    // Check if this agent has Gmail tasks
    const gmailTasks = agent.config.tasks.filter((task) => task.type === "gmail");

    if (gmailTasks.length > 0) {
      yield* terminal.info(`Found ${gmailTasks.length} Gmail task(s) to execute`);

      // Execute each Gmail task
      for (const task of gmailTasks) {
        yield* terminal.log(`\n📨 Executing Gmail task: ${task.name}`);
        yield* terminal.log(`   Operation: ${task.config.gmailOperation}`);

        const result = yield* executeGmailTask(task).pipe(
          Effect.catchAll((error) =>
            Effect.succeed({
              taskId: task.id,
              status: "failure",
              error: error instanceof Error ? error.message : String(error),
              duration: 0,
              timestamp: new Date(),
              output: "[]",
            }),
          ),
        );

        if (result.status === "success") {
          yield* terminal.success(`Task completed successfully in ${result.duration}ms`);

          // Display the output based on the operation
          if (
            task.config.gmailOperation === "list_emails" ||
            task.config.gmailOperation === "search_emails"
          ) {
            try {
              const emails = JSON.parse(result.output || "[]") as GmailEmail[];
              yield* terminal.log(`\n📬 Found ${emails.length} email(s):`);

              for (const [index, email] of emails.entries()) {
                yield* terminal.log(`\n${index + 1}. ${email.subject}`);
                yield* terminal.log(`   From: ${email.from}`);
                yield* terminal.log(`   Date: ${new Date(email.date).toLocaleString()}`);
                yield* terminal.log(`   ${email.snippet}`);
              }
            } catch {
              yield* terminal.log(`\n${result.output}`);
            }
          } else {
            yield* terminal.log(`\n${result.output}`);
          }
        } else {
          yield* terminal.error(`Task failed: ${result.error}`);
        }
      }
    } else {
      yield* terminal.warn("No Gmail tasks found in this agent.");
      yield* terminal.log("   Other task types are not yet implemented.");
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
 * its configuration, tasks, and metadata in a formatted output.
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
 * // Output: Detailed agent information including config and tasks
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
    yield* terminal.log(`   Tasks: ${agent.config.tasks.length}`);

    if (agent.config.environment && Object.keys(agent.config.environment).length > 0) {
      yield* terminal.log(
        `   Environment Variables: ${Object.keys(agent.config.environment).length}`,
      );
    }

    if (agent.config.schedule) {
      yield* terminal.log(
        `   Schedule: ${agent.config.schedule.type} - ${agent.config.schedule.value}`,
      );
    }

    yield* terminal.log("");

    if (agent.config.tasks.length > 0) {
      yield* terminal.log(`📝 Tasks:`);
      for (const [index, task] of agent.config.tasks.entries()) {
        yield* terminal.log(`   ${index + 1}. ${task.name} (${task.type})`);
        yield* terminal.log(`      Description: ${task.description}`);
        yield* terminal.log(`      ID: ${task.id}`);

        if (task.dependencies && task.dependencies.length > 0) {
          yield* terminal.log(`      Dependencies: ${task.dependencies.join(", ")}`);
        }

        // Show task-specific config
        switch (task.type) {
          case "command":
            if (task.config.command) {
              yield* terminal.log(`      Command: ${task.config.command}`);
            }
            break;
          case "script":
            if (task.config.script) {
              yield* terminal.log(
                `      Script: ${task.config.script.substring(0, 100)}${task.config.script.length > 100 ? "..." : ""}`,
              );
            }
            break;
          case "api":
            if (task.config.url) {
              yield* terminal.log(`      URL: ${task.config.url}`);
              if (task.config.method) {
                yield* terminal.log(`      Method: ${task.config.method}`);
              }
            }
            break;
          case "file":
            if (task.config.filePath) {
              yield* terminal.log(`      File Path: ${task.config.filePath}`);
            }
            break;
          case "gmail":
            if (task.config.gmailOperation) {
              yield* terminal.log(`      Gmail Operation: ${task.config.gmailOperation}`);
              if (task.config.gmailQuery) {
                yield* terminal.log(`      Query: ${task.config.gmailQuery}`);
              }
              if (task.config.gmailMaxResults) {
                yield* terminal.log(`      Max Results: ${task.config.gmailMaxResults}`);
              }
            }
            break;
        }
        yield* terminal.log("");
      }
    } else {
      yield* terminal.log(`📝 No tasks configured for this agent.`);
    }
  });
}
