import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { LLMConfigurationError } from "../../core/types/errors";
import type { AppConfig, LLMConfig } from "../../core/types/index";
import { AgentConfigService, ConfigServiceImpl, type ConfigService } from "../config";
import { createAISDKServiceLayer } from "./ai-sdk-service";
import { LLMServiceTag } from "./interfaces";
import { PROVIDER_MODELS } from "./models";

describe("OpenRouter Integration - AI SDK Service", () => {
  /**
   * Helper to create a test config layer with OpenRouter configuration
   */
  function createTestConfigLayer(llmConfig: LLMConfig): Layer.Layer<ConfigService, never> {
    const appConfig: AppConfig = {
      storage: { type: "file", path: "/tmp/test" },
      logging: { level: "info", format: "pretty", output: "console" },
      llm: llmConfig,
    };

    return Layer.succeed(AgentConfigService, new ConfigServiceImpl(appConfig));
  }

  describe("Provider Registration", () => {
    it("should register OpenRouter when API key is configured", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        const providers = yield* llmService.listProviders();
        return providers;
      });

      const configLayer = createTestConfigLayer({
        openrouter: { api_key: "sk-or-v1-test-key" },
      });

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

      expect(result.some((p) => p.name === "openrouter" && p.configured)).toBe(true);
    });

    it("should not register OpenRouter when API key is missing", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        const providers = yield* llmService.listProviders();
        return providers;
      });

      const configLayer = createTestConfigLayer({
        openai: { api_key: "sk-test-key" },
      });

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

      expect(result.some((p) => p.name === "openrouter" && p.configured)).toBe(false);
      expect(result.some((p) => p.name === "openai" && p.configured)).toBe(true);
    });

    it("should register multiple providers including OpenRouter", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        const providers = yield* llmService.listProviders();
        return providers;
      });

      const configLayer = createTestConfigLayer({
        openai: { api_key: "sk-test-key" },
        openrouter: { api_key: "sk-or-v1-test-key" },
        anthropic: { api_key: "sk-ant-test-key" },
      });

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

      expect(result.some((p) => p.name === "openrouter" && p.configured)).toBe(true);
      expect(result.some((p) => p.name === "openai" && p.configured)).toBe(true);
      expect(result.some((p) => p.name === "anthropic" && p.configured)).toBe(true);
      expect(result.filter((p) => p.configured).length).toBe(4); // includes ollama by default
    });
  });

  describe("API Key Extraction", () => {
    it("should extract OpenRouter API key from configuration", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        const provider = yield* llmService.getProvider("openrouter");
        // Verify provider was created successfully
        return provider;
      });

      const configLayer = createTestConfigLayer({
        openrouter: { api_key: "sk-or-v1-test-key-12345" },
      });

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

      expect(result.name).toBe("openrouter");
      expect(result.supportedModels.length).toBeGreaterThan(0);
    });

    it("should succeed when only Ollama is available (no API keys)", async () => {
      const testEffect = Effect.gen(function* () {
        // Ollama is always available even without an API key
        const llmService = yield* LLMServiceTag;
        const providers = yield* llmService.listProviders();
        return providers;
      });

      const configLayer = createTestConfigLayer({});

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

      // Only Ollama should be configured
      expect(result.some((p) => p.name === "ollama" && p.configured)).toBe(true);
      expect(result.filter((p) => p.configured).length).toBe(1);
    });
  });

  describe("Environment Variable Export", () => {
    it("should export OPENROUTER_API_KEY to environment", async () => {
      const testEffect = Effect.gen(function* () {
        // Service constructor exports API keys to env
        yield* LLMServiceTag;
        return process.env["OPENROUTER_API_KEY"];
      });

      const configLayer = createTestConfigLayer({
        openrouter: { api_key: "sk-or-v1-env-test-key" },
      });

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

      expect(result).toBe("sk-or-v1-env-test-key");
    });

    it("should export multiple provider API keys to environment", async () => {
      const testEffect = Effect.gen(function* () {
        yield* LLMServiceTag;
        return {
          openrouter: process.env["OPENROUTER_API_KEY"],
          openai: process.env["OPENAI_API_KEY"],
          anthropic: process.env["ANTHROPIC_API_KEY"],
        };
      });

      const configLayer = createTestConfigLayer({
        openrouter: { api_key: "sk-or-v1-multi-test" },
        openai: { api_key: "sk-openai-multi-test" },
        anthropic: { api_key: "sk-ant-multi-test" },
      });

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

      expect(result.openrouter).toBe("sk-or-v1-multi-test");
      expect(result.openai).toBe("sk-openai-multi-test");
      expect(result.anthropic).toBe("sk-ant-multi-test");
    });
  });

  describe("Model Registry", () => {
    it("should include OpenRouter models in registry", () => {
      const openrouterModels = PROVIDER_MODELS.openrouter;

      expect(openrouterModels).toBeDefined();
      expect(openrouterModels.length).toBeGreaterThan(0);
    });

    it("should include OpenAI models via OpenRouter", () => {
      const openrouterModels = PROVIDER_MODELS.openrouter;
      const openaiModels = openrouterModels.filter((m) => m.id.startsWith("openai/"));

      expect(openaiModels.length).toBeGreaterThan(0);
      expect(openaiModels.some((m) => m.id === "openai/gpt-4o")).toBe(true);
      expect(openaiModels.some((m) => m.id === "openai/gpt-4o-mini")).toBe(true);
    });

    it("should include Anthropic models via OpenRouter", () => {
      const openrouterModels = PROVIDER_MODELS.openrouter;
      const anthropicModels = openrouterModels.filter((m) => m.id.startsWith("anthropic/"));

      expect(anthropicModels.length).toBeGreaterThan(0);
      expect(anthropicModels.some((m) => m.id === "anthropic/claude-3.5-sonnet")).toBe(true);
    });

    it("should include Google models via OpenRouter", () => {
      const openrouterModels = PROVIDER_MODELS.openrouter;
      const googleModels = openrouterModels.filter((m) => m.id.startsWith("google/"));

      expect(googleModels.length).toBeGreaterThan(0);
      expect(googleModels.some((m) => m.id === "google/gemini-pro-1.5")).toBe(true);
    });

    it("should include Meta models via OpenRouter", () => {
      const openrouterModels = PROVIDER_MODELS.openrouter;
      const metaModels = openrouterModels.filter((m) => m.id.startsWith("meta-llama/"));

      expect(metaModels.length).toBeGreaterThan(0);
      expect(metaModels.some((m) => m.id === "meta-llama/llama-3.1-405b-instruct")).toBe(true);
    });

    it("should include Mistral models via OpenRouter", () => {
      const openrouterModels = PROVIDER_MODELS.openrouter;
      const mistralModels = openrouterModels.filter((m) => m.id.startsWith("mistralai/"));

      expect(mistralModels.length).toBeGreaterThan(0);
      expect(mistralModels.some((m) => m.id === "mistralai/mistral-large")).toBe(true);
    });

    it("should include DeepSeek models via OpenRouter", () => {
      const openrouterModels = PROVIDER_MODELS.openrouter;
      const deepseekModels = openrouterModels.filter((m) => m.id.startsWith("deepseek/"));

      expect(deepseekModels.length).toBeGreaterThan(0);
      expect(deepseekModels.some((m) => m.id === "deepseek/deepseek-chat")).toBe(true);
      expect(deepseekModels.some((m) => m.id === "deepseek/deepseek-r1")).toBe(true);
    });

    it("should correctly mark reasoning models", () => {
      const openrouterModels = PROVIDER_MODELS.openrouter;

      // Reasoning models
      const o1 = openrouterModels.find((m) => m.id === "openai/o1");
      const o1Mini = openrouterModels.find((m) => m.id === "openai/o1-mini");
      const deepseekR1 = openrouterModels.find((m) => m.id === "deepseek/deepseek-r1");

      expect(o1?.isReasoningModel).toBe(true);
      expect(o1Mini?.isReasoningModel).toBe(true);
      expect(deepseekR1?.isReasoningModel).toBe(true);

      // Non-reasoning models
      const gpt4o = openrouterModels.find((m) => m.id === "openai/gpt-4o");
      const claude = openrouterModels.find((m) => m.id === "anthropic/claude-3.5-sonnet");

      expect(gpt4o?.isReasoningModel).toBe(false);
      expect(claude?.isReasoningModel).toBe(false);
    });

    it("should use provider/model-name format for all models", () => {
      const openrouterModels = PROVIDER_MODELS.openrouter;

      for (const model of openrouterModels) {
        expect(model.id).toMatch(/^[a-z0-9-]+\/[a-z0-9.-]+$/);
        expect(model.id.split("/").length).toBe(2);
      }
    });
  });

  describe("Provider Interface", () => {
    it("should return OpenRouter provider with correct structure", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        const provider = yield* llmService.getProvider("openrouter");
        return provider;
      });

      const configLayer = createTestConfigLayer({
        openrouter: { api_key: "sk-or-v1-test-key" },
      });

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

      expect(result.name).toBe("openrouter");
      expect(result.supportedModels).toBeDefined();
      expect(result.supportedModels.length).toBeGreaterThan(0);
      expect(result.defaultModel).toBeDefined();
      expect(result.defaultModel.length).toBeGreaterThan(0);
      expect(result.authenticate).toBeDefined();
      expect(typeof result.authenticate).toBe("function");
      expect(result.createChatCompletion).toBeDefined();
      expect(typeof result.createChatCompletion).toBe("function");
    });

    it("should have a valid default model", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        const provider = yield* llmService.getProvider("openrouter");
        return provider.defaultModel;
      });

      const configLayer = createTestConfigLayer({
        openrouter: { api_key: "sk-or-v1-test-key" },
      });

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

      // Default model should be the first in the list
      const firstModel = PROVIDER_MODELS.openrouter[0];
      expect(result).toBe(firstModel?.id);
    });

    it("should authenticate successfully with valid API key", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        const provider = yield* llmService.getProvider("openrouter");
        yield* provider.authenticate();
        return "authenticated";
      });

      const configLayer = createTestConfigLayer({
        openrouter: { api_key: "sk-or-v1-test-key" },
      });

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

      expect(result).toBe("authenticated");
    });
  });

  describe("Model Selection", () => {
    it("should return all supported models for OpenRouter", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        const provider = yield* llmService.getProvider("openrouter");
        return provider.supportedModels;
      });

      const configLayer = createTestConfigLayer({
        openrouter: { api_key: "sk-or-v1-test-key" },
      });

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

      expect(result.length).toBe(PROVIDER_MODELS.openrouter.length);
      expect(result.every((m) => m.id && m.displayName)).toBe(true);
    });

    it("should include display names for all models", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        const provider = yield* llmService.getProvider("openrouter");
        return provider.supportedModels;
      });

      const configLayer = createTestConfigLayer({
        openrouter: { api_key: "sk-or-v1-test-key" },
      });

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

      for (const model of result) {
        expect(model.displayName).toBeDefined();
        expect(model.displayName!.length).toBeGreaterThan(0);
      }
    });
  });

  describe("Configuration Validation", () => {
    it("should handle empty LLM config", async () => {
      const testEffect = Effect.gen(function* () {
        yield* LLMServiceTag;
        return "should not reach here";
      });

      const configLayer = createTestConfigLayer({});

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(NodeFileSystem.layer),
          Effect.catchAll((error) => Effect.succeed(error)),
        ),
      );

      expect(result).toBeInstanceOf(LLMConfigurationError);
    });

    it("should handle config with only OpenRouter", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;
        const providers = yield* llmService.listProviders();
        return providers;
      });

      const configLayer = createTestConfigLayer({
        openrouter: { api_key: "sk-or-v1-only-provider" },
      });

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

      expect(result.some((p) => p.name === "openrouter" && p.configured)).toBe(true);
      expect(result.some((p) => p.name === "ollama" && p.configured)).toBe(true);
      expect(result.filter((p) => p.configured).length).toBe(2); // openrouter + ollama
    });
  });
});
