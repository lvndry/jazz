import type { Agent } from "@/core/types";
import type { ChatCompletionOptions, ToolHost } from "@/core/types/chat";

export interface CompletionRequestInput {
  readonly agent: Agent;
  readonly model: string;
  readonly tools: ChatCompletionOptions["tools"];
  readonly messages: ChatCompletionOptions["messages"];
  readonly toolChoice: "auto" | "none";
  readonly toolHost?: ToolHost;
  readonly conversationId?: string;
}

/**
 * The model request an agent run sends: its model, tools, reasoning, sampling and per-provider
 * overrides. A run's steps and a cache-aligned compaction summary both build from it, so a
 * summary request differs from the step before it only in its messages and tool choice.
 */
export function buildCompletionOptions(input: CompletionRequestInput): ChatCompletionOptions {
  const { agent, model, tools, messages, toolChoice, toolHost, conversationId } = input;
  const { reasoning, temperature, numCtx, apiKeys, baseUrls } = agent.config.llm;
  return {
    model,
    messages,
    ...(tools !== undefined ? { tools } : {}),
    toolChoice,
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(toolHost !== undefined ? { toolHost } : {}),
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(typeof temperature === "number" ? { temperature } : {}),
    ...(typeof numCtx === "number" ? { num_ctx: numCtx } : {}),
    ...(apiKeys ? { providerApiKeys: apiKeys } : {}),
    ...(baseUrls ? { providerBaseUrls: baseUrls } : {}),
  };
}
