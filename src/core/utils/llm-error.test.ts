import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "bun:test";
import { LLMRateLimitError, LLMRequestError } from "@/core/types/errors";
import { describeRetryableLLMError, extractCleanErrorMessage } from "./llm-error";

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

describe("describeRetryableLLMError", () => {
  it("describes a rate limit error", () => {
    const error = new LLMRateLimitError({ provider: "openrouter", message: "Too many requests" });
    expect(describeRetryableLLMError(error)).toBe("rate limit");
  });

  it("describes a server error with its status code", () => {
    const error = new LLMRequestError({
      provider: "openrouter",
      message: "Service unavailable",
      statusCode: 503,
    });
    expect(describeRetryableLLMError(error)).toBe("server error (503)");
  });

  it("describes a connection failure with no status code as a network issue", () => {
    const error = new LLMRequestError({
      provider: "openrouter",
      message: "fetch failed",
    });
    expect(describeRetryableLLMError(error)).toBe("network issue");
  });

  it("falls back to a generic description for unrecognized errors", () => {
    expect(describeRetryableLLMError(new Error("boom"))).toBe("unknown issue");
  });
});
