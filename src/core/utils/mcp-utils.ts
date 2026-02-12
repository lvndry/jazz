import { Effect, Schedule } from "effect";
import { MCPServerNameParseError } from "@/core/types/errors";

/**
 * Parse server name from MCP tool name
 *
 * MCP tool names follow the pattern: mcp_<servername>_<toolname>
 * Server names can contain underscores (e.g., "atlas-local", "my_server")
 *
 * @param toolName - The full MCP tool name (e.g., "mcp_mongodb_aggregate" or "mcp_atlas-local_connect")
 * @returns The server name or an error
 */
export function parseServerNameFromToolName(
  toolName: string,
): Effect.Effect<string, MCPServerNameParseError> {
  // Validate format: must start with "mcp_" and have at least 3 parts
  if (!toolName.startsWith("mcp_")) {
    return Effect.fail(
      new MCPServerNameParseError({
        toolName,
        reason: `Tool name must start with "mcp_" prefix`,
        suggestion: `Expected format: mcp_<servername>_<toolname>, got: ${toolName}`,
      }),
    );
  }

  // Remove "mcp_" prefix
  const withoutPrefix = toolName.slice(4);

  // Find the last underscore (separates server name from tool name)
  const lastUnderscoreIndex = withoutPrefix.lastIndexOf("_");

  if (lastUnderscoreIndex === -1 || lastUnderscoreIndex === 0) {
    return Effect.fail(
      new MCPServerNameParseError({
        toolName,
        reason: `Tool name must have format mcp_<servername>_<toolname>`,
        suggestion: `Could not find server name separator. Expected at least one underscore after "mcp_" prefix`,
      }),
    );
  }

  // Extract server name (everything before the last underscore)
  const serverName = withoutPrefix.slice(0, lastUnderscoreIndex);

  if (serverName.length === 0) {
    return Effect.fail(
      new MCPServerNameParseError({
        toolName,
        reason: `Server name cannot be empty`,
        suggestion: `Tool name format: mcp_<servername>_<toolname>`,
      }),
    );
  }

  return Effect.succeed(serverName);
}

/**
 * Extract unique server names from a list of MCP tool names
 *
 * @param toolNames - Array of MCP tool names
 * @returns Set of unique server names
 */
export function extractServerNamesFromToolNames(
  toolNames: readonly string[],
): Effect.Effect<Set<string>, MCPServerNameParseError> {
  return Effect.gen(function* () {
    const serverNames = new Set<string>();

    for (const toolName of toolNames) {
      const serverName = yield* parseServerNameFromToolName(toolName);
      serverNames.add(serverName);
    }

    return serverNames;
  });
}

/**
 * Retry an Effect with exponential backoff
 *
 * @param effect - The Effect to retry
 * @param maxRetries - Maximum number of retries (default: 3)
 * @param initialDelayMs - Initial delay in milliseconds (default: 1000)
 * @param maxDelayMs - Maximum delay in milliseconds (default: 10000)
 * @param shouldRetry - Function to determine if error should be retried (default: always retry)
 */
export function retryWithBackoff<E, A, R>(
  effect: Effect.Effect<A, E, R>,
  options: {
    readonly maxRetries?: number;
    readonly initialDelayMs?: number;
    readonly maxDelayMs?: number;
    readonly shouldRetry?: (error: E) => boolean;
  } = {},
): Effect.Effect<A, E, R> {
  const { maxRetries = 3, initialDelayMs = 1000, shouldRetry = () => true } = options;

  // Create a schedule with exponential backoff
  // Schedule.exponential creates delays that grow exponentially: base * 2^attempt
  // We intersect with Schedule.recurs to limit the number of retries
  // and use Schedule.whileInput to conditionally retry based on error type
  const schedule = Schedule.exponential(`${initialDelayMs} millis`).pipe(
    Schedule.intersect(Schedule.recurs(maxRetries)),
    Schedule.whileInput((error: E) => shouldRetry(error)),
  );

  return effect.pipe(Effect.retry(schedule));
}

/**
 * Check if an error indicates that authentication is required
 *
 * MCP servers may require authentication and can take longer than normal timeouts.
 * This function detects common patterns that indicate authentication is needed.
 *
 * @param error - The error to check
 * @returns true if the error suggests authentication is required
 */
export function isAuthenticationRequired(error: unknown): boolean {
  if (error === null || error === undefined) {
    return false;
  }

  const errorMessage =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error);

  const lowerMessage = errorMessage.toLowerCase();

  // Check for authentication-related keywords
  const authKeywords = [
    "authentication",
    "authenticate",
    "auth",
    "login",
    "credential",
    "password",
    "token",
    "api key",
    "api_key",
    "authorization",
    "unauthorized",
    "401",
    "403",
    "please sign in",
    "sign in required",
    "authentication required",
    "authentication needed",
  ];

  return authKeywords.some((keyword) => lowerMessage.includes(keyword));
}
