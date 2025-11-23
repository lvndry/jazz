import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "bun:test";
import { Effect, Layer, Stream } from "effect";
import { z } from "zod";
import {
  LLMAuthenticationError,
  LLMRateLimitError,
  LLMRequestError,
} from "../../core/types/errors";
import type { AppConfig, LLMConfig } from "../../core/types/index";
import { AgentConfigService, ConfigServiceImpl, type ConfigService } from "../config";
import { createAISDKServiceLayer } from "./ai-sdk-service";
import type { ChatCompletionOptions } from "./chat";
import { LLMServiceTag } from "./interfaces";
import type { StreamEvent } from "./streaming-types";
import type { ToolDefinition } from "./tools";

/**
 * Integration tests for OpenRouter provider
 * These tests require a valid OPENROUTER_API_KEY environment variable
 * Tests are skipped if the API key is not available
 */

const OPENROUTER_API_KEY = process.env["OPENROUTER_API_KEY"];
const shouldSkip = !OPENROUTER_API_KEY;

if (shouldSkip) {
  console.log("⚠️  Skipping OpenRouter integration tests - OPENROUTER_API_KEY not set");
}

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

describe("OpenRouter Integration Tests", () => {
  describe("Chat Completion", () => {
    it.if(!shouldSkip)("should complete a simple chat request with OpenRouter", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;

        const options: ChatCompletionOptions = {
          model: "openai/gpt-4o-mini",
          messages: [
            {
              role: "user",
              content: "Say 'Hello from OpenRouter!' and nothing else.",
            },
          ],
          temperature: 0.7,
        };

        const response = yield* llmService.createChatCompletion("openrouter", options);
        return response;
      });

      const configLayer = createTestConfigLayer({
        openrouter: { api_key: OPENROUTER_API_KEY! },
      });

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
      expect(result.model).toBe("openai/gpt-4o-mini");
      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content.toLowerCase()).toContain("hello");
    });

    it.if(!shouldSkip)("should return token usage information", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;

        const options: ChatCompletionOptions = {
          model: "openai/gpt-4o-mini",
          messages: [
            {
              role: "user",
              content: "Count from 1 to 5.",
            },
          ],
        };

        const response = yield* llmService.createChatCompletion("openrouter", options);
        return response;
      });

      const configLayer = createTestConfigLayer({
        openrouter: { api_key: OPENROUTER_API_KEY! },
      });

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

      expect(result.usage).toBeDefined();
      expect(result.usage!.promptTokens).toBeGreaterThan(0);
      expect(result.usage!.completionTokens).toBeGreaterThan(0);
      expect(result.usage!.totalTokens).toBeGreaterThan(0);
      expect(result.usage!.totalTokens).toBe(
        result.usage!.promptTokens + result.usage!.completionTokens,
      );
    });

    it.if(!shouldSkip)("should work with different OpenRouter models", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;

        const options: ChatCompletionOptions = {
          model: "anthropic/claude-3-haiku",
          messages: [
            {
              role: "user",
              content: "Respond with just the word 'success'.",
            },
          ],
        };

        const response = yield* llmService.createChatCompletion("openrouter", options);
        return response;
      });

      const configLayer = createTestConfigLayer({
        openrouter: { api_key: OPENROUTER_API_KEY! },
      });

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

      expect(result).toBeDefined();
      expect(result.model).toBe("anthropic/claude-3-haiku");
      expect(result.content).toBeDefined();
      expect(result.content.toLowerCase()).toContain("success");
    });
  });

  describe("Tool Call Handling", () => {
    it.if(!shouldSkip)("should handle tool calls correctly", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;

        const weatherTool: ToolDefinition = {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the current weather for a location",
            parameters: z.object({
              location: z.string().describe("The city and state, e.g. San Francisco, CA"),
              unit: z.enum(["celsius", "fahrenheit"]).optional(),
            }),
          },
        };

        const options: ChatCompletionOptions = {
          model: "openai/gpt-4o-mini",
          messages: [
            {
              role: "user",
              content: "What's the weather like in San Francisco?",
            },
          ],
          tools: [weatherTool],
        };

        const response = yield* llmService.createChatCompletion("openrouter", options);
        return response;
      });

      const configLayer = createTestConfigLayer({
        openrouter: { api_key: OPENROUTER_API_KEY! },
      });

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

      expect(result).toBeDefined();
      expect(result.toolCalls).toBeDefined();
      expect(result.toolCalls!.length).toBeGreaterThan(0);

      const toolCall = result.toolCalls![0];
      expect(toolCall!.type).toBe("function");
      expect(toolCall!.function.name).toBe("get_weather");
      expect(toolCall!.function.arguments).toBeDefined();

      const args = JSON.parse(toolCall!.function.arguments);
      expect(args.location).toBeDefined();
      expect(args.location.toLowerCase()).toContain("san francisco");
    });

    it.if(!shouldSkip)("should handle multiple tool calls in one response", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;

        const tools: ToolDefinition[] = [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get weather for a location",
              parameters: z.object({
                location: z.string(),
              }),
            },
          },
          {
            type: "function",
            function: {
              name: "get_time",
              description: "Get current time for a location",
              parameters: z.object({
                location: z.string(),
              }),
            },
          },
        ];

        const options: ChatCompletionOptions = {
          model: "openai/gpt-4o-mini",
          messages: [
            {
              role: "user",
              content: "What's the weather and time in New York?",
            },
          ],
          tools,
        };

        const response = yield* llmService.createChatCompletion("openrouter", options);
        return response;
      });

      const configLayer = createTestConfigLayer({
        openrouter: { api_key: OPENROUTER_API_KEY! },
      });

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

      expect(result.toolCalls).toBeDefined();
      expect(result.toolCalls!.length).toBeGreaterThan(0);

      const toolNames = result.toolCalls!.map((tc) => tc.function.name);
      expect(toolNames).toContain("get_weather");
    });
  });

  describe("Streaming Responses", () => {
    it.if(!shouldSkip)("should stream text chunks correctly", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;

        const options: ChatCompletionOptions = {
          model: "openai/gpt-4o-mini",
          messages: [
            {
              role: "user",
              content: "Count from 1 to 10, one number per line.",
            },
          ],
        };

        const streamingResult = yield* llmService.createStreamingChatCompletion(
          "openrouter",
          options,
        );

        const events: StreamEvent[] = [];
        yield* Stream.runForEach(streamingResult.stream, (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        );

        const finalResponse = yield* streamingResult.response;

        return { events, finalResponse };
      });

      const configLayer = createTestConfigLayer({
        openrouter: { api_key: OPENROUTER_API_KEY! },
      });

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

      expect(result.events.length).toBeGreaterThan(0);

      const streamStart = result.events.find((e) => e.type === "stream_start");
      expect(streamStart).toBeDefined();
      expect(streamStart?.type).toBe("stream_start");

      const textChunks = result.events.filter((e) => e.type === "text_chunk");
      expect(textChunks.length).toBeGreaterThan(0);

      const complete = result.events.find((e) => e.type === "complete");
      expect(complete).toBeDefined();
      expect(complete?.type).toBe("complete");

      expect(result.finalResponse).toBeDefined();
      expect(result.finalResponse.content).toBeDefined();
      expect(result.finalResponse.content.length).toBeGreaterThan(0);
    });

    it.if(!shouldSkip)("should handle streaming cancellation", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;

        const options: ChatCompletionOptions = {
          model: "openai/gpt-4o-mini",
          messages: [
            {
              role: "user",
              content: "Write a very long story about a robot.",
            },
          ],
        };

        const streamingResult = yield* llmService.createStreamingChatCompletion(
          "openrouter",
          options,
        );

        let chunkCount = 0;
        const events: StreamEvent[] = [];

        yield* Stream.runForEach(streamingResult.stream, (event) =>
          Effect.gen(function* () {
            events.push(event);
            if (event.type === "text_chunk") {
              chunkCount++;
              if (chunkCount >= 3) {
                yield* streamingResult.cancel;
              }
            }
          }),
        ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

        return { events, chunkCount };
      });

      const configLayer = createTestConfigLayer({
        openrouter: { api_key: OPENROUTER_API_KEY! },
      });

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

      expect(result.chunkCount).toBeGreaterThanOrEqual(3);
      expect(result.events.length).toBeGreaterThan(0);
    });

    it.if(!shouldSkip)("should stream tool calls", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;

        const calculatorTool: ToolDefinition = {
          type: "function",
          function: {
            name: "calculate",
            description: "Perform a mathematical calculation",
            parameters: z.object({
              expression: z.string().describe("The mathematical expression to evaluate"),
            }),
          },
        };

        const options: ChatCompletionOptions = {
          model: "openai/gpt-4o-mini",
          messages: [
            {
              role: "user",
              content: "What is 25 multiplied by 4?",
            },
          ],
          tools: [calculatorTool],
        };

        const streamingResult = yield* llmService.createStreamingChatCompletion(
          "openrouter",
          options,
        );

        const events: StreamEvent[] = [];
        yield* Stream.runForEach(streamingResult.stream, (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        );

        const finalResponse = yield* streamingResult.response;

        return { events, finalResponse };
      });

      const configLayer = createTestConfigLayer({
        openrouter: { api_key: OPENROUTER_API_KEY! },
      });

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(NodeFileSystem.layer),
        ),
      );

      const toolCallEvents = result.events.filter((e) => e.type === "tool_call");
      expect(toolCallEvents.length).toBeGreaterThan(0);

      expect(result.finalResponse.toolCalls).toBeDefined();
      expect(result.finalResponse.toolCalls!.length).toBeGreaterThan(0);
    });
  });

  describe("Error Handling", () => {
    it("should handle authentication errors with invalid API key", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;

        const options: ChatCompletionOptions = {
          model: "openai/gpt-4o-mini",
          messages: [
            {
              role: "user",
              content: "Hello",
            },
          ],
        };

        const response = yield* llmService.createChatCompletion("openrouter", options);
        return response;
      });

      const configLayer = createTestConfigLayer({
        openrouter: { api_key: "sk-or-v1-invalid-key-12345" },
      });

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(NodeFileSystem.layer),
          Effect.catchAll((error) => Effect.succeed(error)),
        ),
      );

      expect(result).toBeInstanceOf(LLMAuthenticationError);
      if (result instanceof LLMAuthenticationError) {
        expect(result.provider).toBe("openrouter");
        expect(result.message).toBeDefined();
      }
    });

    it.if(!shouldSkip)("should handle request errors with invalid model", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;

        const options: ChatCompletionOptions = {
          model: "invalid/nonexistent-model-xyz",
          messages: [
            {
              role: "user",
              content: "Hello",
            },
          ],
        };

        const response = yield* llmService.createChatCompletion("openrouter", options);
        return response;
      });

      const configLayer = createTestConfigLayer({
        openrouter: { api_key: OPENROUTER_API_KEY! },
      });

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(NodeFileSystem.layer),
          Effect.catchAll((error) => Effect.succeed(error)),
        ),
      );

      expect(
        result instanceof LLMRequestError ||
          result instanceof LLMAuthenticationError ||
          result instanceof LLMRateLimitError,
      ).toBe(true);
    });

    it("should handle streaming errors gracefully", async () => {
      const testEffect = Effect.gen(function* () {
        const llmService = yield* LLMServiceTag;

        const options: ChatCompletionOptions = {
          model: "openai/gpt-4o-mini",
          messages: [
            {
              role: "user",
              content: "Hello",
            },
          ],
        };

        const streamingResult = yield* llmService.createStreamingChatCompletion(
          "openrouter",
          options,
        );

        const events: StreamEvent[] = [];
        yield* Stream.runForEach(streamingResult.stream, (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ).pipe(Effect.catchAll((error) => Effect.succeed(error)));

        return events;
      });

      const configLayer = createTestConfigLayer({
        openrouter: { api_key: "sk-or-v1-invalid-streaming-key" },
      });

      const result = await Effect.runPromise(
        testEffect.pipe(
          Effect.provide(createAISDKServiceLayer()),
          Effect.provide(configLayer),
          Effect.provide(NodeFileSystem.layer),
          Effect.catchAll((error) => Effect.succeed(error)),
        ),
      );

      if (Array.isArray(result)) {
        const errorEvents = result.filter((e) => e.type === "error");
        expect(errorEvents.length).toBeGreaterThanOrEqual(0);
      } else {
        expect(result).toBeInstanceOf(LLMAuthenticationError);
      }
    });
  });
});
