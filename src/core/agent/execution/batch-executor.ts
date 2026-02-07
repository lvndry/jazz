import { Effect, Schedule } from "effect";
import type { AgentConfigService } from "@/core/interfaces/agent-config";
import { LLMServiceTag, type LLMService } from "@/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import type { PresentationService } from "@/core/interfaces/presentation";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import type { ToolRegistry, ToolRequirements } from "@/core/interfaces/tool-registry";
import type { ConversationMessages } from "@/core/types";
import { LLMRateLimitError } from "@/core/types/errors";
import type { DisplayConfig } from "@/core/types/output";
import { executeAgentLoop, type CompletionStrategy } from "./agent-loop";
import type { RecursiveRunner } from "../context/summarizer";
import { recordLLMRetry } from "../metrics/agent-run-metrics";
import type { AgentResponse, AgentRunContext, AgentRunnerOptions } from "../types";

const MAX_RETRIES = 3;

/**
 * Non-streaming implementation that waits for complete LLM responses before rendering.
 */
export function executeWithoutStreaming(
  options: AgentRunnerOptions,
  runContext: AgentRunContext,
  displayConfig: DisplayConfig,
  showMetrics: boolean,
  runRecursive: RecursiveRunner,
): Effect.Effect<
  AgentResponse,
  LLMRateLimitError | Error,
  | LLMService
  | ToolRegistry
  | LoggerService
  | AgentConfigService
  | PresentationService
  | ToolRequirements
> {
  return Effect.gen(function* () {
    const llmService = yield* LLMServiceTag;
    const logger = yield* LoggerServiceTag;
    const presentationService = yield* PresentationServiceTag;
    const { agent } = options;
    const { runMetrics, provider, model } = runContext;

    const strategy: CompletionStrategy = {
      shouldShowThinking: displayConfig.showThinking,

      getCompletion(currentMessages: ConversationMessages, _iteration: number) {
        return Effect.gen(function* () {
          const llmOptions = {
            model,
            messages: currentMessages,
            tools: runContext.tools,
            toolChoice: "auto" as const,
            reasoning_effort: agent.config.reasoningEffort ?? "disable",
          };

          const completion = yield* Effect.retry(
            Effect.gen(function* () {
              try {
                return yield* llmService.createChatCompletion(provider, llmOptions);
              } catch (error) {
                recordLLMRetry(runMetrics, error);
                throw error;
              }
            }),
            Schedule.exponential("1 second").pipe(
              Schedule.intersect(Schedule.recurs(MAX_RETRIES)),
              Schedule.whileInput((error) => error instanceof LLMRateLimitError),
            ),
          );

          return { completion, interrupted: false };
        });
      },

      presentResponse(_agentName, content, completion) {
        return Effect.gen(function* () {
          // Format content only when markdown mode is enabled
          let formattedContent = content;
          if (formattedContent && displayConfig.mode === "rendered") {
            formattedContent = yield* presentationService.renderMarkdown(formattedContent);
          }

          // Display final response
          if (formattedContent && formattedContent.trim().length > 0) {
            yield* presentationService.writeBlankLine();
            yield* presentationService.presentAgentResponse(agent.name, formattedContent);
            yield* presentationService.writeBlankLine();
          }

          // Show metrics if enabled
          if (showMetrics && completion.usage) {
            const parts: string[] = [];
            if (completion.usage.totalTokens)
              parts.push(`Total: ${completion.usage.totalTokens} tokens`);
            if (completion.usage.promptTokens)
              parts.push(`Prompt: ${completion.usage.promptTokens}`);
            if (completion.usage.completionTokens)
              parts.push(`Completion: ${completion.usage.completionTokens}`);
            if (parts.length > 0) {
              yield* logger.info(`[${parts.join(" | ")}]`);
            }
          }
        });
      },

      onComplete(_agentName, _completion) {
        return Effect.void;
      },

      getRenderer() {
        return null;
      },
    };

    return yield* executeAgentLoop(options, runContext, displayConfig, strategy, runRecursive);
  });
}
