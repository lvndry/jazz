/**
 * Verifies provider-error classification, retry decisions, and safe diagnostic metadata
 * with SDK errors and synthetic failures, including resolved local-server endpoints.
 */
import { UnsupportedFunctionalityError } from "@ai-sdk/provider";
import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "bun:test";
import { apiKeyHint } from "@/core/constants/provider-env-vars";
import { LLMAuthenticationError, LLMRateLimitError, LLMRequestError } from "@/core/types/errors";
import {
  convertToLLMError,
  describeRetryableLLMError,
  extractCleanErrorMessage,
  isConnectionError,
  isPermanentRequestError,
  isRetryableLLMError,
  localServerUnreachableMessage,
  parseRetryAfterMs,
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

  it("gives a vLLM start hint at its own default port", () => {
    const message = localServerUnreachableMessage("vllm");
    expect(message).toContain("vllm serve <model> --port 8000");
    expect(message).toContain("127.0.0.1:8000");
    expect(message).toContain("llm.vllm.base_url");
  });

  it("gives an SGLang start hint at its own default port", () => {
    const message = localServerUnreachableMessage("sglang");
    expect(message).toContain("sglang.launch_server");
    expect(message).toContain("127.0.0.1:30000");
    expect(message).toContain("llm.sglang.base_url");
  });

  it("returns undefined for a cloud provider", () => {
    expect(localServerUnreachableMessage("openai")).toBeUndefined();
  });

  it("names the URL that was actually attempted, such as one saved in config", () => {
    const message = localServerUnreachableMessage("llamacpp", "http://gpu.example:8000/v1");
    expect(message).toContain("gpu.example:8000");
    expect(message).not.toContain("127.0.0.1:8080");
  });

  it("gives the start hint for any loopback server, shown without its API path", () => {
    const message = localServerUnreachableMessage("llamacpp", "http://localhost:8090/v1");
    expect(message).toContain("llama-server -m");
    expect(message).toContain("http://localhost:8090)");
    expect(message).not.toContain("/v1");
  });

  it("asks a remote server to be checked rather than started", () => {
    const message = localServerUnreachableMessage("llamacpp", "http://172.17.0.1:8090/v1");
    expect(message).toContain("at http://172.17.0.1:8090.");
    expect(message).not.toContain("llama-server -m");
  });

  it("shows the actual URL when LLAMACPP_BASE_URL is set", () => {
    const original = process.env["LLAMACPP_BASE_URL"];
    try {
      process.env["LLAMACPP_BASE_URL"] = "http://172.17.0.1:8000/v1";
      const message = localServerUnreachableMessage("llamacpp");
      expect(message).toContain("172.17.0.1:8000");
      expect(message).not.toContain("localhost:8080");
      expect(message).not.toContain("llama-server -m");
    } finally {
      if (original === undefined) delete process.env["LLAMACPP_BASE_URL"];
      else process.env["LLAMACPP_BASE_URL"] = original;
    }
  });
});

describe("convertToLLMError - local server diagnostics", () => {
  it.each(["llamacpp", "ollama", "sglang", "vllm"] as const)(
    "uses the attempted endpoint when converting a %s connection failure",
    (provider) => {
      const error = convertToLLMError(
        new Error("fetch failed"),
        provider,
        "http://gpu.example:9123/v1",
      );
      expect(error).toBeInstanceOf(LLMRequestError);
      expect(error.message).toContain("at http://gpu.example:9123.");
      expect(error.message).not.toContain("127.0.0.1");
      expect(error.message).not.toContain("start it with");
      expect(isRetryableLLMError(error)).toBe(true);
    },
  );

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

  it("does not retry a missing ChatGPT sign-in as a network failure", () => {
    const signInError = Object.assign(new Error("Not signed in to ChatGPT"), {
      name: "ChatGPTSignInRequiredError",
    });
    const converted = convertToLLMError(signInError, "chatgpt");

    expect(converted).toBeInstanceOf(LLMAuthenticationError);
    expect((converted as LLMAuthenticationError).message).toContain("jazz config");
    expect(isRetryableLLMError(converted)).toBe(false);
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

describe("convertToLLMError - out-of-credits 429 vs plain rate limit", () => {
  it("marks a 429 with error.code insufficient_quota as permanent and non-retryable", () => {
    const converted = convertToLLMError(
      new APICallError({
        message: "You have no credits remaining.",
        url: "https://api.openai.com/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 429,
        isRetryable: false,
        data: { error: { message: "You have no credits remaining.", code: "insufficient_quota" } },
      }),
      "openai",
    );
    expect(converted).toBeInstanceOf(LLMRateLimitError);
    expect((converted as LLMRateLimitError).permanent).toBe(true);
    expect(isRetryableLLMError(converted)).toBe(false);
  });

  it("keeps a plain rate_limit_exceeded 429 retryable", () => {
    const converted = convertToLLMError(
      new APICallError({
        message: "Rate limit reached, please try again later.",
        url: "https://api.openai.com/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 429,
        isRetryable: true,
        data: {
          error: {
            message: "Rate limit reached, please try again later.",
            code: "rate_limit_exceeded",
          },
        },
      }),
      "openai",
    );
    expect(converted).toBeInstanceOf(LLMRateLimitError);
    expect((converted as LLMRateLimitError).permanent).toBe(false);
    expect(isRetryableLLMError(converted)).toBe(true);
  });

  it("does not guess from message text alone when there is no structured error code", () => {
    const converted = convertToLLMError(
      new APICallError({
        message: "429 Too Many Requests: quota exceeded, please slow down",
        url: "https://generativelanguage.googleapis.com/v1/models/gemini",
        requestBodyValues: {},
        statusCode: 429,
        isRetryable: true,
      }),
      "gemini",
    );
    expect(converted).toBeInstanceOf(LLMRateLimitError);
    expect((converted as LLMRateLimitError).permanent).toBe(false);
    expect(isRetryableLLMError(converted)).toBe(true);
  });
});

describe("Retry-After", () => {
  it("reads seconds, milliseconds and HTTP dates", () => {
    expect(parseRetryAfterMs({ "retry-after": "7" })).toBe(7_000);
    expect(parseRetryAfterMs({ "retry-after-ms": "250" })).toBe(250);
    expect(parseRetryAfterMs({ "Retry-After": "2" })).toBe(2_000);
    const now = Date.parse("2026-09-27T10:00:00Z");
    expect(parseRetryAfterMs({ "retry-after": "Sun, 27 Sep 2026 10:00:30 GMT" }, now)).toBe(30_000);
  });

  it("ignores an absent or unreadable header", () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs({ "retry-after": "soon" })).toBeUndefined();
  });

  it("carries the provider's wait on a converted 429", () => {
    const converted = convertToLLMError(
      new APICallError({
        message: "Too many requests",
        url: "https://api.openai.com/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 429,
        responseHeaders: { "retry-after": "3" },
        isRetryable: true,
      }),
      "openai",
    );
    expect(converted).toBeInstanceOf(LLMRateLimitError);
    expect((converted as LLMRateLimitError).retryAfterMs).toBe(3_000);
  });
});

describe("context overflow", () => {
  function rejected(message: string, statusCode = 400, data?: unknown) {
    return convertToLLMError(
      new APICallError({
        message,
        url: "https://api.example.com/v1/messages",
        requestBodyValues: {},
        statusCode,
        isRetryable: false,
        ...(data !== undefined ? { data } : {}),
      }),
      "anthropic",
    ) as LLMRequestError;
  }

  it("recognizes providers' prompt-too-long rejections", () => {
    expect(rejected("prompt is too long: 210000 tokens > 200000 maximum").contextOverflow).toBe(
      true,
    );
    expect(rejected("This model's maximum context length is 128000 tokens.").contextOverflow).toBe(
      true,
    );
    expect(
      rejected("the request exceeds the available context size, try increasing it").contextOverflow,
    ).toBe(true);
    expect(
      rejected("bad", 400, { error: { code: "context_length_exceeded" } }).contextOverflow,
    ).toBe(true);
  });

  it("leaves other rejections alone", () => {
    expect(rejected("invalid tool schema").contextOverflow).toBeUndefined();
    expect(isRetryableLLMError(rejected("prompt is too long"))).toBe(false);
  });
});

describe("convertToLLMError - credential failures never retry", () => {
  class ChatGPTSignInRequiredError extends Error {
    constructor() {
      super("Not signed in to ChatGPT. Run `jazz config`, choose LLM providers, then ChatGPT.");
      this.name = "ChatGPTSignInRequiredError";
    }
  }

  it("reads a sign-in error with no status as an authentication failure, keeping its remedy", () => {
    const converted = convertToLLMError(new ChatGPTSignInRequiredError(), "chatgpt");
    expect(converted).toBeInstanceOf(LLMAuthenticationError);
    expect(converted.message).toContain("Run `jazz config`");
    expect(isRetryableLLMError(converted)).toBe(false);
  });

  it.each([
    "Not signed in to ChatGPT.",
    "Your access token has expired, please re-authenticate",
    "You didn't provide an API key.",
    "Unauthorized",
  ])("classifies %p without a status as a credential failure", (message) => {
    const converted = convertToLLMError(new Error(message), "openai");
    expect(converted).toBeInstanceOf(LLMAuthenticationError);
    expect(isRetryableLLMError(converted)).toBe(false);
  });

  it("reads a 400 about a bad key as a credential failure, not a bad request", () => {
    const error = Object.assign(new Error("Incorrect API key provided: sk-...abcd"), {
      status: 400,
    });
    expect(convertToLLMError(error, "openai")).toBeInstanceOf(LLMAuthenticationError);
  });

  it("restates a missing key with the way to set it exactly once", () => {
    const converted = convertToLLMError(new Error("API key is missing"), "openai");
    const hint = apiKeyHint("openai");
    expect(converted.message.split(hint)).toHaveLength(2);
  });

  it("still retries a plain connection failure", () => {
    const converted = convertToLLMError(new Error("fetch failed"), "openai");
    expect(converted).toBeInstanceOf(LLMRequestError);
    expect(isRetryableLLMError(converted)).toBe(true);
  });
});
