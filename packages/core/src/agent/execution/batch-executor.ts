/**
 * Non-streaming agent execution. It makes complete model calls, shares the
 * agent loop with streaming mode, and sends tool events and final responses to
 * a delegated run's region when the presentation surface can inspect one.
 */

import { Cause, Duration, Effect, Ref } from "effect";
import {
  makeUserVisibleLlmRetrySchedule,
  withLongRunningLlmNotice,
} from "@/core/agent/execution/llm-retry-present";
import { DEFAULT_MAX_LLM_RETRIES, LLM_TIMEOUT_SECONDS } from "@/core/constants/agent";
import type { AgentConfigService } from "@/core/interfaces/agent-config";
import { LLMServiceTag, type LLMService } from "@/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import type { PresentationService, StreamingRenderer } from "@/core/interfaces/presentation";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import type { ToolRegistry, ToolRequirements } from "@/core/interfaces/tool-registry";
import type { ConversationMessages } from "@/core/types";
import { LLMRateLimitError } from "@/core/types/errors";
import { describeReasoningSelection, reasoningIsEnabled } from "@/core/types/model-capabilities";
import type { DisplayConfig } from "@/core/types/output";
import { executeAgentLoop, type CompletionStrategy } from "./agent-loop";
import { makeDefaultObserver } from "./agent-loop-observer";
import type { RecursiveRunner } from "../context/summarizer";
import { emitLLMRetry, recordLLMRetry } from "../metrics/agent-run-metrics";
import type { AgentResponse, AgentRunContext, AgentRunnerOptions } from "../types";

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
    const maxRetries = runContext.maxRetries ?? DEFAULT_MAX_LLM_RETRIES;

    const reasoning = agent.config.reasoning;
    const reasoningLabel = describeReasoningSelection(reasoning);
    const shouldShowReasoning = displayConfig.showReasoning && reasoningIsEnabled(reasoning);
    const captureRun =
      options.ephemeralRegionId !== undefined &&
      presentationService.capturesEphemeralRunDetails?.() === true;

    // The one-shot event emitter and the fullscreen sub-agent inspector both
    // need tool lifecycle events in batch mode. Other visual runs keep their
    // plain `format*` rendering.
    const toolEventRenderer: StreamingRenderer | null =
      captureRun || presentationService.emitsToolEventsViaRenderer?.() === true
        ? yield* presentationService.createStreamingRenderer({
            displayConfig,
            streamingConfig: { enabled: true, ...(captureRun ? { textBufferMs: 0 } : {}) },
            showMetrics,
            agentName: agent.name,
            reasoning: reasoningLabel,
            ...(captureRun && options.ephemeralRegionId !== undefined
              ? {
                  streamTarget: { kind: "ephemeral" as const, regionId: options.ephemeralRegionId },
                }
              : {}),
          })
        : null;

    const strategy: CompletionStrategy = {
      shouldShowReasoning,

      getCompletion(
        currentMessages: ConversationMessages,
        _iteration: number,
        toolsAllowed: boolean,
      ) {
        return Effect.gen(function* () {
          const llmOptions = {
            model,
            messages: currentMessages,
            tools: runContext.tools,
            toolChoice: toolsAllowed ? ("auto" as const) : ("none" as const),
            ...(reasoning !== undefined ? { reasoning } : {}),
            ...(typeof agent.config.temperature === "number"
              ? { temperature: agent.config.temperature }
              : {}),
            ...(typeof agent.config.numCtx === "number" ? { num_ctx: agent.config.numCtx } : {}),
            ...(agent.config.llmApiKeys ? { providerApiKeys: agent.config.llmApiKeys } : {}),
          };

          const showAgentStatus = (
            message: string,
            level: "info" | "success" | "warning" | "error" | "progress",
          ) => presentationService.presentStatus(message, level, agent.name);

          const retryAttemptRef = yield* Ref.make(0);
          const batchRetrySchedule = makeUserVisibleLlmRetrySchedule(
            maxRetries,
            agent.name,
            showAgentStatus,
            retryAttemptRef,
          );

          const completion = yield* Effect.retry(
            withLongRunningLlmNotice(
              agent.name,
              showAgentStatus,
              llmService.createChatCompletion(provider, llmOptions).pipe(
                Effect.tapError((error) =>
                  Effect.gen(function* () {
                    recordLLMRetry(runMetrics, error);
                    yield* emitLLMRetry(runMetrics, error);
                  }),
                ),
              ),
            ),
            batchRetrySchedule,
          ).pipe(
            Effect.timeout(Duration.seconds(LLM_TIMEOUT_SECONDS)),
            Effect.tapError((error) =>
              Cause.isTimeoutException(error)
                ? showAgentStatus(
                    `${agent.name} exceeded the maximum wait time for this step (including retries). Check connectivity or try again.`,
                    "warning",
                  )
                : Effect.void,
            ),
          );

          return { completion, interrupted: false };
        });
      },

      presentResponse(_agentName, content, completion) {
        return Effect.gen(function* () {
          if (options.internal) {
            if (
              captureRun &&
              options.ephemeralRegionId !== undefined &&
              content.trim().length > 0
            ) {
              yield* presentationService.presentAgentResponse(agent.name, content, {
                ephemeralRegionId: options.ephemeralRegionId,
              });
            }
          } else {
            // Format content only when markdown mode is enabled
            let formattedContent = content;
            if (formattedContent && displayConfig.mode === "rendered") {
              formattedContent = yield* presentationService.renderMarkdown(formattedContent);
            }

            if (formattedContent && formattedContent.trim().length > 0) {
              yield* presentationService.writeBlankLine();
              yield* presentationService.presentAgentResponse(agent.name, formattedContent);
              yield* presentationService.writeBlankLine();
            }
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
        return toolEventRenderer;
      },
    };

    const observer = makeDefaultObserver(presentationService);
    return yield* executeAgentLoop(
      options,
      runContext,
      displayConfig,
      strategy,
      observer,
      runRecursive,
    );
  });
}
