import { Effect } from "effect";
import type { PresentationService } from "@/core/interfaces/presentation";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import type { JazzError } from "@/core/types/errors";

/**
 * Enhanced error handling utilities with actionable suggestions
 */

export interface ErrorDisplay {
  readonly title: string;
  readonly message: string;
  readonly suggestion?: string;
  readonly recovery?: string[];
  readonly documentation?: string;
  readonly relatedCommands?: string[];
}

/**
 * Generate actionable suggestions for different error types
 *
 * @param error - The error to generate suggestions for
 * @returns An ErrorDisplay object containing title, message, suggestion, recovery steps, and related commands
 * @internal
 */
function generateSuggestions(error: JazzError): ErrorDisplay {
  switch (error._tag) {
    case "AgentNotFoundError": {
      return {
        title: "Agent Not Found",
        message: `No agent found with ID: ${error.agentId}`,
        suggestion:
          error.suggestion || "Check if the agent ID is correct or if the agent was deleted",
        recovery: [
          "List all agents: `jazz agent list`",
          "Check agent ID spelling and case sensitivity",
          "Create a new agent: `jazz agent create`",
        ],
        relatedCommands: ["jazz agent list", "jazz agent create"],
      };
    }

    case "AgentAlreadyExistsError": {
      return {
        title: "Agent Already Exists",
        message: `An agent with name "${error.agentId}" already exists`,
        suggestion: error.suggestion || "Choose a different name or delete the existing agent",
        recovery: [
          "Use a different agent name",
          "Delete existing agent: `jazz agent delete <agent-id>`",
          "Update existing agent: `jazz agent update <agent-id>`",
        ],
        relatedCommands: ["jazz agent delete", "jazz agent list"],
      };
    }

    case "AgentConfigurationError": {
      return {
        title: "Agent Configuration Error",
        message: `Invalid configuration for agent "${error.agentId}": ${error.message}`,
        suggestion: error.suggestion || `Fix the configuration issue in field: ${error.field}`,
        recovery: [
          `Check the ${error.field} field in your agent configuration`,
          "Validate your configuration: `jazz agent validate <agent-id>`",
          "Use the interactive agent editor: `jazz agent edit <agent-id>`",
        ],
        relatedCommands: ["jazz agent get", "jazz agent edit"],
      };
    }

    case "AgentExecutionError": {
      return {
        title: "Agent Execution Failed",
        message: `Agent "${error.agentId}" failed to execute: ${error.reason}`,
        suggestion: error.suggestion || "Check the agent configuration and dependencies",
        recovery: [
          "Check agent configuration: `jazz agent get <agent-id>`",
          "Run with verbose logging: `jazz agent run <agent-id> --verbose`",
          "Test individual tasks: `jazz task test <task-id>`",
        ],
        relatedCommands: ["jazz agent get", "jazz agent run --verbose"],
      };
    }

    case "TaskNotFoundError": {
      return {
        title: "Task Not Found",
        message: `Task with ID "${error.taskId}" not found`,
        suggestion: error.suggestion || "Check if the task ID is correct",
        recovery: [
          "List all tasks: `jazz task list`",
          "Check task ID spelling and case sensitivity",
          "Create a new task: `jazz task create`",
        ],
        relatedCommands: ["jazz task list", "jazz task create"],
      };
    }

    case "TaskExecutionError": {
      return {
        title: "Task Execution Failed",
        message: `Task "${error.taskId}" failed: ${error.reason}`,
        suggestion: error.suggestion || "Check the task configuration and dependencies",
        recovery: [
          "Check task configuration: `jazz task get <task-id>`",
          "Run with debug mode: `jazz task run <task-id> --debug`",
          "Check task dependencies: `jazz task deps <task-id>`",
        ],
        relatedCommands: ["jazz task get", "jazz task run --debug"],
      };
    }

    case "TaskTimeoutError": {
      return {
        title: "Task Timeout",
        message: `Task "${error.taskId}" timed out after ${error.timeout}ms`,
        suggestion: error.suggestion || "Increase the timeout or optimize the task",
        recovery: [
          "Increase task timeout in configuration",
          "Optimize task performance",
          "Check for resource constraints",
          "Run with longer timeout: `jazz task run <task-id> --timeout 60000`",
        ],
        relatedCommands: ["jazz task run --timeout", "jazz agent config"],
      };
    }

    case "TaskDependencyError": {
      return {
        title: "Task Dependency Error",
        message: `Task "${error.taskId}" has dependency issue with "${error.dependencyId}": ${error.reason}`,
        suggestion: error.suggestion || "Resolve the dependency issue",
        recovery: [
          "Check dependency task status: `jazz task get <dependency-id>`",
          "Run dependency task first: `jazz task run <dependency-id>`",
          "Update task dependencies: `jazz task update <task-id>`",
        ],
        relatedCommands: ["jazz task get", "jazz task run"],
      };
    }

    case "ConfigurationError": {
      return {
        title: "Configuration Error",
        message: `Configuration error in field "${error.field}": ${error.message}`,
        suggestion: error.suggestion || "Fix the configuration value",
        recovery: [
          "Check configuration file: `jazz config list`",
          "Validate configuration: `jazz config validate`",
          "Reset to defaults: `jazz config reset`",
        ],
        relatedCommands: ["jazz config list", "jazz config validate"],
      };
    }

    case "ConfigurationNotFoundError": {
      return {
        title: "Configuration File Not Found",
        message: `Configuration file not found at: ${error.path}`,
        suggestion: error.suggestion || "Create a configuration file or check the path",
        recovery: [
          "Create default config: `jazz config init`",
          "Check file path and permissions",
          "Use environment variables instead",
        ],
        relatedCommands: ["jazz config init", "jazz config set"],
      };
    }

    case "ConfigurationValidationError": {
      return {
        title: "Configuration Validation Error",
        message: `Field "${error.field}" expected ${error.expected}, got ${String(error.actual)}`,
        suggestion: error.suggestion || "Update the configuration value to match expected format",
        recovery: [
          "Check configuration documentation",
          "Use correct data type for the field",
          "Validate configuration: `jazz config validate`",
        ],
        relatedCommands: ["jazz config validate", "jazz config set"],
      };
    }

    case "StorageError": {
      return {
        title: "Storage Error",
        message: `Storage operation "${error.operation}" failed on "${error.path}": ${error.reason}`,
        suggestion: error.suggestion || "Check storage permissions and disk space",
        recovery: [
          "Check disk space and permissions",
          "Verify storage path exists",
          "Try different storage location",
        ],
        relatedCommands: ["jazz config set storage.path"],
      };
    }

    case "StorageNotFoundError": {
      return {
        title: "Storage Not Found",
        message: `Storage location not found: ${error.path}`,
        suggestion: error.suggestion || "Create the storage directory or check the path",
        recovery: [
          "Create storage directory: `mkdir -p ${error.path}`",
          "Check storage configuration: `jazz config get storage`",
          "Use different storage path",
        ],
        relatedCommands: ["jazz config set storage.path"],
      };
    }

    case "StoragePermissionError": {
      return {
        title: "Storage Permission Error",
        message: `Permission denied for operation "${error.operation}" on "${error.path}"`,
        suggestion: error.suggestion || "Fix file permissions or run with appropriate privileges",
        recovery: [
          "Check file permissions: `ls -la ${error.path}`",
          "Fix permissions: `chmod 755 ${error.path}`",
          "Run with appropriate user privileges",
        ],
        relatedCommands: ["jazz config set storage.path"],
      };
    }

    case "CLIError": {
      return {
        title: "CLI Error",
        message: `Command "${error.command}" failed: ${error.message}`,
        suggestion: error.suggestion || "Check command syntax and options",
        recovery: [
          "Check command help: `jazz <command> --help`",
          "Verify command syntax",
          "Check required options and arguments",
        ],
        relatedCommands: ["jazz --help", `jazz ${error.command} --help`],
      };
    }

    case "ValidationError": {
      return {
        title: "Validation Error",
        message: `Field "${error.field}" validation failed: ${error.message}`,
        suggestion: error.suggestion || "Provide a valid value for the field",
        recovery: [
          "Check field requirements and format",
          "Use valid characters and length limits",
          "Refer to documentation for field specifications",
        ],
        relatedCommands: ["jazz --help"],
      };
    }

    case "NetworkError": {
      return {
        title: "Network Error",
        message: `Network request to "${error.url}" failed: ${error.reason}`,
        suggestion: error.suggestion || "Check network connectivity and URL",
        recovery: [
          "Check internet connection",
          "Verify URL is correct and accessible",
          "Check firewall and proxy settings",
          "Retry the operation",
        ],
        relatedCommands: ["jazz config get network"],
      };
    }

    case "APIError": {
      return {
        title: "API Error",
        message: `API call to "${error.endpoint}" failed with status ${error.statusCode}: ${error.message}`,
        suggestion: error.suggestion || "Check API credentials and endpoint status",
        recovery: [
          "Verify API credentials: `jazz config get api`",
          "Check API service status",
          "Review API rate limits",
          "Update API configuration",
        ],
        relatedCommands: ["jazz config get api", "jazz auth status"],
      };
    }

    case "FileSystemError": {
      return {
        title: "File System Error",
        message: `File operation "${error.operation}" failed on "${error.path}": ${error.reason}`,
        suggestion: error.suggestion || "Check file path and permissions",
        recovery: [
          "Verify file path exists",
          "Check file permissions",
          "Ensure sufficient disk space",
        ],
        relatedCommands: ["jazz config get storage"],
      };
    }

    case "FileNotFoundError": {
      return {
        title: "File Not Found",
        message: `File not found: ${error.path}`,
        suggestion: error.suggestion || "Check if the file exists and path is correct",
        recovery: [
          "Verify file path: `ls -la ${error.path}`",
          "Check file permissions",
          "Create the file if needed",
        ],
        relatedCommands: ["jazz config get storage"],
      };
    }

    case "FilePermissionError": {
      return {
        title: "File Permission Error",
        message: `Permission denied for operation "${error.operation}" on "${error.path}"`,
        suggestion: error.suggestion || "Fix file permissions or run with appropriate privileges",
        recovery: [
          "Check file permissions: `ls -la ${error.path}`",
          "Fix permissions: `chmod 644 ${error.path}`",
          "Run with appropriate user privileges",
        ],
        relatedCommands: ["jazz config get storage"],
      };
    }

    case "TimeoutError": {
      return {
        title: "Operation Timeout",
        message: `Operation "${error.operation}" timed out after ${error.timeout}ms`,
        suggestion: error.suggestion || "Increase timeout or optimize the operation",
        recovery: [
          "Increase operation timeout",
          "Check for resource constraints",
          "Optimize operation performance",
          "Retry the operation",
        ],
        relatedCommands: ["jazz config get performance"],
      };
    }

    case "ResourceExhaustedError": {
      return {
        title: "Resource Exhausted",
        message: `Resource "${error.resource}" limit exceeded: ${error.current}/${error.limit}`,
        suggestion: error.suggestion || "Free up resources or increase limits",
        recovery: [
          "Free up system resources",
          "Increase resource limits in configuration",
          "Optimize resource usage",
          "Restart the application",
        ],
        relatedCommands: ["jazz config get performance"],
      };
    }

    case "InternalError": {
      return {
        title: "Internal Error",
        message: `Internal error in ${error.component}: ${error.message}`,
        suggestion: error.suggestion || "This is an internal error. Please report it.",
        recovery: [
          "Restart the application",
          "Check application logs",
          "Report the issue to support",
          "Update to latest version",
        ],
        relatedCommands: ["jazz logs", "jazz --version"],
      };
    }

    case "LLMConfigurationError": {
      return {
        title: "LLM Configuration Error",
        message: `LLM provider "${error.provider}" configuration error: ${error.message}`,
        suggestion: error.suggestion || "Check your LLM provider configuration and API keys",
        recovery: [
          "Check API key configuration: `jazz config get llm.${error.provider}`",
          "Set API key: `jazz config set llm.${error.provider}.api_key <your-key>`",
          "Verify provider is supported",
          "Check provider documentation",
        ],
        relatedCommands: ["jazz config get llm", "jazz config set llm"],
      };
    }

    case "LLMAuthenticationError": {
      return {
        title: "LLM Authentication Error",
        message: `Authentication failed for LLM provider "${error.provider}": ${error.message}`,
        suggestion: error.suggestion || "Check your API credentials and authentication",
        recovery: [
          "Verify API key is correct and active",
          "Check API key permissions",
          "Regenerate API key if needed",
          "Check provider service status",
        ],
        relatedCommands: ["jazz config get llm", "jazz auth status"],
      };
    }

    case "PersonaNotFoundError": {
      return {
        title: "Persona Not Found",
        message: `No persona found with ID or name: ${error.personaId}`,
        suggestion:
          error.suggestion ||
          "Check if the persona ID/name is correct or if the persona was deleted",
        recovery: [
          "List all personas: `jazz persona list`",
          "Check persona ID/name spelling and case sensitivity",
          "Create a new persona when creating an agent: `jazz agent create`",
        ],
        relatedCommands: ["jazz persona list", "jazz agent create"],
      };
    }

    case "PersonaAlreadyExistsError": {
      return {
        title: "Persona Already Exists",
        message: `A persona with name "${error.personaName}" already exists`,
        suggestion: error.suggestion || "Choose a different name or update the existing persona",
        recovery: [
          "Use a different persona name",
          "List existing personas: `jazz persona list`",
          "Edit agent to select different persona: `jazz agent edit <agent-id>`",
        ],
        relatedCommands: ["jazz persona list", "jazz agent edit"],
      };
    }

    default: {
      // Surface actual error type and message for unhandled tagged errors (e.g. new error types)
      const tag = error._tag;
      const message =
        "message" in error && typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : "reason" in error && typeof (error as { reason?: unknown }).reason === "string"
            ? (error as { reason: string }).reason
            : "An unexpected error occurred";
      return {
        title: tag ?? "Unknown Error",
        message: message,
        suggestion:
          "Please report this error to the development team (include the error type and message above).",
        recovery: ["Check application logs", "Restart the application", "Report the issue"],
        relatedCommands: ["jazz logs", "jazz --help"],
      };
    }
  }
}

/**
 * Format error for display with actionable suggestions
 *
 * Takes a JazzError and formats it into a user-friendly string with:
 * - Clear error title and message
 * - Actionable suggestions
 * - Step-by-step recovery instructions
 * - Related CLI commands
 *
 * @param error - The error to format
 * @returns A formatted string ready for console output
 *
 */
export function formatError(error: JazzError): string {
  const display = generateSuggestions(error);

  let output = `❌ ${display.title}\n`;
  output += `   ${display.message}\n`;

  if (display.suggestion) {
    output += `\n💡 Suggestion: ${display.suggestion}\n`;
  }

  if (display.recovery && display.recovery.length > 0) {
    output += `\n🔧 Recovery Steps:\n`;
    display.recovery.forEach((step, index) => {
      output += `   ${index + 1}. ${step}\n`;
    });
  }

  if (display.relatedCommands && display.relatedCommands.length > 0) {
    output += `\n📚 Related Commands:\n`;
    display.relatedCommands.forEach((cmd) => {
      output += `   • ${cmd}\n`;
    });
  }

  if (display.documentation) {
    output += `\n📖 Documentation: ${display.documentation}\n`;
  }

  return output;
}

/**
 * Enhanced error handler that provides actionable suggestions
 *
 * Handles both JazzError types (with structured suggestions) and generic Error objects.
 * For JazzError types, it formats them with actionable suggestions, recovery steps, and related commands.
 * For generic Error objects, it provides a basic error message with general guidance.
 *
 * @param error - The error to handle (JazzError or generic Error)
 * @returns An Effect that logs the formatted error to the console
 *
 */
export function handleError(
  error: JazzError | Error,
): Effect.Effect<void, never, PresentationService> {
  return Effect.gen(function* () {
    const presentation = yield* PresentationServiceTag;

    // Handle ExitPromptError from inquirer (Ctrl+C during prompts)
    if (
      error instanceof Error &&
      (error.name === "ExitPromptError" || error.message.includes("SIGINT"))
    ) {
      yield* presentation.writeOutput("\n👋 Goodbye!\n");
      return;
    }

    // Effect.tryPromise / Effect.try failures: surface the underlying cause (Effect's UnknownException)
    const unknownException =
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      (error as { _tag: string })._tag === "UnknownException" &&
      "error" in error
        ? (error as { error: unknown })
        : null;
    if (unknownException) {
      const cause = unknownException.error;
      const message =
        cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);
      yield* presentation.writeOutput(
        `❌ Error\n   ${message}\n\n💡 Suggestion: Check the error details and try again.\n\n📚 Related Commands:\n   • jazz logs\n   • jazz --help\n`,
      );
      return;
    }

    // Check if it's a JazzError (has _tag property)
    if ("_tag" in error && typeof error._tag === "string") {
      const formattedError = formatError(error);
      yield* presentation.writeOutput(formattedError);
    } else {
      // Handle generic Error objects
      const genericError = error;
      yield* presentation.writeOutput(
        `❌ Error\n   ${genericError.message}\n\n💡 Suggestion: Check the error details and try again\n\n📚 Related Commands:\n   • jazz --help\n   • jazz logs\n`,
      );
    }
  });
}

/**
 * Common error suggestions for frequently encountered error scenarios
 *
 * Provides reusable suggestion templates that can be used across different error types
 * to maintain consistency in error messaging and reduce duplication.
 *
 */
export const CommonSuggestions = {
  /**
   * Suggestion for when an agent is not found
   * @param _agentId - The agent ID that was not found (unused but kept for consistency)
   * @returns A suggestion string with commands to list or create agents
   */
  checkAgentExists: (_agentId: string) =>
    `Run 'jazz agent list' to see available agents or create a new one with 'jazz agent create'`,

  /**
   * Suggestion for configuration-related errors
   * @param field - The configuration field that has an issue
   * @returns A suggestion string with commands to check or update the configuration
   */
  checkConfiguration: (field: string) =>
    `Run 'jazz config get ${field}' to check current value or 'jazz config set ${field} <value>' to update`,

  /**
   * Suggestion for file permission errors
   * @param path - The file path that has permission issues
   * @returns A suggestion string with commands to check and fix permissions
   */
  checkPermissions: (path: string) =>
    `Check file permissions with 'ls -la ${path}' and fix with 'chmod 755 ${path}' if needed`,

  /**
   * Suggestion for network-related errors
   * @returns A suggestion string for network connectivity issues
   */
  checkNetwork: () =>
    `Check your internet connection and try again. If using a proxy, configure it in your environment`,

  /**
   * Suggestion for authentication errors
   * @param service - The service that requires authentication
   * @returns A suggestion string with commands to authenticate or check status
   */
  checkCredentials: (service: string) =>
    `Run 'jazz auth ${service} login' to authenticate or check credentials with 'jazz auth ${service} status'`,

  /**
   * Suggestion for timeout errors
   * @param currentTimeout - The current timeout value in milliseconds
   * @returns A suggestion string recommending a higher timeout value
   */
  increaseTimeout: (currentTimeout: number) =>
    `Try increasing the timeout to ${currentTimeout * 2}ms or more in your configuration`,

  /**
   * Suggestion for task dependency errors
   * @param taskId - The task ID that has dependency issues
   * @returns A suggestion string with commands to check task dependencies
   */
  checkDependencies: (taskId: string) =>
    `Run 'jazz task deps ${taskId}' to check task dependencies and resolve any issues`,
} as const;
