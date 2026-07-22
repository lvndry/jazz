import { APICallError, RetryError } from "ai";
import { Duration, Schedule } from "effect";
import { MAX_RETRY_DELAY_SECONDS } from "@/core/constants/agent";
import type { ProviderName } from "@/core/constants/models";
import {
  LLMAuthenticationError,
  LLMRateLimitError,
  LLMRequestError,
  type LLMError,
} from "@/core/types/errors";
import { formatProviderDisplayName } from "@/core/utils/string";

/**
 * Core truncation logic: truncate contents array to keep first message + last N messages.
 * Returns the truncated contents array or undefined if no truncation needed.
 */
function truncateContentsArray(
  contents: unknown[],
  keepLastMessages: number,
): unknown[] | undefined {
  if (contents.length <= keepLastMessages) {
    return undefined;
  }

  return [
    ...contents.slice(0, 1), // Keep first message (usually system/user prompt)
    ...contents.slice(-keepLastMessages), // Keep last N messages
  ];
}

/**
 * Truncate requestBodyValues to keep only the last N messages in contents array.
 * This prevents verbose error logs when API calls fail with large conversation histories.
 * Handles both direct errors and nested errors (e.g., AI_RetryError with errors array).
 * Returns the truncated requestBodyValues object or undefined if not found.
 */
export function truncateRequestBodyValues(
  error: unknown,
  keepLastMessages: number = 5,
): Record<string, unknown> | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const errorObj = error as Record<string, unknown>;

  // Check for direct requestBodyValues
  let requestBodyValues = errorObj["requestBodyValues"];

  // If not found, check nested errors array (e.g., AI_RetryError)
  if (!requestBodyValues && Array.isArray(errorObj["errors"])) {
    const errors = errorObj["errors"] as Array<unknown>;
    for (const nestedError of errors) {
      if (nestedError && typeof nestedError === "object") {
        const nested = nestedError as Record<string, unknown>;
        if (nested["requestBodyValues"]) {
          requestBodyValues = nested["requestBodyValues"];
          break;
        }
      }
    }
  }

  if (!requestBodyValues || typeof requestBodyValues !== "object") {
    return undefined;
  }

  const bodyValues = requestBodyValues as Record<string, unknown>;
  const messages = bodyValues["messages"] || bodyValues["messages"];

  if (!Array.isArray(messages)) {
    return undefined;
  }

  const messagesArray = messages as unknown[];

  // Truncate to last N messages
  const truncatedContents = truncateContentsArray(messagesArray, keepLastMessages);

  if (!truncatedContents) {
    return undefined;
  }

  return {
    ...bodyValues,
    contents: truncatedContents,
    _truncated: true,
  };
}

/**
 * Extract a clean, user-friendly error message from an error.
 * Returns just the core message without verbose details.
 */
export function extractCleanErrorMessage(error: unknown): string {
  if (RetryError.isInstance(error)) {
    const lastError = error.lastError;
    if (lastError !== undefined) {
      return extractCleanErrorMessage(lastError);
    }
    return error.message;
  }

  if (error instanceof Error) {
    // For API errors, try to extract just the message without all the extra properties
    if (APICallError.isInstance(error)) {
      // APICallError.message usually contains the API error message
      // Remove any " | " separators and extra details for cleaner display
      let message = error.message;
      // Split by " | " and take the first part (the actual error message)
      if (message.includes(" | ")) {
        message = message.split(" | ")[0] || message;
      }
      // Also handle cases where the message might have "|" without spaces
      if (message.includes("|")) {
        // Try to extract just the meaningful part before any pipe
        const parts = message.split("|");
        // If the first part looks like a complete error message, use it
        if (parts[0] && parts[0].trim().length > 0) {
          message = parts[0].trim();
        }
      }
      return message;
    }
    // For other errors, clean the message similarly
    let message = error.message;
    if (message.includes(" | ")) {
      message = message.split(" | ")[0] || message;
    }
    return message;
  }

  // Handle AI SDK specific error types that might be strings or plain objects
  const errorString = String(error);
  if (errorString.includes("AI_LoadAPIKeyError")) {
    return "API key is missing. Use 'jazz config set' or the wizard to configure it.";
  }

  if (error && typeof error === "object") {
    const errorData = error as Record<string, unknown>;
    // Try to find a message property
    if (typeof errorData["message"] === "string") {
      let message = errorData["message"];
      // Clean the message
      if (message.includes(" | ")) {
        message = message.split(" | ")[0] || message;
      }
      return message;
    }
    // Try to find an error.message nested structure
    if (errorData["error"] && typeof errorData["error"] === "object") {
      const errorObj = errorData["error"] as Record<string, unknown>;
      if (typeof errorObj["message"] === "string") {
        let message = errorObj["message"];
        // Clean the message
        if (message.includes(" | ")) {
          message = message.split(" | ")[0] || message;
        }
        return message;
      }
    }
  }

  // Clean the string representation too
  if (errorString.includes(" | ")) {
    return errorString.split(" | ")[0] || errorString;
  }
  return errorString;
}

/**
 * Local providers Jazz talks to over a user-managed HTTP server. A connection
 * failure against these usually means the server simply is not running.
 */
const LOCAL_SERVER_PROVIDERS = {
  llamacpp: {
    name: "llama.cpp",
    defaultUrl: "http://localhost:8080",
    startHint: "llama-server -m <model>.gguf --port 8080 --jinja",
  },
  ollama: {
    name: "Ollama",
    defaultUrl: "http://localhost:11434",
    startHint: "ollama serve",
  },
} as const satisfies Partial<Record<ProviderName, unknown>>;

/**
 * Detect errors that mean the request never reached a server: connection
 * refused/reset, DNS failure, or the generic `fetch failed` wrapper Node/Bun
 * throw for those. The check walks nested causes (fetch wraps the OS error).
 */
export function isConnectionError(error: unknown): boolean {
  const markers = [
    "econnrefused",
    "econnreset",
    "enotfound",
    "eai_again",
    "fetch failed",
    "failed to fetch",
    "unable to connect",
    "connection refused",
    "connect etimedout",
  ];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { message?: unknown; code?: unknown; cause?: unknown };
    const haystack = `${typeof record.message === "string" ? record.message : ""} ${
      typeof record.code === "string" ? record.code : ""
    }`.toLowerCase();
    if (markers.some((marker) => haystack.includes(marker))) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

/**
 * Actionable message for a local server that could not be reached, telling the
 * user how to start it. Returns undefined for non-local providers.
 */
export function localServerUnreachableMessage(providerName: ProviderName): string | undefined {
  if (!(providerName in LOCAL_SERVER_PROVIDERS)) {
    return undefined;
  }
  const local = LOCAL_SERVER_PROVIDERS[providerName as keyof typeof LOCAL_SERVER_PROVIDERS];
  return `Cannot reach the ${local.name} server (expected at ${local.defaultUrl}). Make sure it is running — start it with:\n  ${local.startHint}\nIf it listens elsewhere, set the base URL via 'jazz config set llm.${providerName}.base_url <url>'.`;
}

/**
 * Convert unknown error to appropriate LLMError type.
 * Handles API call errors, HTTP status codes, and error message parsing
 * to create the most appropriate LLM error type.
 *
 * @param error - The unknown error to convert
 * @param providerName - The LLM provider name for context
 * @returns An appropriate LLMError instance
 *
 */
export function convertToLLMError(error: unknown, providerName: ProviderName): LLMError {
  // Use clean message for user-facing error (keeps terminal output readable)
  const cleanMessage = extractCleanErrorMessage(error);

  // A connection failure against a local server is almost always "server not
  // running" — surface how to start it instead of a bare "fetch failed".
  // No statusCode keeps it retryable, so a server that comes up mid-retry recovers.
  if (isConnectionError(error)) {
    const localMessage = localServerUnreachableMessage(providerName);
    if (localMessage) {
      return new LLMRequestError({ provider: providerName, message: localMessage });
    }
  }

  if (APICallError.isInstance(error)) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return new LLMAuthenticationError({
        provider: providerName,
        message: cleanMessage,
      });
    }
  }
  let httpStatus: number | undefined;

  if (error instanceof Error) {
    const e = error as Error & { status?: number; statusCode?: number };
    httpStatus = e.status || e.statusCode;
    if (!httpStatus) {
      const m = cleanMessage.match(/(\d{3})\s/);
      if (m && m[1]) httpStatus = parseInt(m[1], 10);
    }
  }

  let llmError: LLMError;
  if (httpStatus === 401 || httpStatus === 403) {
    llmError = new LLMAuthenticationError({ provider: providerName, message: cleanMessage });
  } else if (httpStatus === 429) {
    llmError = new LLMRateLimitError({ provider: providerName, message: cleanMessage });
  } else if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
    llmError = new LLMRequestError({
      provider: providerName,
      message: cleanMessage,
      statusCode: httpStatus,
    });
  } else if (httpStatus && httpStatus >= 500) {
    llmError = new LLMRequestError({
      provider: providerName,
      message: `Server error (${httpStatus}): ${cleanMessage}`,
      statusCode: httpStatus,
    });
  } else {
    if (
      cleanMessage.toLowerCase().includes("authentication") ||
      cleanMessage.toLowerCase().includes("api key")
    ) {
      // Create a more user-friendly message for API key issues
      const providerDisplayName = formatProviderDisplayName(providerName);
      const friendlyMessage = `${providerDisplayName} API key is missing or invalid.
You can set it by running: jazz config set llm.${providerName}.api_key <your-key>
Or update it in the interactive wizard: jazz wizard -> Update configuration`;

      llmError = new LLMAuthenticationError({
        provider: providerName,
        message: friendlyMessage,
      });
    } else {
      llmError = new LLMRequestError({
        provider: providerName,
        message: cleanMessage || "Unknown LLM request error",
      });
    }
  }

  return llmError;
}

/**
 * Determine whether an LLM error is transient and therefore safe to retry.
 *
 * Retryable errors include:
 * - Rate-limit responses (HTTP 429)
 * - Connection / network errors (no HTTP status — the request never reached the server)
 * - Server-side errors (HTTP 5xx)
 *
 * Non-retryable errors include:
 * - Authentication failures (HTTP 401 / 403)
 * - Client request errors (HTTP 4xx other than 429)
 */
export function isRetryableLLMError(error: unknown): boolean {
  if (error instanceof LLMRateLimitError) return true;
  if (error instanceof LLMRequestError) {
    // No status code means the request never got a response (connection / DNS / timeout).
    // 5xx means the server had a transient failure.
    // Both are worth retrying.
    return error.statusCode === undefined || error.statusCode >= 500;
  }
  return false;
}

/**
 * Short, user-facing description of why a retryable LLM error occurred
 * (rate limit / server error / network issue), for surfacing in retry notices.
 */
export function describeRetryableLLMError(error: unknown): string {
  if (error instanceof LLMRateLimitError) return "rate limit";
  if (error instanceof LLMRequestError) {
    if (error.statusCode === undefined) return "network issue";
    return `server error (${error.statusCode})`;
  }
  return "unknown issue";
}

/**
 * Exponential backoff schedule for LLM retries, delay capped at MAX_RETRY_DELAY_SECONDS.
 * Only retries on transient errors (rate limits, connection failures, 5xx).
 */
export function makeLLMRetrySchedule(maxRetries: number) {
  return Schedule.exponential("1 second").pipe(
    Schedule.modifyDelay((_, delay) =>
      Duration.min(delay, Duration.seconds(MAX_RETRY_DELAY_SECONDS)),
    ),
    Schedule.intersect(Schedule.recurs(maxRetries)),
    Schedule.whileInput((error: unknown) => isRetryableLLMError(error)),
  );
}
