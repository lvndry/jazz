import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "bun:test";
import { extractCleanErrorMessage } from "./llm-error";

describe("extractCleanErrorMessage", () => {
  it("unwraps AI SDK RetryError to the last nested error message", () => {
    const apiError = new APICallError({
      message: "Cannot connect to API: Connect Timeout Error",
      url: "https://openrouter.ai/api/v1/chat/completions",
      isRetryable: true,
    });
    const retryError = new RetryError({
      message: `Failed after 3 attempts. Last error: ${apiError.message}`,
      reason: "maxRetriesExceeded",
      errors: [apiError, apiError, apiError],
    });

    expect(extractCleanErrorMessage(retryError)).toBe(
      "Cannot connect to API: Connect Timeout Error",
    );
  });
});
