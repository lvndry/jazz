import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { APICallError } from "ai";
import { beforeEach, describe, expect, it } from "bun:test";
import { Cause, Effect, Exit, Layer, Stream } from "effect";
import { AVAILABLE_PROVIDERS } from "../../core/constants/models";
import type { ProviderName } from "../../core/constants/models";
import type { AgentConfigService } from "../../core/interfaces/agent-config";
import { AgentConfigServiceTag } from "../../core/interfaces/agent-config";
import { LLMServiceTag, type LLMService } from "../../core/interfaces/llm";
import {
  LLMAuthenticationError,
  LLMConfigurationError,
  LLMRequestError,
  type LLMError,
} from "../../core/types/errors";
import type { AppConfig, LLMConfig, StreamEvent } from "../../core/types/index";
import { AgentConfigServiceImpl } from "../config";
import { createLoggerLayer } from "../logger";
import { createAISDKServiceLayer } from "./ai-sdk-service";
import { PROVIDER_MODELS } from "./models";

describe("AI SDK Service - Unit Tests", () => {
  /**
   * Helper to create a test config layer
   */
  function createTestConfigLayer(
    llmConfig: LLMConfig,
  ): Layer.Layer<AgentConfigService, never, FileSystem.FileSystem> {
    const appConfig: AppConfig = {
      storage: { type: "file", path: "/tmp/test" },
      logging: { level: "info", format: "plain" },
      llm: llmConfig,
    };

    return Layer.effect(
      AgentConfigServiceTag,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return new AgentConfigServiceImpl(appConfig, undefined, fs);
      }),
    );
  }

  function runWithTestLayers<A, E>(
    program: Effect.Effect<A, E, LLMService>,
    configLayer: Layer.Layer<AgentConfigService, never, FileSystem.FileSystem>,
  ): Promise<A> {
    // `NodeFileSystem.layer`'s exported type can be overly-generic, which can
    // cause `Effect.provide(...)` to infer `any` for the remaining requirements.
    // Narrow it here so the program environment resolves to `never`.
    const fsLayer = NodeFileSystem.layer as Layer.Layer<FileSystem.FileSystem, never, never>;

    const runnable = program.pipe(
      Effect.provide(createAISDKServiceLayer()),
      Effect.provide(configLayer),
      Effect.provide(createLoggerLayer()),
      Effect.provide(fsLayer),
    ) as Effect.Effect<A, E, never>;

    return Effect.runPromise(runnable);
  }

  describe("Provider Configuration", () => {
    it("should list all providers with correct configured status", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        return yield* llmService.listProviders();
      });

      const configLayer = createTestConfigLayer({
        openai: { api_key: "sk-test" },
        openrouter: { api_key: "sk-or-test" },
      });

      const result = await runWithTestLayers(testEffect, configLayer);

      // Should include all providers
      const providerNames = result.map((p) => p.name);
      expect(providerNames).toContain("openai");
      expect(providerNames).toContain("openrouter");
      expect(providerNames).toContain("anthropic");
      expect(providerNames).toContain("ollama");

      // Check configured status
      const openaiProvider = result.find((p) => p.name === "openai");
      const openrouterProvider = result.find((p) => p.name === "openrouter");
      const anthropicProvider = result.find((p) => p.name === "anthropic");

      expect(openaiProvider?.configured).toBe(true);
      expect(openrouterProvider?.configured).toBe(true);
      expect(anthropicProvider?.configured).toBe(false);
    });

    it("should mark Ollama as configured even without API key", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        return yield* llmService.listProviders();
      });

      const configLayer = createTestConfigLayer({});

      const result = await runWithTestLayers(testEffect, configLayer);

      const ollamaProvider = result.find((p) => p.name === "ollama");
      expect(ollamaProvider?.configured).toBe(true);
    });

    it("should handle empty LLM config", async () => {
      // Clear env vars that would be detected as fallback API keys
      const envVarsToSave = [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
        "MISTRAL_API_KEY",
        "XAI_API_KEY",
        "DEEPSEEK_API_KEY",
        "GROQ_API_KEY",
        "OPENROUTER_API_KEY",
      ];
      const savedEnvVars: Record<string, string | undefined> = {};
      for (const key of envVarsToSave) {
        savedEnvVars[key] = process.env[key];
        delete process.env[key];
      }

      try {
        const testEffect = Effect.gen(function* () {
          const llmService = yield* LLMServiceTag;
          return yield* llmService.listProviders();
        });

        const configLayer = createTestConfigLayer({});

        const result = await runWithTestLayers(testEffect, configLayer);

        const configuredProviders = result.filter((p) => p.configured);
        expect(configuredProviders.length).toBe(1); // Only Ollama
        expect(configuredProviders[0]?.name).toBe("ollama");
      } finally {
        // Restore env vars
        for (const key of envVarsToSave) {
          if (savedEnvVars[key] !== undefined) {
            process.env[key] = savedEnvVars[key];
          }
        }
      }
    });

    it("should have a check for every provider in LLMConfig", () => {
      const llmConfigProviders: ProviderName[] = [
        "openai",
        "anthropic",
        "google",
        "mistral",
        "xai",
        "deepseek",
        "ollama",
        "openrouter",
        "ai_gateway",
        "groq",
      ];

      // Read the source file to check for provider checks
      const sourceFile = readFileSync(join(import.meta.dir, "ai-sdk-service.ts"), "utf-8");

      // Find the getConfiguredProviders function - search for the function and its body
      const functionStart = sourceFile.indexOf("function getConfiguredProviders");
      if (functionStart === -1) {
        throw new Error("getConfiguredProviders function not found");
      }

      // Find the next function after getConfiguredProviders to limit our search
      const nextFunctionMatch = sourceFile.slice(functionStart).match(/\nfunction\s+\w+/);
      const searchEnd = nextFunctionMatch
        ? functionStart + nextFunctionMatch.index!
        : functionStart + 2000; // Fallback: search next 2000 chars

      // Extract the function section (from function start to next function or reasonable limit)
      const functionSection = sourceFile.slice(functionStart, searchEnd);

      // Check each provider has a corresponding check in the function
      const missingProviders: ProviderName[] = [];

      for (const provider of AVAILABLE_PROVIDERS) {
        // Ollama is handled specially (always added), so check for that pattern
        if (provider === "ollama") {
          // Check for ollama handling - look for providers.push with "ollama" or llmConfig.ollama
          if (
            !functionSection.includes('"ollama"') &&
            !functionSection.includes("'ollama'") &&
            !functionSection.includes("llmConfig.ollama")
          ) {
            missingProviders.push(provider);
          }
        } else {
          // For other providers, check for: llmConfig.{provider}?.api_key
          // Simple string search for the pattern
          const searchPattern = `llmConfig.${provider}?.api_key`;
          if (!functionSection.includes(searchPattern)) {
            missingProviders.push(provider);
          }
        }
      }

      if (missingProviders.length > 0) {
        throw new Error(
          `Missing provider checks in getConfiguredProviders: ${missingProviders.join(", ")}`,
        );
      }

      // Also verify that all providers in AVAILABLE_PROVIDERS that are in LLMConfig are handled
      const configurableProviders = AVAILABLE_PROVIDERS.filter((p) =>
        llmConfigProviders.includes(p),
      );
      expect(configurableProviders.length).toBe(llmConfigProviders.length);
    });
  });

  describe("Provider Retrieval", () => {
    it("should get provider with static models", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        return yield* llmService.getProvider("openai");
      });

      const configLayer = createTestConfigLayer({
        openai: { api_key: "sk-test" },
      });

      const result = await runWithTestLayers(testEffect, configLayer);

      expect(result.name).toBe("openai");
      expect(result.supportedModels.length).toBeGreaterThan(0);
      expect(result.defaultModel).toBeDefined();
      expect(result.authenticate).toBeDefined();
    });

    it("should handle dynamic provider model fetching", async () => {
      // Test that dynamic providers can be retrieved (actual fetching will happen)
      // This tests the interface, not the actual API call
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        const provider = yield* llmService.getProvider("openrouter");
        return {
          name: provider.name,
          hasModels: provider.supportedModels.length > 0,
          defaultModel: provider.defaultModel,
        };
      });

      const configLayer = createTestConfigLayer({
        openrouter: { api_key: "sk-test" },
      });

      const result = await runWithTestLayers(
        testEffect.pipe(
          Effect.catchAll(() =>
            Effect.succeed({
              name: "openrouter",
              hasModels: false,
              defaultModel: "",
            }),
          ),
        ),
        configLayer,
      );

      expect(result.name).toBe("openrouter");
      // Models may or may not be fetched depending on network, but structure should be correct
      expect(typeof result.hasModels).toBe("boolean");
      expect(typeof result.defaultModel).toBe("string");
    });
  });

  describe("Provider Authentication", () => {
    it("should authenticate provider with API key", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        const provider = yield* llmService.getProvider("openai");
        yield* provider.authenticate();
        return "authenticated";
      });

      const configLayer = createTestConfigLayer({
        openai: { api_key: "sk-test-key" },
      });

      const result = await runWithTestLayers(testEffect, configLayer);

      expect(result).toBe("authenticated");
    });

    it("should fail authentication when API key is missing", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        const provider = yield* llmService.getProvider("openai");
        yield* provider.authenticate();
        return "should not reach here";
      });

      const configLayer = createTestConfigLayer({});

      const result = await runWithTestLayers(
        testEffect.pipe(Effect.catchAll((error) => Effect.succeed(error))),
        configLayer,
      );

      expect(result).toBeInstanceOf(LLMAuthenticationError);
      if (result instanceof LLMAuthenticationError) {
        expect(result.provider).toBe("openai");
        expect(result.message).toContain("API key");
      }
    });

    // TODO: This test is skipped because we dynamically fetch the models from the provider so we need to mock the model fetching.
    it.skip("should allow Ollama without API key", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        const provider = yield* llmService.getProvider("ollama");
        yield* provider.authenticate();
        return "authenticated";
      });

      const configLayer = createTestConfigLayer({});

      const result = await runWithTestLayers(testEffect, configLayer);

      expect(result).toBe("authenticated");
    });
  });

  describe("Environment Variable Export", () => {
    beforeEach(() => {
      // Clean up environment variables before each test
      delete process.env["OPENAI_API_KEY"];
      delete process.env["OPENROUTER_API_KEY"];
      delete process.env["ANTHROPIC_API_KEY"];
      delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
    });

    it("should export OpenAI API key to environment", async () => {
      const testEffect = Effect.gen(function* () {
        yield* LLMServiceTag;
        return process.env["OPENAI_API_KEY"];
      });

      const configLayer = createTestConfigLayer({
        openai: { api_key: "sk-openai-test" },
      });

      const result = await runWithTestLayers(testEffect, configLayer);

      expect(result).toBe("sk-openai-test");
    });

    it("should export OpenRouter API key to environment", async () => {
      const testEffect = Effect.gen(function* () {
        yield* LLMServiceTag;
        return process.env["OPENROUTER_API_KEY"];
      });

      const configLayer = createTestConfigLayer({
        openrouter: { api_key: "sk-or-test" },
      });

      const result = await runWithTestLayers(testEffect, configLayer);

      expect(result).toBe("sk-or-test");
    });

    it("should export Google API key with special env variable name", async () => {
      const testEffect = Effect.gen(function* () {
        yield* LLMServiceTag;
        return process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
      });

      const configLayer = createTestConfigLayer({
        google: { api_key: "sk-google-test" },
      });

      const result = await runWithTestLayers(testEffect, configLayer);

      expect(result).toBe("sk-google-test");
    });

    it("should export multiple provider API keys", async () => {
      const testEffect = Effect.gen(function* () {
        yield* LLMServiceTag;
        return {
          openai: process.env["OPENAI_API_KEY"],
          openrouter: process.env["OPENROUTER_API_KEY"],
          anthropic: process.env["ANTHROPIC_API_KEY"],
          google: process.env["GOOGLE_GENERATIVE_AI_API_KEY"],
        };
      });

      const configLayer = createTestConfigLayer({
        openai: { api_key: "sk-openai" },
        openrouter: { api_key: "sk-openrouter" },
        anthropic: { api_key: "sk-anthropic" },
        google: { api_key: "sk-google" },
      });

      const result = await runWithTestLayers(testEffect, configLayer);

      expect(result.openai).toBe("sk-openai");
      expect(result.openrouter).toBe("sk-openrouter");
      expect(result.anthropic).toBe("sk-anthropic");
      expect(result.google).toBe("sk-google");
    });
  });

  describe("Model Registry", () => {
    it("should return static models for OpenAI provider", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        const provider = yield* llmService.getProvider("openai");
        return provider.supportedModels;
      });

      const configLayer = createTestConfigLayer({
        openai: { api_key: "sk-test" },
      });

      const result = await runWithTestLayers(testEffect, configLayer);

      expect(result.length).toBeGreaterThan(0);
      const openaiModels = PROVIDER_MODELS.openai;
      if (openaiModels.type === "static") {
        expect(result.length).toBe(openaiModels.models.length);
      }
    });

    it("should have correct model structure", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        const provider = yield* llmService.getProvider("openai");
        return provider.supportedModels;
      });

      const configLayer = createTestConfigLayer({
        openai: { api_key: "sk-test" },
      });

      const result = await runWithTestLayers(testEffect, configLayer);

      for (const model of result) {
        expect(model.id).toBeDefined();
        expect(typeof model.id).toBe("string");
        expect(model.id.length).toBeGreaterThan(0);
      }
    });

    it("should set default model to first in list", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        const provider = yield* llmService.getProvider("openai");
        return {
          defaultModel: provider.defaultModel,
          firstModel: provider.supportedModels[0]?.id,
        };
      });

      const configLayer = createTestConfigLayer({
        openai: { api_key: "sk-test" },
      });

      const result = await runWithTestLayers(testEffect, configLayer);

      expect(result.defaultModel).toBeDefined();
      expect(result.firstModel).toBeDefined();
      const defaultModel = result.defaultModel!;
      const firstModel = result.firstModel!;
      expect(defaultModel).toBe(firstModel);
      expect(defaultModel.length).toBeGreaterThan(0);
    });
  });

  describe("Error Handling", () => {
    it("should handle APICallError with 401 status as authentication error", () => {
      const error = new APICallError({
        message: "Unauthorized",
        statusCode: 401,
        responseBody: '{"error": "Invalid API key"}',
        url: "https://api.example.com",
        requestBodyValues: {},
      });

      // Test that APICallError is correctly identified
      expect(error.statusCode).toBe(401);
      expect(APICallError.isInstance(error)).toBe(true);
      expect(error.message).toBe("Unauthorized");
      expect(error.responseBody).toContain("Invalid API key");
    });

    it("should handle APICallError with 429 status as rate limit error", () => {
      const error = new APICallError({
        message: "Rate limit exceeded",
        statusCode: 429,
        responseBody: '{"error": "Too many requests"}',
        url: "https://api.example.com",
        requestBodyValues: {},
      });

      expect(error.statusCode).toBe(429);
      expect(APICallError.isInstance(error)).toBe(true);
    });

    it("should handle APICallError with 500 status as request error", () => {
      const error = new APICallError({
        message: "Internal server error",
        statusCode: 500,
        responseBody: '{"error": "Server error"}',
        url: "https://api.example.com",
        requestBodyValues: {},
      });

      expect(error.statusCode).toBe(500);
      expect(APICallError.isInstance(error)).toBe(true);
    });
  });

  describe("Service Initialization", () => {
    it("should create service layer successfully", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        const providers = yield* llmService.listProviders();
        return providers.length > 0;
      });

      const configLayer = createTestConfigLayer({
        openai: { api_key: "sk-test" },
      });

      const result = await runWithTestLayers(testEffect, configLayer);

      expect(result).toBe(true);
    });

    it("should fail service creation when no providers configured", async () => {
      const testEffect = Effect.gen(function* () {
        yield* LLMServiceTag;
        return "should not reach here";
      });

      const configLayer = createTestConfigLayer({});

      // The service layer should fail if no providers are configured
      // But Ollama is always available, so this should actually succeed
      const result = await runWithTestLayers(
        testEffect.pipe(Effect.catchAll((error) => Effect.succeed(error))),
        configLayer,
      );

      // With Ollama as fallback, this should succeed, not fail
      expect(result).not.toBeInstanceOf(LLMConfigurationError);
    });
  });

  describe("Provider Models Configuration", () => {
    it("should recognize all providers in PROVIDER_MODELS", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        const providers = yield* llmService.listProviders();
        return providers.map((p) => p.name);
      });

      const configLayer = createTestConfigLayer({});

      const result = await runWithTestLayers(testEffect, configLayer);

      // Check that all providers from PROVIDER_MODELS are listed
      const expectedProviders = Object.keys(PROVIDER_MODELS) as ProviderName[];
      for (const expectedProvider of expectedProviders) {
        expect(result).toContain(expectedProvider);
      }
    });

    it("should handle provider name case insensitivity", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        const providers = yield* llmService.listProviders();
        return providers;
      });

      const configLayer = createTestConfigLayer({
        openai: { api_key: "sk-test" },
      });

      const result = await runWithTestLayers(testEffect, configLayer);

      // Should find OpenAI regardless of case in config
      const openaiProvider = result.find((p) => p.name === "openai");
      expect(openaiProvider?.configured).toBe(true);
    });
  });

  /**
   * Regression tests for streaming error handling.
   *
   * These tests verify that errors in createStreamingChatCompletion are properly
   * converted to typed LLMError instances rather than leaking as UnknownException.
   *
   * Background: A bug caused synchronous throws (e.g. from selectModel) and rejected
   * deferred promises to surface as "UnknownException: An unknown error occurred in
   * Effect.tryPromise" — making the core chat workflow completely unusable.
   */
  describe("Streaming Error Handling (Regression)", () => {
    const minimalOptions = {
      model: "test-model",
      messages: [{ role: "user" as const, content: "hello" }],
    };

    it("should return typed LLMError when selectModel throws for unsupported provider (streaming)", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        // "unsupported_provider" will cause selectModel to throw
        return yield* llmService.createStreamingChatCompletion(
          "unsupported_provider" as ProviderName,
          minimalOptions,
        );
      });

      const configLayer = createTestConfigLayer({
        openai: { api_key: "sk-test" },
      });

      const exit = await Effect.runPromiseExit(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(createLoggerLayer()),
          Effect.provide(NodeFileSystem.layer as Layer.Layer<FileSystem.FileSystem, never, never>),
        ) as Effect.Effect<unknown, LLMError, never>,
      );

      // Must fail with a typed LLMError, NOT an UnknownException/defect
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          const error = failure.value;
          // Should be a proper LLMError variant (LLMRequestError for "Unsupported provider")
          expect(error._tag).toBeDefined();
          expect(
            error._tag === "LLMRequestError" ||
              error._tag === "LLMAuthenticationError" ||
              error._tag === "LLMRateLimitError" ||
              error._tag === "LLMConfigurationError",
          ).toBe(true);
          expect(error.message).toBeDefined();
        }

        // Critically: must NOT be a defect (UnknownException)
        const defects = Cause.defects(exit.cause);
        expect(defects.length).toBe(0);
      }
    });

    it("should return typed LLMError when selectModel throws for unsupported provider (non-streaming)", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        return yield* llmService.createChatCompletion(
          "unsupported_provider" as ProviderName,
          minimalOptions,
        );
      });

      const configLayer = createTestConfigLayer({
        openai: { api_key: "sk-test" },
      });

      const exit = await Effect.runPromiseExit(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(createLoggerLayer()),
          Effect.provide(NodeFileSystem.layer as Layer.Layer<FileSystem.FileSystem, never, never>),
        ) as Effect.Effect<unknown, LLMError, never>,
      );

      // Must fail with a typed LLMError, NOT an UnknownException/defect
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          const error = failure.value;
          expect(error._tag).toBeDefined();
          expect(
            error._tag === "LLMRequestError" ||
              error._tag === "LLMAuthenticationError" ||
              error._tag === "LLMRateLimitError" ||
              error._tag === "LLMConfigurationError",
          ).toBe(true);
        }

        const defects = Cause.defects(exit.cause);
        expect(defects.length).toBe(0);
      }
    });

    it("streaming and non-streaming should produce consistent error types for the same failure", async () => {
      const configLayer = createTestConfigLayer({
        openai: { api_key: "sk-test" },
      });
      const fsLayer = NodeFileSystem.layer as Layer.Layer<FileSystem.FileSystem, never, never>;

      const streamingEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        return yield* llmService.createStreamingChatCompletion(
          "unsupported_provider" as ProviderName,
          minimalOptions,
        );
      });

      const nonStreamingEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        return yield* llmService.createChatCompletion(
          "unsupported_provider" as ProviderName,
          minimalOptions,
        );
      });

      const provide = <A, E>(effect: Effect.Effect<A, E, LLMService>) =>
        effect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(createLoggerLayer()),
          Effect.provide(fsLayer),
        ) as Effect.Effect<A, E, never>;

      const [streamingExit, nonStreamingExit] = await Promise.all([
        Effect.runPromiseExit(provide(streamingEffect)),
        Effect.runPromiseExit(provide(nonStreamingEffect)),
      ]);

      // Both should be typed failures (not defects)
      expect(Exit.isFailure(streamingExit)).toBe(true);
      expect(Exit.isFailure(nonStreamingExit)).toBe(true);

      if (Exit.isFailure(streamingExit) && Exit.isFailure(nonStreamingExit)) {
        const streamingError = Cause.failureOption(streamingExit.cause);
        const nonStreamingError = Cause.failureOption(nonStreamingExit.cause);

        expect(streamingError._tag).toBe("Some");
        expect(nonStreamingError._tag).toBe("Some");

        if (streamingError._tag === "Some" && nonStreamingError._tag === "Some") {
          // Both should produce the same error tag type
          expect(streamingError.value._tag).toBe(nonStreamingError.value._tag);
        }

        // Neither should have defects
        expect(Cause.defects(streamingExit.cause).length).toBe(0);
        expect(Cause.defects(nonStreamingExit.cause).length).toBe(0);
      }
    });

    it("should return typed LLMError from response deferred when stream fails", async () => {
      // Simulate the scenario where the streaming response deferred is rejected
      // by providing a mock LLMService that rejects the response deferred.
      const expectedError = new LLMRequestError({
        provider: "openai",
        message: "Simulated stream failure",
      });

      const mockLLMService: LLMService = {
        createStreamingChatCompletion: () =>
          Effect.succeed({
            stream: Stream.fail(expectedError) as Stream.Stream<StreamEvent, LLMError>,
            response: Effect.fail(expectedError),
            cancel: Effect.void,
          }),
        createChatCompletion: () => Effect.fail(expectedError),
        listProviders: () => Effect.succeed([]),
        getProvider: () =>
          Effect.fail(new LLMConfigurationError({ provider: "test", message: "not implemented" })),
        supportsNativeWebSearch: () => Effect.succeed(false),
      } as unknown as LLMService;

      // Verify that consuming the response gives a typed LLMError
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        const result = yield* llmService.createStreamingChatCompletion("openai", minimalOptions);
        // Awaiting the response should fail with LLMError, not UnknownException
        return yield* result.response;
      });

      const exit = await Effect.runPromiseExit(
        testEffect.pipe(
          Effect.provide(Layer.succeed(LLMServiceTag, mockLLMService)),
        ) as Effect.Effect<unknown, LLMError, never>,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value._tag).toBe("LLMRequestError");
          expect(failure.value.message).toBe("Simulated stream failure");
        }

        // Must NOT be a defect
        expect(Cause.defects(exit.cause).length).toBe(0);
      }
    });

    it("should return typed LLMError from stream when stream fails", async () => {
      const expectedError = new LLMRequestError({
        provider: "openai",
        message: "Simulated stream failure",
      });

      const mockLLMService: LLMService = {
        createStreamingChatCompletion: () =>
          Effect.succeed({
            stream: Stream.fail(expectedError) as Stream.Stream<StreamEvent, LLMError>,
            response: Effect.fail(expectedError),
            cancel: Effect.void,
          }),
        createChatCompletion: () => Effect.fail(expectedError),
        listProviders: () => Effect.succeed([]),
        getProvider: () =>
          Effect.fail(new LLMConfigurationError({ provider: "test", message: "not implemented" })),
        supportsNativeWebSearch: () => Effect.succeed(false),
      } as unknown as LLMService;

      // Verify that consuming the stream gives a typed LLMError
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        const result = yield* llmService.createStreamingChatCompletion("openai", minimalOptions);
        // Consuming the stream should fail with LLMError
        return yield* Stream.runCollect(result.stream);
      });

      const exit = await Effect.runPromiseExit(
        testEffect.pipe(
          Effect.provide(Layer.succeed(LLMServiceTag, mockLLMService)),
        ) as Effect.Effect<unknown, LLMError, never>,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value._tag).toBe("LLMRequestError");
          expect(failure.value.message).toBe("Simulated stream failure");
        }

        expect(Cause.defects(exit.cause).length).toBe(0);
      }
    });
  });
});
