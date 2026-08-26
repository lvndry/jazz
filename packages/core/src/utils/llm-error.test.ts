import { UnsupportedFunctionalityError } from "@ai-sdk/provider";
import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "bun:test";
import { LLMRateLimitError, LLMRequestError } from "@/core/types/errors";
import {
  convertToLLMError,
  describeRetryableLLMError,
  extractCleanErrorMessage,
  isConnectionError,
  isPermanentRequestError,
  isRetryableLLMError,
  localServerUnreachableMessage,
  truncateRequestBodyValues,
} from "./llm-error";

describe("truncateRequestBodyValues", () => {
  const entries = ["system", "one", "two", "three"];

  it("preserves and truncates a messages field", () => {
    expect(truncateRequestBodyValues({ requestBodyValues: { messages: entries } }, 2)).toEqual({
      messages: ["system", "two", "three"],
      _truncated: true,
    });
  });

  it("preserves and truncates a contents field", () => {
    expect(truncateRequestBodyValues({ requestBodyValues: { contents: entries } }, 2)).toEqual({
      contents: ["system", "two", "three"],
      _truncated: true,
    });
  });
});

describe("extractCleanErrorMessage", () => {
  it("unwraps AI SDK RetryError to the last nested error message", () => {
    const apiError = new APICallError({
      message: "Cannot connect to API: Connect Timeout Error",
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBodyValues: {},
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

describe("locally-rejected requests are not retried", () => {
  /**
   * The real shape: an audio attachment sent to Ollama, whose provider transports only images.
   * Constructed with the SDK's own error class rather than a hand-written stub, so the test
   * still holds if the SDK renames or restructures it.
   */
  function unsupportedMediaError(): UnsupportedFunctionalityError {
    return new UnsupportedFunctionalityError({
      functionality: "file part media type audio/ogg",
    });
  }

  it("recognizes a request the SDK rejected before sending it", () => {
    expect(isPermanentRequestError(unsupportedMediaError())).toBe(true);
  });

  it("finds the cause even when it is wrapped", () => {
    // Providers raise these from deep inside the SDK, so the interesting name is usually nested.
    const wrapped = new Error("Failed to generate text", { cause: unsupportedMediaError() });
    expect(isPermanentRequestError(wrapped)).toBe(true);
  });

  it("does not flag an ordinary connection failure", () => {
    expect(isPermanentRequestError(new Error("fetch failed"))).toBe(false);
  });

  it("survives a cyclic cause chain", () => {
    const first = new Error("first") as Error & { cause?: unknown };
    const second = new Error("second", { cause: first }) as Error & { cause?: unknown };
    first.cause = second;
    expect(isPermanentRequestError(first)).toBe(false);
  });

  it("marks the converted error permanent", () => {
    const converted = convertToLLMError(unsupportedMediaError(), "ollama");
    expect(converted).toBeInstanceOf(LLMRequestError);
    expect((converted as LLMRequestError).permanent).toBe(true);
  });

  it("does not retry it", () => {
    // The bug: with no statusCode this was indistinguishable from a dropped connection, so it
    // burned the whole backoff schedule — eleven identical attempts — before surfacing.
    expect(isRetryableLLMError(convertToLLMError(unsupportedMediaError(), "ollama"))).toBe(false);
  });

  it("does not call it a network issue", () => {
    // Describing a local rejection as a network problem sent users hunting for a connectivity
    // fault that did not exist.
    const converted = convertToLLMError(unsupportedMediaError(), "ollama");
    expect(describeRetryableLLMError(converted)).toBe("rejected request");
  });

  it("still retries a genuine connection failure with no status code", () => {
    // The guard must not narrow the transient case it was carved out of.
    const transient = new LLMRequestError({ provider: "ollama", message: "fetch failed" });
    expect(isRetryableLLMError(transient)).toBe(true);
  });

  it("leaves the API-key path alone", () => {
    // AI_LoadAPIKeyError is excluded on purpose so the friendlier key guidance still wins.
    const converted = convertToLLMError(new Error("Missing API key"), "openai");
    expect((converted as LLMRequestError).permanent).toBeUndefined();
  });
});

describe("convertToLLMError - Ollama Cloud plan rejection", () => {
  const planMessage =
    "this model requires both a Pro, Max, or Team plan and extra usage (it does not use included plan usage), upgrade for access";

  it("does not call a plan/upgrade 403 an authentication failure", () => {
    const converted = convertToLLMError(
      new APICallError({
        message: planMessage,
        url: "https://ollama.com/api/chat",
        requestBodyValues: {},
        statusCode: 403,
        isRetryable: false,
      }),
      "ollama",
    );
    expect(converted).toBeInstanceOf(LLMRequestError);
    expect((converted as LLMRequestError).permanent).toBe(true);
    expect(converted.message).toContain("upgrade");
  });

  it("still treats a 401 as authentication", () => {
    const converted = convertToLLMError(
      new APICallError({
        message: "Unauthorized",
        url: "https://ollama.com/api/chat",
        requestBodyValues: {},
        statusCode: 401,
        isRetryable: false,
      }),
      "ollama",
    );
    expect(converted._tag).toBe("LLMAuthenticationError");
  });
});
