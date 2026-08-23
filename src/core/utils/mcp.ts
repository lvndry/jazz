import { Duration, Effect, Schedule } from "effect";
import { MCPServerNameParseError } from "@/core/types/errors";

/**
 * Resolve which configured server a prefixed MCP tool name belongs to.
 *
 * The name alone cannot be split reliably: both halves may contain
 * underscores, so `mcp_railway_list_projects` is equally readable as server
 * `railway` tool `list_projects` or server `railway_list` tool `projects`.
 * Matching against the servers that actually exist is the only correct read —
 * splitting on the last underscore silently mis-attributes every tool whose
 * own name has one.
 *
 * @param toolName - The full MCP tool name (e.g. `mcp_railway_list_projects`)
 * @param knownServerNames - Names of the configured MCP servers
 */
export function parseServerNameFromToolName(
  toolName: string,
  knownServerNames: Iterable<string>,
): Effect.Effect<string, MCPServerNameParseError> {
  if (!toolName.startsWith("mcp_")) {
    return Effect.fail(
      new MCPServerNameParseError({
        toolName,
        reason: `Tool name must start with "mcp_" prefix`,
        suggestion: `Expected format: mcp_<servername>_<toolname>, got: ${toolName}`,
      }),
    );
  }

  const lowerToolName = toolName.toLowerCase();
  let bestMatch: string | undefined;

  for (const serverName of knownServerNames) {
    const prefix = `mcp_${serverName.toLowerCase()}_`;
    if (!lowerToolName.startsWith(prefix)) continue;
    // Longest wins, so a server named `railway` cannot claim a tool that
    // belongs to a more specific `railway_staging`.
    if (bestMatch === undefined || serverName.length > bestMatch.length) {
      bestMatch = serverName;
    }
  }

  if (bestMatch === undefined) {
    return Effect.fail(
      new MCPServerNameParseError({
        toolName,
        reason: `No configured MCP server matches tool "${toolName}"`,
        suggestion: `The server may have been removed or renamed since this agent was saved`,
      }),
    );
  }

  return Effect.succeed(bestMatch);
}

/**
 * Extract the set of servers referenced by a list of MCP tool names.
 *
 * Tool names that match no configured server are skipped rather than failing
 * the whole list: an agent saved against a server the user later removed
 * should still open.
 */
export function extractServerNamesFromToolNames(
  toolNames: readonly string[],
  knownServerNames: Iterable<string>,
): Effect.Effect<Set<string>, never> {
  const known = Array.from(knownServerNames);
  return Effect.gen(function* () {
    const serverNames = new Set<string>();

    for (const toolName of toolNames) {
      const resolved = yield* parseServerNameFromToolName(toolName, known).pipe(Effect.option);
      if (resolved._tag === "Some") {
        serverNames.add(resolved.value);
      }
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
  const {
    maxRetries = 3,
    initialDelayMs = 1000,
    maxDelayMs = 10_000,
    shouldRetry = () => true,
  } = options;

  // Create a schedule with exponential backoff
  // Schedule.exponential creates delays that grow exponentially: base * 2^attempt
  // We intersect with Schedule.recurs to limit the number of retries
  // and use Schedule.whileInput to conditionally retry based on error type
  const schedule = Schedule.exponential(`${initialDelayMs} millis`).pipe(
    Schedule.modifyDelay((_, delay) =>
      Duration.min(delay, Duration.millis(Math.max(0, maxDelayMs))),
    ),
    Schedule.intersect(Schedule.recurs(maxRetries)),
    Schedule.whileInput((error: E) => shouldRetry(error)),
  );

  return effect.pipe(Effect.retry(schedule));
}

/**
 * Whether an error looks like the server rejecting our credentials.
 *
 * Used only to pick which remediation to show — "run `jazz mcp auth`" versus a
 * generic connection failure — never as a security decision. Matching is on
 * whole words and specific phrases rather than loose substrings, because the
 * previous heuristic tripped on any message containing "invalid" and sent
 * people to check credentials that were fine.
 */
const AUTH_ERROR_PATTERN =
  /\b(401|403|unauthorized|unauthenticated|forbidden|authentication|authorization|credentials?|api[ _-]?key)\b|\b(invalid|expired|missing)[ _-](token|credentials?|api[ _-]?key|authorization)\b|\bsign[ -]in required\b/i;

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

  return AUTH_ERROR_PATTERN.test(errorMessage);
}
