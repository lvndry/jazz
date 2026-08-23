import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, tool, type LanguageModel, type ToolSet } from "ai";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import type { ChatCompletionOptions } from "@/core/types/chat";
import type { ChatMessage } from "@/core/types/message";
import { buildProviderOptions, toCoreMessages } from "./ai-sdk-service";
import { extractReasoningParts } from "./reasoning-parts";

const weatherTool: ToolSet = {
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
  providerName: "anthropic" | "openai" | "openrouter",
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
      ...(reasoningParts ? { reasoning_parts: reasoningParts } : {}),
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
    const provider = createAnthropic({ apiKey: process.env["ANTHROPIC_API_KEY"]! });
    const finalText = await runToolLoopRoundTrip(
      provider("claude-haiku-4-5"),
      "anthropic",
      "claude-haiku-4-5",
    );
    expect(finalText.length).toBeGreaterThan(0);
  }, 120_000);

  it("tolerates a mid-loop injected user message that strips thinking blocks", async () => {
    const provider = createAnthropic({ apiKey: process.env["ANTHROPIC_API_KEY"]! });
    const model = provider("claude-haiku-4-5");
    const providerOptions = buildProviderOptions("anthropic", reasoningOptions("claude-haiku-4-5"));
    const userMessage: ChatMessage = {
      role: "user",
      content: "What is the weather in Paris? Use the get_weather tool.",
    };

    const firstResult = await generateText({
      model,
      messages: toCoreMessages([userMessage], "anthropic"),
      tools: weatherTool,
      ...(providerOptions ? { providerOptions } : {}),
    });

    const firstToolCall = firstResult.toolCalls[0];
    expect(firstToolCall).toBeDefined();

    const reasoningParts = extractReasoningParts(firstResult.response.messages, "anthropic");
    expect(reasoningParts?.length).toBeGreaterThan(0);

    // Jazz's current-turn gate keys reasoning inclusion off the last user message
    // index, so a trailing user message injected mid-loop (as jazz does when a
    // budget or steering nudge fires) makes toCoreMessages drop the thinking block
    // from the earlier assistant turn while its tool_use call survives untouched.
    // This probes whether Anthropic tolerates that shape; a live 400 here is a
    // real finding, not a broken test.
    const history: ChatMessage[] = [
      userMessage,
      {
        role: "assistant",
        content: firstResult.text,
        ...(reasoningParts ? { reasoning_parts: reasoningParts } : {}),
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
      {
        role: "user",
        content: "[BUDGET: please wrap up]",
      },
    ];

    const secondResult = await generateText({
      model,
      messages: toCoreMessages(history, "anthropic"),
      tools: weatherTool,
      ...(providerOptions ? { providerOptions } : {}),
    });

    expect(secondResult.text.length).toBeGreaterThan(0);
  }, 120_000);
});

describe.skipIf(!process.env["OPENAI_API_KEY"])("live: openai reasoning round-trip", () => {
  it("completes an encrypted-reasoning tool loop without an item error", async () => {
    const provider = createOpenAI({ apiKey: process.env["OPENAI_API_KEY"]! });
    const finalText = await runToolLoopRoundTrip(provider("gpt-5-mini"), "openai", "gpt-5-mini");
    expect(finalText.length).toBeGreaterThan(0);
  }, 120_000);

  it("survives a multi-turn history where an old tool call has its reasoning stripped", async () => {
    const provider = createOpenAI({ apiKey: process.env["OPENAI_API_KEY"]! });
    const model = provider("gpt-5-mini");
    const providerOptions = buildProviderOptions("openai", reasoningOptions("gpt-5-mini"));
    const userMessage: ChatMessage = {
      role: "user",
      content: "What is the weather in Paris? Use the get_weather tool.",
    };

    const firstResult = await generateText({
      model,
      messages: toCoreMessages([userMessage], "openai"),
      tools: weatherTool,
      ...(providerOptions ? { providerOptions } : {}),
    });

    const firstToolCall = firstResult.toolCalls[0];
    expect(firstToolCall).toBeDefined();

    const reasoningParts = extractReasoningParts(firstResult.response.messages, "openai");
    expect(reasoningParts?.length).toBeGreaterThan(0);

    // A follow-up user turn moves jazz's current-turn gate past the first tool
    // loop, so toCoreMessages strips its reasoning while the function_call item
    // is still sent. store:false historically 400ed when function calls arrived
    // without their paired reasoning items (the reason these flags were disabled
    // in #117) — this probes whether that applies to resolved historical turns;
    // a live 400 here is a real finding, not a broken test.
    const history: ChatMessage[] = [
      userMessage,
      {
        role: "assistant",
        content: firstResult.text,
        ...(reasoningParts ? { reasoning_parts: reasoningParts } : {}),
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
      {
        role: "assistant",
        content: "It is 22°C and sunny in Paris.",
      },
      {
        role: "user",
        content: "Thanks! What about London? Use the get_weather tool.",
      },
    ];

    const secondResult = await generateText({
      model,
      messages: toCoreMessages(history, "openai"),
      tools: weatherTool,
      ...(providerOptions ? { providerOptions } : {}),
    });

    expect(secondResult.toolCalls.length + secondResult.text.length).toBeGreaterThan(0);
  }, 120_000);
});

describe.skipIf(!process.env["OPENROUTER_API_KEY"])("live: openrouter reasoning round-trip", () => {
  it("completes a thinking-enabled tool loop without a signature error", async () => {
    const provider = createOpenRouter({ apiKey: process.env["OPENROUTER_API_KEY"]! });
    const finalText = await runToolLoopRoundTrip(
      provider("anthropic/claude-haiku-4.5"),
      "openrouter",
      "anthropic/claude-haiku-4.5",
    );
    expect(finalText.length).toBeGreaterThan(0);
  }, 120_000);
});
