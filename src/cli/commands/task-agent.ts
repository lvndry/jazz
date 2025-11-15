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
 * @param options - Configuration options including timeout, retry policy settings
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
 *   { timeout: 30000, maxRetries: 3, retryDelay: 1000 }
 * );
 * ```
 */
export function createAgentCommand(
  name: string,
  description: string,
  options: {
    description?: string;
    timeout?: number;
    maxRetries?: number;
    retryDelay?: number;
    retryBackoff?: "linear" | "exponential" | "fixed";
  },
): Effect.Effect<
  void,
  StorageError | AgentAlreadyExistsError | AgentConfigurationError | ValidationError,
  AgentService
> {
  return Effect.gen(function* () {
    const agentService = yield* AgentServiceTag;

    // Use provided description or default
    const agentDescription = description || options.description || `Agent for ${name}`;

    // Build agent configuration from options
    const config: Partial<AgentConfig> = {};

    if (options.timeout) {
      config.timeout = options.timeout;
    }

    if (
      options.maxRetries !== undefined ||
      options.retryDelay !== undefined ||
      options.retryBackoff
    ) {
      config.retryPolicy = {
        maxRetries: options.maxRetries || 3,
        delay: options.retryDelay || 1000,
        backoff: options.retryBackoff || "exponential",
      };
    }

    // Create the agent
    const agent = yield* agentService.createAgent(name, agentDescription, config);

    // Display success message
    console.log(`✅ Agent created successfully!`);
    console.log(`   ID: ${agent.id}`);
    console.log(`   Name: ${agent.name}`);
    console.log(`   Description: ${agent.description}`);
    console.log(`   Status: ${agent.status}`);
    console.log(`   Created: ${agent.createdAt.toISOString()}`);

    if (config.timeout) {
      console.log(`   Timeout: ${config.timeout}ms`);
    }

    if (config.retryPolicy) {
      console.log(
        `   Retry Policy: ${config.retryPolicy.maxRetries} retries, ${config.retryPolicy.delay}ms delay, ${config.retryPolicy.backoff} backoff`,
      );
    }
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
): Effect.Effect<void, StorageError, AgentService> {
  return Effect.gen(function* () {
    const agents = yield* listAllAgents();

    if (agents.length === 0) {
      console.log("No agents found. Create your first agent with: jazz agent create");
      return;
    }

    console.log(`Found ${agents.length} agent(s):`);
    console.log();

    agents.forEach((agent, index) => {
      console.log(`${index + 1}. ${agent.name} (${agent.id})`);
      console.log(`   Description: ${agent.description}`);

      // Always show LLM provider and model
      const llmProvider = agent.config.llmProvider || "openai";
      const llmModel = agent.config.llmModel || "gpt-4o-mini";
      console.log(`   LLM: ${llmProvider}/${llmModel}`);

      console.log(`   Created: ${agent.createdAt.toISOString()}`);
      console.log(`   Updated: ${agent.updatedAt.toISOString()}`);

      // Show verbose details if requested
      if (options.verbose) {
        console.log(`   Agent Type: ${agent.config.agentType || "default"}`);
        console.log(`   Reasoning Effort: ${agent.config.reasoningEffort || "low"}`);
        console.log(`   Timeout: ${agent.config.timeout || "default"}ms`);

        const toolNames = agent.config.tools ?? [];
        if (toolNames.length > 0) {
          console.log(`   Tools (${toolNames.length}):`);
          console.log(`     ${toolNames.join(", ")}`);
        } else {
          console.log(`   Tools: None configured`);
        }

        if (agent.config.retryPolicy) {
          console.log(
            `   Retry Policy: ${agent.config.retryPolicy.maxRetries} retries, ${agent.config.retryPolicy.delay}ms delay, ${agent.config.retryPolicy.backoff} backoff`,
          );
        }

        if (agent.config.environment && Object.keys(agent.config.environment).length > 0) {
          console.log(
            `   Environment Variables: ${Object.keys(agent.config.environment).length} configured`,
          );
        }

        if (agent.config.schedule) {
          console.log(
            `   Schedule: ${agent.config.schedule.type} - ${agent.config.schedule.value}`,
          );
        }
      }

      console.log();
    });
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
): Effect.Effect<void, StorageError | StorageNotFoundError, AgentService | GmailService> {
  return Effect.gen(function* () {
    const agent = yield* getAgentById(agentId);

    console.log(`🚀 Running agent: ${agent.name} (${agent.id})`);
    console.log(`   Description: ${agent.description}`);
    console.log(`   Status: ${agent.status}`);
    console.log(`   Tasks: ${agent.config.tasks.length}`);

    if (options.dryRun) {
      console.log(`   Mode: DRY RUN (no actual execution)`);
      console.log();
      console.log("Tasks that would be executed:");
      agent.config.tasks.forEach((task, index) => {
        console.log(`   ${index + 1}. ${task.name} (${task.type})`);
        console.log(`      Description: ${task.description}`);
        if (task.dependencies && task.dependencies.length > 0) {
          console.log(`      Dependencies: ${task.dependencies.join(", ")}`);
        }
      });
      return;
    }

    if (options.watch) {
      console.log(`   Mode: WATCH (continuous execution)`);
    }

    console.log();

    // Check if this agent has Gmail tasks
    const gmailTasks = agent.config.tasks.filter((task) => task.type === "gmail");

    if (gmailTasks.length > 0) {
      console.log(`🔍 Found ${gmailTasks.length} Gmail task(s) to execute`);

      // Import the Gmail task executor dynamically

      // Execute each Gmail task
      for (const task of gmailTasks) {
        console.log(`\n📨 Executing Gmail task: ${task.name}`);
        console.log(`   Operation: ${task.config.gmailOperation}`);

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
          console.log(`✅ Task completed successfully in ${result.duration}ms`);

          // Display the output based on the operation
          if (
            task.config.gmailOperation === "list_emails" ||
            task.config.gmailOperation === "search_emails"
          ) {
            try {
              const emails = JSON.parse(result.output || "[]") as GmailEmail[];
              console.log(`\n📬 Found ${emails.length} email(s):`);

              emails.forEach((email: GmailEmail, index: number) => {
                console.log(`\n${index + 1}. ${email.subject}`);
                console.log(`   From: ${email.from}`);
                console.log(`   Date: ${new Date(email.date).toLocaleString()}`);
                console.log(`   ${email.snippet}`);
              });
            } catch {
              console.log(`\n${result.output}`);
            }
          } else {
            console.log(`\n${result.output}`);
          }
        } else {
          console.log(`❌ Task failed: ${result.error}`);
        }
      }
    } else {
      console.log("⚠️  No Gmail tasks found in this agent.");
      console.log("   Other task types are not yet implemented.");
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
): Effect.Effect<void, StorageError | StorageNotFoundError, AgentService> {
  return Effect.gen(function* () {
    const agentService = yield* AgentServiceTag;

    // Resolve identifier (ID first, then fall back to matching by name)
    const agent = yield* getAgentByIdentifier(agentIdentifier);

    // Delete the agent
    yield* agentService.deleteAgent(agent.id);

    console.log(`🗑️  Agent deleted successfully!`);
    console.log(`   Name: ${agent.name}`);
    console.log(`   ID: ${agent.id}`);
  });
}

/**
 * Get agent details via CLI command
 *
 * Retrieves and displays detailed information about a specific agent including
 * its configuration, tasks, and metadata in a formatted output.
 *
 * @param agentId - The unique identifier of the agent to retrieve
 * @returns An Effect that resolves when the agent details are displayed
 *
 * @throws {StorageError} When there's an error accessing storage
 * @throws {StorageNotFoundError} When the agent with the given ID doesn't exist
 *
 * @example
 * ```typescript
 * yield* getAgentCommand("agent-123");
 * // Output: Detailed agent information including config and tasks
 * ```
 */
export function getAgentCommand(
  agentId: string,
): Effect.Effect<void, StorageError | StorageNotFoundError, AgentService> {
  return Effect.gen(function* () {
    const agent = yield* getAgentById(agentId);

    console.log(`📋 Agent Details:`);
    console.log(`   ID: ${agent.id}`);
    console.log(`   Name: ${agent.name}`);
    console.log(`   Description: ${agent.description}`);
    console.log(`   Status: ${agent.status}`);
    console.log(`   Created: ${agent.createdAt.toISOString()}`);
    console.log(`   Updated: ${agent.updatedAt.toISOString()}`);
    console.log();

    console.log(`⚙️  Configuration:`);
    console.log(`   Timeout: ${agent.config.timeout || "default"}ms`);
    console.log(`   Tasks: ${agent.config.tasks.length}`);

    if (agent.config.retryPolicy) {
      console.log(`   Retry Policy:`);
      console.log(`     Max Retries: ${agent.config.retryPolicy.maxRetries}`);
      console.log(`     Delay: ${agent.config.retryPolicy.delay}ms`);
      console.log(`     Backoff: ${agent.config.retryPolicy.backoff}`);
    }

    if (agent.config.environment && Object.keys(agent.config.environment).length > 0) {
      console.log(`   Environment Variables: ${Object.keys(agent.config.environment).length}`);
    }

    if (agent.config.schedule) {
      console.log(`   Schedule: ${agent.config.schedule.type} - ${agent.config.schedule.value}`);
    }

    console.log();

    if (agent.config.tasks.length > 0) {
      console.log(`📝 Tasks:`);
      agent.config.tasks.forEach((task, index) => {
        console.log(`   ${index + 1}. ${task.name} (${task.type})`);
        console.log(`      Description: ${task.description}`);
        console.log(`      ID: ${task.id}`);

        if (task.dependencies && task.dependencies.length > 0) {
          console.log(`      Dependencies: ${task.dependencies.join(", ")}`);
        }

        if (task.maxRetries !== undefined) {
          console.log(`      Max Retries: ${task.maxRetries}`);
        }

        // Show task-specific config
        switch (task.type) {
          case "command":
            if (task.config.command) {
              console.log(`      Command: ${task.config.command}`);
            }
            break;
          case "script":
            if (task.config.script) {
              console.log(
                `      Script: ${task.config.script.substring(0, 100)}${task.config.script.length > 100 ? "..." : ""}`,
              );
            }
            break;
          case "api":
            if (task.config.url) {
              console.log(`      URL: ${task.config.url}`);
              if (task.config.method) {
                console.log(`      Method: ${task.config.method}`);
              }
            }
            break;
          case "file":
            if (task.config.filePath) {
              console.log(`      File Path: ${task.config.filePath}`);
            }
            break;
          case "gmail":
            if (task.config.gmailOperation) {
              console.log(`      Gmail Operation: ${task.config.gmailOperation}`);
              if (task.config.gmailQuery) {
                console.log(`      Query: ${task.config.gmailQuery}`);
              }
              if (task.config.gmailMaxResults) {
                console.log(`      Max Results: ${task.config.gmailMaxResults}`);
              }
            }
            break;
        }
        console.log();
      });
    } else {
      console.log(`📝 No tasks configured for this agent.`);
    }
  });
}
