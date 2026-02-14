import { APICallError } from "ai";
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
    const obj = error as Record<string, unknown>;
    // Try to find a message property
    if (typeof obj["message"] === "string") {
      let message = obj["message"];
      // Clean the message
      if (message.includes(" | ")) {
        message = message.split(" | ")[0] || message;
      }
      return message;
    }
    // Try to find an error.message nested structure
    if (obj["error"] && typeof obj["error"] === "object") {
      const errorObj = obj["error"] as Record<string, unknown>;
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
    llmError = new LLMRequestError({ provider: providerName, message: cleanMessage });
  } else if (httpStatus && httpStatus >= 500) {
    llmError = new LLMRequestError({
      provider: providerName,
      message: `Server error (${httpStatus}): ${cleanMessage}`,
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
