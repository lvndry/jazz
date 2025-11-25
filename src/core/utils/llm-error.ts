import { APICallError } from "ai";
import type { ProviderName } from "../constants/models";
import {
  LLMAuthenticationError,
  LLMRateLimitError,
  LLMRequestError,
  type LLMError,
} from "../types/errors";

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
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return new LLMAuthenticationError({
        provider: providerName,
        message: error.responseBody || error.message,
      });
    }
  }

  const errorMessage =
    error instanceof Error
      ? typeof error.message === "object"
        ? JSON.stringify(error.message)
        : error.message
      : String(error);
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
      llmError = new LLMAuthenticationError({ provider: providerName, message: errorMessage });
    } else {
      llmError = new LLMRequestError({
        provider: providerName,
        message: errorMessage || "Unknown LLM request error",
      });
    }
  }

  return llmError;
}
