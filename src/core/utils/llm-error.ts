import { APICallError } from "ai";
import type { ProviderName } from "@/core/constants/models";
import {
  LLMAuthenticationError,
  LLMRateLimitError,
  LLMRequestError,
  type LLMError,
} from "@/core/types/errors";

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
    _originalMessageCount: messagesArray.length,
  };
}

/**
 * Truncate requestBodyValues in an object in-place.
 * This prevents verbose error messages when API calls fail with large conversation histories.
 */
function truncateRequestBodyValuesInObject(
  obj: Record<string, unknown>,
  keepLastMessages: number = 5,
): void {
  // Check for direct requestBodyValues
  const requestBodyValues = obj["requestBodyValues"];
  if (requestBodyValues && typeof requestBodyValues === "object") {
    const bodyValues = requestBodyValues as Record<string, unknown>;
    const contents = bodyValues["contents"];
    if (Array.isArray(contents)) {
      const contentsArray = contents as unknown[];
      const truncatedContents = truncateContentsArray(contentsArray, keepLastMessages);
      if (truncatedContents) {
        obj["requestBodyValues"] = {
          ...bodyValues,
          contents: truncatedContents,
          _truncated: true,
          _originalMessageCount: contentsArray.length,
        };
      }
    }
  }

  // Check nested errors array (e.g., AI_RetryError)
  if (Array.isArray(obj["errors"])) {
    const errors = obj["errors"] as Array<unknown>;
    for (const nestedError of errors) {
      if (nestedError && typeof nestedError === "object") {
        truncateRequestBodyValuesInObject(nestedError as Record<string, unknown>, keepLastMessages);
      }
    }
  }
}

/**
 * Extract all properties from an error object into a plain object.
 * This allows us to JSON.stringify the error with all its properties.
 */
function extractErrorProperties(error: Error): Record<string, unknown> {
  const props: Record<string, unknown> = {};

  // Get all property names (including non-enumerable ones)
  const allKeys = new Set<string>();

  // Get enumerable properties
  Object.keys(error).forEach((key) => allKeys.add(key));

  // Get non-enumerable properties (like statusCode, responseBody, etc.)
  let current = error;
  while (current && current !== Object.prototype) {
    Object.getOwnPropertyNames(current).forEach((key) => {
      if (key !== "constructor") allKeys.add(key);
    });
    current = Object.getPrototypeOf(current) as Error;
  }

  // Extract all properties, handling special cases
  for (const key of allKeys) {
    try {
      const value = (error as unknown as Record<string, unknown>)[key];

      // Skip functions and undefined values
      if (typeof value === "function" || value === undefined) continue;

      // Handle special cases
      if (key === "cause" && value instanceof Error) {
        props[key] = value.message;
      } else if (key === "stack" && typeof value === "string") {
        // Truncate stack trace to avoid overly long messages
        const stackLines = value.split("\n").slice(0, 5).join("\n");
        if (stackLines.length < 500) {
          props[key] = stackLines;
        }
      } else {
        props[key] = value;
      }
    } catch {
      // Ignore errors accessing properties
    }
  }

  // Truncate requestBodyValues before returning
  truncateRequestBodyValuesInObject(props, 5);

  return props;
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
 * Extract a meaningful error message from an unknown error.
 * Handles Error objects, plain objects, and primitive values.
 * For API errors, captures all relevant debugging fields (status, trace, responseBody, etc.).
 */
function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // Extract all properties from the error object
    const errorProps = extractErrorProperties(error);

    // Start with the message
    const parts: string[] = [error.message];

    // Stringify all other properties (excluding message to avoid duplication)
    const otherProps = { ...errorProps };
    delete otherProps["message"];

    if (Object.keys(otherProps).length > 0) {
      try {
        const propsStr = JSON.stringify(otherProps);
        if (propsStr && propsStr !== "{}") {
          parts.push(propsStr);
        }
      } catch {
        const propStrings: string[] = [];
        for (const [key, value] of Object.entries(otherProps)) {
          try {
            const valueStr = JSON.stringify(value);
            if (valueStr && valueStr !== "{}") {
              propStrings.push(`${key}: ${valueStr}`);
            }
          } catch {
            propStrings.push(`${key}: [non-serializable]`);
          }
        }
        if (propStrings.length > 0) {
          parts.push(propStrings.join(" | "));
        }
      }
    }

    return parts.join(" | ");
  }

  if (error && typeof error === "object") {
    // For plain objects, truncate requestBodyValues before stringifying
    const errorObj = { ...(error as Record<string, unknown>) };
    truncateRequestBodyValuesInObject(errorObj, 5);

    // For plain objects, try to stringify them
    try {
      const stringified = JSON.stringify(errorObj, null, 2);
      // If stringify returns just "{}", provide a descriptive fallback
      if (stringified !== "{}") {
        return stringified;
      }
      // Try to extract meaningful properties from the object
      const obj = error as Record<string, unknown>;

      // Get all property names (including non-enumerable ones)
      const allKeys = new Set<string>();
      Object.keys(obj).forEach((key) => allKeys.add(key));

      // Also try to get non-enumerable properties
      let current = obj;
      while (current && current !== Object.prototype) {
        Object.getOwnPropertyNames(current).forEach((key) => {
          if (key !== "constructor") allKeys.add(key);
        });
        current = Object.getPrototypeOf(current) as Record<string, unknown>;
      }

      if (allKeys.size > 0) {
        const props = Array.from(allKeys)
          .map((key) => {
            try {
              const value = (obj as unknown as Record<string, unknown>)[key];
              let valueStr: string;
              if (value === null) {
                valueStr = "null";
              } else if (value === undefined) {
                valueStr = "undefined";
              } else if (typeof value === "string") {
                valueStr = value;
              } else if (typeof value === "object") {
                try {
                  valueStr = JSON.stringify(value);
                } catch {
                  valueStr = "[non-serializable object]";
                }
              } else if (
                typeof value === "number" ||
                typeof value === "boolean" ||
                typeof value === "bigint" ||
                typeof value === "symbol" ||
                typeof value === "function"
              ) {
                valueStr = String(value);
              } else {
                // Fallback for any other type
                valueStr = "[unknown type]";
              }
              return `${key}: ${valueStr}`;
            } catch {
              return `${key}: [unable to access]`;
            }
          })
          .join(", ");
        return `{ ${props} }`;
      }

      // If we still can't extract properties, provide type information
      const constructorName = obj.constructor?.name || "Object";
      return `[${constructorName} instance with no accessible properties]`;
    } catch {
      // Handle circular references or other stringify errors
      // Provide a descriptive message instead of String(error)
      return "[object with circular reference or non-serializable data]";
    }
  }

  // For primitives, use String conversion
  return String(error);
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
 * @example
 * ```ts
 * try {
 *   await llmCall();
 * } catch (error) {
 *   const llmError = convertToLLMError(error, "openai");
 *   // Handle llmError appropriately
 * }
 * ```
 */
export function convertToLLMError(error: unknown, providerName: ProviderName): LLMError {
  // Extract error message with all API fields for debugging
  const errorMessage = extractErrorMessage(error);

  if (APICallError.isInstance(error)) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return new LLMAuthenticationError({
        provider: providerName,
        message: errorMessage,
      });
    }
  }
  let httpStatus: number | undefined;

  if (error instanceof Error) {
    const e = error as Error & { status?: number; statusCode?: number };
    httpStatus = e.status || e.statusCode;
    if (!httpStatus) {
      const m = errorMessage.match(/(\d{3})\s/);
      if (m && m[1]) httpStatus = parseInt(m[1], 10);
    }
  }

  let llmError: LLMError;
  if (httpStatus === 401 || httpStatus === 403) {
    llmError = new LLMAuthenticationError({ provider: providerName, message: errorMessage });
  } else if (httpStatus === 429) {
    llmError = new LLMRateLimitError({ provider: providerName, message: errorMessage });
  } else if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
    llmError = new LLMRequestError({ provider: providerName, message: errorMessage });
  } else if (httpStatus && httpStatus >= 500) {
    llmError = new LLMRequestError({
      provider: providerName,
      message: `Server error (${httpStatus}): ${errorMessage}`,
    });
  } else {
    if (
      errorMessage.toLowerCase().includes("authentication") ||
      errorMessage.toLowerCase().includes("api key")
    ) {
      // Create a more user-friendly message for API key issues
      const providerDisplayName = providerName.charAt(0).toUpperCase() + providerName.slice(1);
      const friendlyMessage = `${providerDisplayName} API key is missing or invalid.
You can set it by running: jazz config set llm.${providerName}.api_key <your-key>
Or update it in the interactive wizard: jazz wizard -> Update configuration`;

      llmError = new LLMAuthenticationError({
        provider: providerName,
        message: friendlyMessage
      });
    } else {
      llmError = new LLMRequestError({
        provider: providerName,
        message: errorMessage || "Unknown LLM request error",
      });
    }
  }

  return llmError;
}
