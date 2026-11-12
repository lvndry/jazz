/** Verifies that an aligned checkpoint preserves the actual adapter message prefix and reasoning. */
import { toCoreMessages } from "@jazz/adapters/llm/ai-sdk-service";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { LLMServiceTag, type LLMService } from "@/core/interfaces/llm";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import { partialFake } from "@/core/test-support/fakes";
import type { Agent } from "@/core/types/agent";
import type { ChatCompletionOptions } from "@/core/types/chat";
import type { ChatMessage } from "@/core/types/message";
import { createAgentRunMetrics } from "../metrics/agent-run-metrics";
import { observePromptCache, type PromptCacheScope } from "../metrics/prompt-cache-observer";
import { silentLogger } from "../test-logger";
import { requestAlignedSummary } from "./cache-aligned-summary";

describe("cache-aligned checkpoint adapter prefix", () => {
  for (const provider of ["anthropic", "openai", "moonshotai", "deepseek"] as const) {
    it(`retains current-turn reasoning for ${provider}`, async () => {
      const model =
        provider === "anthropic"
          ? "claude-sonnet-4-5"
          : provider === "openai"
            ? "gpt-5"
            : provider === "moonshotai"
              ? "kimi-k2.5"
              : "deepseek-reasoner";
      const agent: Agent = {
        id: `prefix-${provider}`,
        name: "prefix",
        config: { persona: "default", llm: { provider, model }, tools: [] },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const history: ChatMessage[] = [
        { role: "system", content: "rules" },
        { role: "user", content: "do the task" },
        {
          role: "assistant",
          content: "",
          reasoning_parts: [
            {
              provider,
              text: provider === "openai" ? "" : "thinking",
              providerOptions:
                provider === "openai"
                  ? { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted" } }
                  : { [provider]: { signature: "sig-1" } },
            },
          ],
          tool_calls: [
            { id: "read", type: "function", function: { name: "read_file", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "read", name: "read_file", content: "file contents" },
      ];
      const metrics = createAgentRunMetrics({ agent, conversationId: agent.id, provider, model });
      const scope: PromptCacheScope = {
        logger: silentLogger,
        runMetrics: metrics,
        conversationKey: agent.id,
        provider,
        model,
        emit: undefined,
      };
      await Effect.runPromise(observePromptCache(scope, [], history));
      let sent: ChatCompletionOptions | undefined;
      const llm = partialFake<LLMService>({
        createChatCompletion: (_provider, options) =>
          Effect.sync(() => {
            sent = options;
            return {
              id: "summary",
              model,
              content: "checkpoint",
              finishReason: "stop",
              usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105 },
            };
          }),
      });
      const result = await Effect.runPromise(
        requestAlignedSummary({
          alignment: { tools: [], cacheScope: scope, pricing: undefined },
          agent,
          history,
          instruction: "summarize",
        }).pipe(
          Effect.provideService(LLMServiceTag, llm),
          Effect.provideService(LoggerServiceTag, silentLogger),
        ),
      );
      expect(result.kind).toBe("summary");
      if (sent === undefined) {
        throw new Error("no summary request");
      }
      const before = toCoreMessages(history, provider, undefined, { modelName: model });
      const after = toCoreMessages(sent.messages, provider, undefined, { modelName: model });
      expect(JSON.stringify(before)).toContain('"type":"reasoning"');
      expect(after.slice(0, before.length)).toEqual(before);
      expect(metrics.lastCacheReason).toBe("none");
    });
  }
});
