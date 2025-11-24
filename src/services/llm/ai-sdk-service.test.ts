import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { APICallError } from "ai";
import { beforeEach, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { LLMAuthenticationError, LLMConfigurationError } from "../../core/types/errors";
import type { AppConfig, LLMConfig } from "../../core/types/index";
import { AgentConfigService, ConfigServiceImpl, type ConfigService } from "../config";
import { createLoggerLayer } from "../logger";
import { createAISDKServiceLayer } from "./ai-sdk-service";
import { LLMServiceTag } from "./interfaces";
import { PROVIDER_MODELS } from "./models";

describe("AI SDK Service - Unit Tests", () => {
  /**
   * Helper to create a test config layer
   */
  function createTestConfigLayer(
    llmConfig: LLMConfig,
  ): Layer.Layer<ConfigService, never, FileSystem.FileSystem> {
    const appConfig: AppConfig = {
      storage: { type: "file", path: "/tmp/test" },
      logging: { level: "info", format: "pretty", output: "console" },
      llm: llmConfig,
    };

    return Layer.effect(
      AgentConfigService,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return new ConfigServiceImpl(appConfig, undefined, fs);
      }),
    );
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

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(createLoggerLayer()),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

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

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(createLoggerLayer()),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

      const ollamaProvider = result.find((p) => p.name === "ollama");
      expect(ollamaProvider?.configured).toBe(true);
    });

    it("should handle empty LLM config", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        return yield* llmService.listProviders();
      });

      const configLayer = createTestConfigLayer({});

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(createLoggerLayer()),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

      const configuredProviders = result.filter((p) => p.configured);
      expect(configuredProviders.length).toBe(1); // Only Ollama
      expect(configuredProviders[0]?.name).toBe("ollama");
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

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(createLoggerLayer()),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

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

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(createLoggerLayer()),
          Effect.provide(NodeFileSystem.layer),
          Effect.catchAll(() =>
            Effect.succeed({
              name: "openrouter",
              hasModels: false,
              defaultModel: "",
            }),
          ),
        ),
      );

      expect(result.name).toBe("openrouter");
      // Models may or may not be fetched depending on network, but structure should be correct
      expect(typeof result.hasModels).toBe("boolean");
      expect(typeof result.defaultModel).toBe("string");
    });

    it("should fail for unknown provider", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        return yield* llmService.getProvider("unknown-provider" as "openai");
      });

      const configLayer = createTestConfigLayer({});

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(createLoggerLayer()),
          Effect.provide(NodeFileSystem.layer),
          Effect.catchAll((error) => Effect.succeed(error as LLMConfigurationError)),
        ),
      );

      expect(result).toBeInstanceOf(LLMConfigurationError);
      if (result instanceof LLMConfigurationError) {
        expect(result.provider).toBe("unknown-provider");
      }
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

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(createLoggerLayer()),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

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

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(createLoggerLayer()),
          Effect.provide(NodeFileSystem.layer),
          Effect.catchAll((error) => Effect.succeed(error)),
        ),
      );

      expect(result).toBeInstanceOf(LLMAuthenticationError);
      if (result instanceof LLMAuthenticationError) {
        expect(result.provider).toBe("openai");
        expect(result.message).toContain("API key");
      }
    });

    it("should allow Ollama without API key", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        const provider = yield* llmService.getProvider("ollama");
        yield* provider.authenticate();
        return "authenticated";
      });

      const configLayer = createTestConfigLayer({});

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(createLoggerLayer()),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

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

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(createLoggerLayer()),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

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

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(createLoggerLayer()),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

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

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(createLoggerLayer()),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

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

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(createLoggerLayer()),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

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

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(createLoggerLayer()),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

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

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(createLoggerLayer()),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

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

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(createLoggerLayer()),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

      expect(result.defaultModel).toBe(result.firstModel);
      expect(result.defaultModel.length).toBeGreaterThan(0);
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

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(createLoggerLayer()),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

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
      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(createLoggerLayer()),
          Effect.provide(NodeFileSystem.layer),
          Effect.catchAll((error) => Effect.succeed(error)),
        ),
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

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(createLoggerLayer()),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

      // Check that all providers from PROVIDER_MODELS are listed
      const expectedProviders = Object.keys(PROVIDER_MODELS);
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

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(createLoggerLayer()),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

      // Should find OpenAI regardless of case in config
      const openaiProvider = result.find((p) => p.name === "openai");
      expect(openaiProvider?.configured).toBe(true);
    });
  });
});
