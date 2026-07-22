import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "bun:test";
import { LLMRateLimitError, LLMRequestError } from "@/core/types/errors";
import {
  convertToLLMError,
  describeRetryableLLMError,
  extractCleanErrorMessage,
  isConnectionError,
  isRetryableLLMError,
  localServerUnreachableMessage,
} from "./llm-error";

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

describe("isConnectionError", () => {
  it("detects a bare fetch-failed error", () => {
    expect(isConnectionError(new Error("fetch failed"))).toBe(true);
  });

  it("detects an ECONNREFUSED code on the error", () => {
    expect(isConnectionError(Object.assign(new Error("connect"), { code: "ECONNREFUSED" }))).toBe(
      true,
    );
  });

  it("walks the cause chain that fetch wraps around the OS error", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), {
      code: "ECONNREFUSED",
    });
    expect(isConnectionError(new Error("fetch failed", { cause }))).toBe(true);
  });

  it("does not flag an ordinary 4xx error", () => {
    expect(isConnectionError(new Error("400 Bad Request"))).toBe(false);
  });
});

describe("localServerUnreachableMessage", () => {
  it("gives a llama-server start hint for llamacpp", () => {
    const message = localServerUnreachableMessage("llamacpp");
    expect(message).toContain("llama.cpp");
    expect(message).toContain("llama-server");
  });

  it("returns undefined for a cloud provider", () => {
    expect(localServerUnreachableMessage("openai")).toBeUndefined();
  });
});

describe("convertToLLMError - local server diagnostics", () => {
  it("turns a connection failure against llamacpp into an actionable, retryable error", () => {
    const error = convertToLLMError(new Error("fetch failed"), "llamacpp");
    expect(error).toBeInstanceOf(LLMRequestError);
    expect(error.message).toContain("llama-server");
    expect(isRetryableLLMError(error)).toBe(true);
  });

  it("leaves connection failures against cloud providers unchanged", () => {
    const error = convertToLLMError(new Error("fetch failed"), "openai");
    expect(error.message).not.toContain("llama-server");
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
