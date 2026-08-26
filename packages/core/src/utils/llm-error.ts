import { APICallError, RetryError } from "ai";
import { Duration, Schedule } from "effect";
import { MAX_RETRY_DELAY_SECONDS } from "@/core/constants/agent";
import { isLocalServerProvider, LOCAL_SERVER_PROVIDERS } from "@/core/constants/local-providers";
import type { ProviderName } from "@/core/constants/models";
import {
  LLMAuthenticationError,
  LLMRateLimitError,
  LLMRequestError,
  type LLMError,
} from "@/core/types/errors";
import { formatProviderDisplayName } from "@/core/utils/provider-model";

/**
 * Keep the first request message plus the last N messages.
 * Returns undefined when no truncation is needed.
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
 * Truncate a provider request body's `messages` or `contents` array.
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
  const messageKey = Array.isArray(bodyValues["messages"])
    ? "messages"
    : Array.isArray(bodyValues["contents"])
      ? "contents"
      : undefined;
  if (messageKey === undefined) {
    return undefined;
  }

  const truncatedMessages = truncateContentsArray(
    bodyValues[messageKey] as unknown[],
    keepLastMessages,
  );

  if (!truncatedMessages) {
    return undefined;
  }

  return {
    ...bodyValues,
    [messageKey]: truncatedMessages,
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

// Detects connection failures (refused/reset/DNS/`fetch failed`), walking nested
// causes since fetch wraps the underlying OS error.
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
 * AI SDK errors raised while *building* a request, rather than in response to one.
 *
 * These carry no HTTP status because they never reached the provider, which is exactly what the
 * retry policy reads as "connection failure, try again". They are deterministic: the same inputs
 * fail the same way every time, so retrying burns the full backoff schedule — around 30 seconds
 * and eleven identical attempts — before surfacing the error the caller could have seen
 * immediately.
 *
 * The observed case: sending an audio attachment to Ollama, whose provider transports only
 * images, raises UnsupportedFunctionalityError and was retried eleven times.
 *
 * Deliberately excluded: `AI_LoadAPIKeyError`, so the friendlier API-key guidance below still
 * wins; and response-side failures (`AI_JSONParseError`, `AI_EmptyResponseBodyError`,
 * `AI_NoContentGeneratedError`), where a retry can legitimately succeed against a flaky server.
 */
const PERMANENT_REQUEST_ERROR_NAMES = new Set([
  "AI_UnsupportedFunctionalityError",
  "AI_UnsupportedModelVersionError",
  "AI_InvalidArgumentError",
  "AI_InvalidPromptError",
  "AI_InvalidDataContentError",
  "AI_InvalidMessageRoleError",
  "AI_MessageConversionError",
  "AI_TypeValidationError",
  "AI_NoSuchModelError",
  "AI_NoSuchProviderError",
  "AI_NoSuchToolError",
  "AI_InvalidToolInputError",
  "AI_TooManyEmbeddingValuesForCallError",
]);

/**
 * Whether this error was raised locally and will fail identically on every attempt.
 *
 * Walks the cause chain for the same reason `isConnectionError` does: a provider raises these
 * from deep inside the SDK, so by the time the error surfaces the interesting name is nested.
 */
export function isPermanentRequestError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { name?: unknown; cause?: unknown };
    if (typeof record.name === "string" && PERMANENT_REQUEST_ERROR_NAMES.has(record.name)) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

/** 403s about plans, upgrades, or quota are not missing-key failures. */
export function isBillingOrPlanError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("upgrade") ||
    lower.includes("extra usage") ||
    /\b(pro|max|team) plan\b/.test(lower) ||
    lower.includes("quota") ||
    lower.includes("insufficient")
  );
}

function isProviderAuthFailure(statusCode: number | undefined, message: string): boolean {
  if (statusCode === 401) return true;
  if (statusCode !== 403) return false;
  return !isBillingOrPlanError(message);
}

// Start-the-server guidance for local providers; undefined for everything else.
export function localServerUnreachableMessage(providerName: ProviderName): string | undefined {
  if (!isLocalServerProvider(providerName)) {
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

  // Checked before anything else: these carry no status code, so every branch below would
  // classify them as a transient connection failure.
  if (isPermanentRequestError(error)) {
    return new LLMRequestError({
      provider: providerName,
      message: cleanMessage || "The provider rejected this request",
      permanent: true,
    });
  }

  // No statusCode keeps this retryable, so a server that starts mid-retry recovers.
  if (isConnectionError(error)) {
    const localMessage = localServerUnreachableMessage(providerName);
    if (localMessage) {
      return new LLMRequestError({ provider: providerName, message: localMessage });
    }
  }

  if (APICallError.isInstance(error)) {
    if (isProviderAuthFailure(error.statusCode, cleanMessage)) {
      return new LLMAuthenticationError({
        provider: providerName,
        message: cleanMessage,
      });
    }
    if (error.statusCode === 403 && isBillingOrPlanError(cleanMessage)) {
      return new LLMRequestError({
        provider: providerName,
        message: cleanMessage,
        statusCode: 403,
        permanent: true,
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
  if (isProviderAuthFailure(httpStatus, cleanMessage)) {
    llmError = new LLMAuthenticationError({ provider: providerName, message: cleanMessage });
  } else if (httpStatus === 403 && isBillingOrPlanError(cleanMessage)) {
    llmError = new LLMRequestError({
      provider: providerName,
      message: cleanMessage,
      statusCode: 403,
      permanent: true,
    });
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
    // Rejected locally: the same request will be rejected the same way next time.
    if (error.permanent === true) return false;
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
    // A locally-rejected request is not a network issue, and calling it one sent users looking
    // for a connectivity problem that did not exist.
    if (error.permanent === true) return "rejected request";
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
