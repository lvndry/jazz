import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, tool, type LanguageModel } from "ai";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import type { ChatCompletionOptions } from "@/core/types/chat";
import type { ChatMessage } from "@/core/types/message";
import { buildProviderOptions, toCoreMessages } from "./ai-sdk-service";
import { extractReasoningParts } from "./reasoning-parts";

const weatherTool = {
  get_weather: tool({
    description: "Get the current weather for a city",
    inputSchema: z.object({ city: z.string() }),
  }),
};

const reasoningOptions = (model: string): ChatCompletionOptions =>
  ({
    model,
    messages: [{ role: "user", content: "unused" }],
    reasoning_effort: "medium",
  }) as ChatCompletionOptions;

async function runToolLoopRoundTrip(
  model: LanguageModel,
  providerName: "anthropic" | "openai",
  modelId: string,
): Promise<string> {
  const providerOptions = buildProviderOptions(providerName, reasoningOptions(modelId));
  const userMessage: ChatMessage = {
    role: "user",
    content: "What is the weather in Paris? Use the get_weather tool.",
  };

  const firstResult = await generateText({
    model,
    messages: toCoreMessages([userMessage], providerName),
    tools: weatherTool,
    ...(providerOptions ? { providerOptions } : {}),
  });

  const firstToolCall = firstResult.toolCalls[0];
  expect(firstToolCall).toBeDefined();

  const reasoningParts = extractReasoningParts(firstResult.response.messages, providerName);
  expect(reasoningParts?.length).toBeGreaterThan(0);

  const history: ChatMessage[] = [
    userMessage,
    {
      role: "assistant",
      content: firstResult.text,
      reasoning_parts: reasoningParts,
      tool_calls: [
        {
          id: firstToolCall!.toolCallId,
          type: "function",
          function: {
            name: firstToolCall!.toolName,
            arguments: JSON.stringify(firstToolCall!.input ?? {}),
          },
        },
      ],
    },
    {
      role: "tool",
      content: "22°C and sunny",
      tool_call_id: firstToolCall!.toolCallId,
      name: firstToolCall!.toolName,
    },
  ];

  const secondResult = await generateText({
    model,
    messages: toCoreMessages(history, providerName),
    tools: weatherTool,
    ...(providerOptions ? { providerOptions } : {}),
  });

  return secondResult.text;
}

describe.skipIf(!process.env["ANTHROPIC_API_KEY"])("live: anthropic reasoning round-trip", () => {
  it("completes a thinking-enabled tool loop without a signature error", async () => {
    const provider = createAnthropic({ apiKey: process.env["ANTHROPIC_API_KEY"] });
    const finalText = await runToolLoopRoundTrip(
      provider("claude-haiku-4-5"),
      "anthropic",
      "claude-haiku-4-5",
    );
    expect(finalText.length).toBeGreaterThan(0);
  }, 120_000);
});

describe.skipIf(!process.env["OPENAI_API_KEY"])("live: openai reasoning round-trip", () => {
  it("completes an encrypted-reasoning tool loop without an item error", async () => {
    const provider = createOpenAI({ apiKey: process.env["OPENAI_API_KEY"] });
    const finalText = await runToolLoopRoundTrip(provider("gpt-5-mini"), "openai", "gpt-5-mini");
    expect(finalText.length).toBeGreaterThan(0);
  }, 120_000);
});
