/**
 * `ToolExecutor`: runs the tool calls an LLM response requests, handling risk
 * classification, approval gating, concurrency limits, timeouts, and interruption.
 */

import { Effect, Either, Exit, Fiber, Option } from "effect";
import { RunParkRequested } from "@/core/agent/run/park-signal";
import { classifyCommandRisk, shouldClassifyExecuteCommand } from "@/core/agent/tools/command-risk";
import { MAX_CONCURRENT_TOOLS, TOOL_TIMEOUT_MS } from "@/core/constants/agent";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import type { LLMService } from "@/core/interfaces/llm";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import {
  PresentationServiceTag,
  type PresentationService,
  type StreamingRenderer,
} from "@/core/interfaces/presentation";
import {
  ToolRegistryTag,
  type ToolRegistry,
  type ToolRequirements,
} from "@/core/interfaces/tool-registry";
import { GenerationInterruptedError, type ToolNotFoundError } from "@/core/types/errors";
import type { DisplayConfig } from "@/core/types/output";
import {
  isApprovalRequiredResult,
  shouldAutoApprove,
  type ToolCall,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolRiskLevel,
} from "@/core/types/tools";
import { extractCommandApprovalKey } from "@/core/utils/shell";
import { formatToolArguments } from "@/core/utils/tool-formatter";
import {
  emitToolInvocation,
  recordToolError,
  recordToolInvocation,
  type createAgentRunMetrics,
} from "../metrics/agent-run-metrics";

/**
 * Display metadata for tools whose behavior depends on a configured backend.
 * For web_search, resolves the provider the handler will actually use
 * (per-agent override first, then global config) so the UI can show
 * `web_search(brave)` instead of a bare tool name.
 */
function resolveToolDisplayMetadata(
  name: string,
  context: ToolExecutionContext,
): Effect.Effect<Record<string, unknown> | undefined, never, AgentConfigService> {
  return Effect.gen(function* () {
    if (name !== "web_search") return undefined;
    const configService = yield* AgentConfigServiceTag;
    const appConfig = yield* configService.appConfig;
    const provider =
      context.parentAgent?.config.webSearchProvider ?? appConfig.web_search?.provider;
    return { provider: provider ?? "builtin" };
  });
}

/**
 * Service for executing tools
 */
export class ToolExecutor {
  /**
   * Execute a tool by name with the provided arguments
   * Applies a timeout to prevent indefinite hanging
   */
  static executeTool(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
    overrideTimeoutMs?: number,
  ): Effect.Effect<
    ToolExecutionResult,
    ToolNotFoundError | Error,
    ToolRegistry | LoggerService | AgentConfigService | ToolRequirements
  > {
    return Effect.gen(function* () {
      const registry = yield* ToolRegistryTag;
      const logger = yield* LoggerServiceTag;

      // Use caller-provided timeout, or look up per-tool timeout, or fall back to default
      let timeoutMs = overrideTimeoutMs;
      const toolMeta =
        timeoutMs === undefined
          ? yield* registry.getTool(name).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
          : undefined;
      if (timeoutMs === undefined) {
        timeoutMs = toolMeta?.timeoutMs;
        // Long-running tools (e.g. user interaction) with no explicit timeout run indefinitely
        if (timeoutMs === undefined && !toolMeta?.longRunning) {
          timeoutMs = TOOL_TIMEOUT_MS;
        }
      }

      const execution = registry.executeTool(name, args, context);
      const result = yield* timeoutMs !== undefined
        ? execution.pipe(
            Effect.timeoutFail({
              duration: timeoutMs,
              onTimeout: () => {
                const timeoutMinutes = Math.round(timeoutMs / 60000);
                return new Error(`Operation timed out after '${timeoutMinutes}m'`);
              },
            }),
            Effect.catchAll((error) => {
              const message = error instanceof Error ? error.message : String(error);
              if (message.includes("timed out")) {
                void logger.warn(`Tool timeout: ${name}: ${message}`);
                return Effect.succeed({
                  success: false,
                  result: null,
                  error: message,
                } satisfies ToolExecutionResult);
              }
              return Effect.fail(error);
            }),
          )
        : execution;

      return result;
    });
  }

  /**
   * Execute a single tool call and return result
   */
  static executeToolCall(
    toolCall: ToolCall,
    context: ToolExecutionContext,
    displayConfig: DisplayConfig,
    renderer: StreamingRenderer | null,
    runMetrics: ReturnType<typeof createAgentRunMetrics>,
    agentId: string,
    conversationId: string,
    toolsRequiringApproval: ReadonlySet<string>,
    parkable = false,
  ): Effect.Effect<
    { toolCallId: string; result: unknown; success: boolean; name: string },
    Error,
    | ToolRegistry
    | LoggerService
    | AgentConfigService
    | ToolRequirements
    | PresentationService
    | LLMService
  > {
    return Effect.gen(function* () {
      const presentationService = yield* PresentationServiceTag;
      const logger = yield* LoggerServiceTag;

      if (toolCall.type !== "function") {
        return { toolCallId: toolCall.id, result: null, success: false, name: "unknown" };
      }

      const { name, arguments: argsString } = toolCall.function;
      recordToolInvocation(runMetrics, name);
      const toolStartTime = Date.now();

      try {
        // Parse arguments
        let parsed: unknown;
        try {
          parsed = JSON.parse(argsString);
        } catch (parseError) {
          throw new Error(
            `Invalid JSON in tool arguments: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            { cause: parseError },
          );
        }

        const args: Record<string, unknown> =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};

        yield* logger.logToolCall(name, args);

        // Look up tool metadata for UI hints
        const registry = yield* ToolRegistryTag;
        const toolMeta = yield* registry
          .getTool(name)
          .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
        const isLongRunning = toolMeta?.longRunning === true;

        // Emit tool execution start - skip for approval tools to avoid interleaving with
        // approval UI when multiple tools run in parallel (approval wrapper returns
        // immediately; the real "Executing tool" is emitted after user approval)
        const isApprovalTool = toolsRequiringApproval.has(name);
        if (displayConfig.showToolExecution && !isApprovalTool) {
          // Build metadata for specific tools (e.g., web_search provider)
          const metadata = yield* resolveToolDisplayMetadata(name, context);
          if (renderer) {
            yield* renderer.handleEvent({
              type: "tool_execution_start",
              toolName: name,
              toolCallId: toolCall.id,
              arguments: args,
              ...(metadata ? { metadata } : {}),
              ...(isLongRunning ? { longRunning: true } : {}),
            });
          } else {
            const message = yield* presentationService.formatToolExecutionStart(
              name,
              args,
              metadata ? { metadata } : undefined,
            );
            yield* presentationService.writeBlankLine();
            yield* presentationService.writeOutput(message);
          }
        }

        // Execute tool — pass pre-fetched timeout to avoid redundant getTool lookup
        let result = yield* ToolExecutor.executeTool(name, args, context, toolMeta?.timeoutMs);
        let toolDuration = Date.now() - toolStartTime;
        let finalToolName = name;
        let classifiedRisk: ToolRiskLevel | undefined;

        // Check if this result requires approval (Cursor/Claude-style approval flow)
        // If so, we intercept here, show approval UI (or auto-approve), and execute the follow-up tool
        if (isApprovalRequiredResult(result.result)) {
          const approvalResult = result.result;
          const registry = yield* ToolRegistryTag;

          // Get the tool's risk level to check against auto-approve policy
          const toolInfo = yield* registry
            .getTool(name)
            .pipe(Effect.catchAll(() => Effect.succeed({ riskLevel: "high-risk" as const })));
          let riskLevel = toolInfo.riskLevel;

          const getCurrentPolicy = () => context.getAutoApprovePolicy?.();
          const autoApprovePolicy = getCurrentPolicy();
          const allowlisted =
            isToolNameAutoApproved(name, context.autoApprovedTools) ||
            isCommandAutoApproved(name, approvalResult.executeArgs, context.autoApprovedCommands);

          // Whether this surface can actually put the decision in front of a
          // person. Safe mode means "skip the prompts that are not worth
          // asking"; where there is no prompt to skip it has to mean nothing.
          const canPrompt = presentationService.canPromptForApproval?.() === true;

          const commandArg = approvalResult.executeArgs["command"];
          const command = typeof commandArg === "string" ? commandArg : undefined;

          if (
            shouldClassifyExecuteCommand(riskLevel, autoApprovePolicy, allowlisted, canPrompt) &&
            context.parentAgent &&
            command !== undefined
          ) {
            if (displayConfig.showToolExecution) {
              if (renderer) {
                yield* renderer.handleEvent({
                  type: "command_risk_classifying",
                  toolCallId: toolCall.id,
                  toolName: name,
                  command,
                });
              } else {
                yield* presentationService.writeOutput(`Classifying ${name}…\n`);
              }
            }
            classifiedRisk = yield* classifyCommandRisk(
              command,
              context.parentAgent,
              // Conversation context is only evidence when the person the
              // approval protects is the one who wrote it. On a bridge those
              // turns come from whoever is messaging the bot, so the command
              // has to stand on its own.
              canPrompt ? context.conversationMessages : undefined,
              runMetrics,
            );
            riskLevel = classifiedRisk;
          }

          // Check if auto-approve policy allows this tool, per-tool session allowlist,
          // or per-command prefix allowlist matches
          const checkAutoApproved = () =>
            shouldAutoApprove(riskLevel, getCurrentPolicy(), { canPrompt }) ||
            isToolNameAutoApproved(name, context.autoApprovedTools) ||
            isCommandAutoApproved(name, approvalResult.executeArgs, context.autoApprovedCommands);

          // A picker-style request is never auto-approved, under any policy including
          // yolo: there is nothing to approve until somebody picked a row. The
          // companion-bound path skips approval inside the tool itself instead.
          const hasSelectionOptions = (approvalResult.options?.length ?? 0) > 0;
          const isAutoApproved = !hasSelectionOptions && checkAutoApproved();

          if (classifiedRisk !== undefined && displayConfig.showToolExecution) {
            if (renderer) {
              yield* renderer.handleEvent({
                type: "command_risk_classified",
                toolCallId: toolCall.id,
                toolName: name,
                command: command ?? "",
                riskLevel: classifiedRisk,
                autoApproved: isAutoApproved,
              });
            } else {
              const outcome = isAutoApproved ? " · auto-approved" : "";
              yield* presentationService.writeOutput(
                `${name} classified as ${classifiedRisk}${outcome}\n`,
              );
            }
          }

          if (renderer) {
            yield* renderer.handleEvent({
              type: "approval_required",
              toolCallId: toolCall.id,
              toolName: name,
              message: approvalResult.message,
              ...(approvalResult.previewDiff ? { previewDiff: approvalResult.previewDiff } : {}),
              ...(hasSelectionOptions ? { options: approvalResult.options } : {}),
              riskLevel,
              ...(autoApprovePolicy !== undefined
                ? { autoApprovePolicy: String(autoApprovePolicy) }
                : {}),
            });
          }

          if (isAutoApproved) {
            yield* logger.info("Tool auto-approved by policy", {
              toolName: name,
              executeToolName: approvalResult.executeToolName,
              riskLevel,
              autoApprovePolicy,
            });
          } else {
            yield* logger.debug("Tool requires approval, showing approval prompt", {
              toolName: name,
              executeToolName: approvalResult.executeToolName,
              riskLevel,
              autoApprovePolicy,
            });
          }

          // Show approval prompt to user (unless auto-approved).
          // Pass an isAutoApproved callback so the approval queue can re-check
          // at dequeue time — a parallel tool's "always approve" may have
          // updated the shared allowlists while this request was queued.
          // Also re-checks current policy for real-time mode switches.
          const approvalRequest = {
            toolCallId: toolCall.id,
            toolName: name,
            message: approvalResult.message,
            executeToolName: approvalResult.executeToolName,
            executeArgs: approvalResult.executeArgs,
            ...(approvalResult.previewDiff ? { previewDiff: approvalResult.previewDiff } : {}),
            ...(hasSelectionOptions ? { options: approvalResult.options } : {}),
            isAutoApproved: checkAutoApproved,
          };

          // A resumed run already carries the answer a person gave in another process.
          const alreadyAnswered = context.resolvedApprovals?.get(toolCall.id);

          // Parking unwinds the whole run, so it has to happen before anything executes.
          // `parkable` is false for a multi-call batch precisely because siblings may
          // already have run, and replaying them on resume would repeat their effects.
          const shouldPark =
            parkable &&
            !isAutoApproved &&
            alreadyAnswered === undefined &&
            presentationService.canPromptForApproval?.() !== true;

          if (shouldPark) {
            yield* logger.info("Parking run: approval needed and nobody can answer in-process", {
              toolName: name,
              toolCallId: toolCall.id,
            });
            return yield* Effect.fail(
              new RunParkRequested({
                pending: { kind: "tool-approval", request: approvalRequest },
              }),
            );
          }

          const outcome = isAutoApproved
            ? { approved: true as const }
            : (alreadyAnswered ?? (yield* presentationService.requestApproval(approvalRequest)));

          if (renderer) {
            yield* renderer.handleEvent({
              type: "approval_resolved",
              toolCallId: toolCall.id,
              toolName: name,
              approved: outcome.approved,
              auto: isAutoApproved,
            });
          }

          if (outcome.approved) {
            // Handle "always approve this command" choice (execute_command only)
            if (outcome.alwaysApproveCommand && context.onAutoApproveCommand) {
              yield* context.onAutoApproveCommand(outcome.alwaysApproveCommand);
              yield* logger.info("User chose to always approve command", {
                command: outcome.alwaysApproveCommand,
              });
            }

            // Handle "always approve this tool" choice (any approval tool)
            if (outcome.alwaysApproveTool && context.onAutoApproveTool) {
              context.onAutoApproveTool(outcome.alwaysApproveTool);
              yield* logger.info("User chose to always approve tool", {
                toolName: outcome.alwaysApproveTool,
              });
            }

            if (!isAutoApproved) {
              yield* logger.info("User approved tool execution", {
                toolName: name,
                executeToolName: approvalResult.executeToolName,
              });
            }

            // Execute the execution tool. A picker-style outcome carries the row the
            // human chose; it rides to the execution tool under a reserved key the
            // model never writes and cannot spoof.
            const executeArgs =
              "selectedOptionId" in outcome && typeof outcome.selectedOptionId === "string"
                ? { ...approvalResult.executeArgs, _selectedOptionId: outcome.selectedOptionId }
                : approvalResult.executeArgs;
            const executeStartTime = Date.now();

            // Emit execution start for the follow-up tool
            if (displayConfig.showToolExecution) {
              const executeMetadata = yield* resolveToolDisplayMetadata(
                approvalResult.executeToolName,
                context,
              );
              if (renderer) {
                yield* renderer.handleEvent({
                  type: "tool_execution_start",
                  toolName: name,
                  toolCallId: toolCall.id,
                  arguments: executeArgs,
                  ...(executeMetadata ? { metadata: executeMetadata } : {}),
                });
              } else {
                const message = yield* presentationService.formatToolExecutionStart(
                  name,
                  executeArgs,
                  executeMetadata ? { metadata: executeMetadata } : undefined,
                );
                yield* presentationService.writeBlankLine();
                yield* presentationService.writeOutput(message);
              }
            }

            // Execute the actual tool
            result = yield* ToolExecutor.executeTool(
              approvalResult.executeToolName,
              executeArgs,
              context,
            );
            toolDuration = Date.now() - executeStartTime;
            finalToolName = approvalResult.executeToolName;

            yield* logger.debug("Execution tool completed after approval", {
              executeToolName: approvalResult.executeToolName,
              success: result.success,
              durationMs: toolDuration,
              autoApproved: isAutoApproved,
            });
          } else {
            yield* logger.info("User rejected tool execution", {
              toolName: name,
              userMessage: (outcome as { approved: false; userMessage?: string }).userMessage,
            });

            const rejectionMessage =
              (outcome as { approved: false; userMessage?: string }).userMessage?.trim() ||
              "User rejected the operation. Please acknowledge this and ask if they'd like to try something different.";

            result = {
              success: false,
              result: {
                rejected: true,
                message: rejectionMessage,
              },
              error: "User rejected the operation",
            };
          }
        }

        const resultString = JSON.stringify(result.result);

        // Log tool result details for debugging
        yield* logger.debug("Tool execution succeeded", {
          agentId,
          conversationId,
          toolName: finalToolName,
          toolCallId: toolCall.id,
          durationMs: toolDuration,
          success: result.success,
          resultSize: resultString.length,
          resultPreview: resultString.substring(0, 200),
        });

        // Emit tool execution complete
        if (displayConfig.showToolExecution) {
          if (renderer) {
            yield* renderer.handleEvent({
              type: "tool_execution_complete",
              toolCallId: toolCall.id,
              result: resultString,
              durationMs: toolDuration,
              success: result.success,
              ...(result.success ? {} : { error: result.error ?? "Tool execution failed" }),
              ...(classifiedRisk !== undefined ? { classifiedRisk } : {}),
            });
          } else {
            if (result.success) {
              const summary = presentationService.formatToolResult(finalToolName, resultString);
              const message = yield* presentationService.formatToolExecutionComplete(
                summary,
                toolDuration,
              );
              yield* presentationService.writeOutput(message);
            } else {
              const errorMsg = result.error || "Tool execution failed";
              const message = yield* presentationService.formatToolExecutionError(
                errorMsg,
                toolDuration,
              );
              yield* presentationService.writeOutput(message);
            }
          }
        }

        // Now that this tool has finished and its result has been rendered,
        // release the next queued approval prompt — so approvals and results
        // never interleave (approve → run → result → approve). No-op unless an
        // approval is waiting.
        yield* presentationService.signalToolExecutionStarted();

        yield* emitToolInvocation(runMetrics, {
          toolName: finalToolName,
          success: result.success,
          durationMs: toolDuration,
          ...(result.success ? {} : { error: result.error ?? "Tool execution failed" }),
        });

        const finalResult = result.success
          ? result.result
          : { error: result.error ?? "Tool execution failed", result: result.result };
        return {
          toolCallId: toolCall.id,
          result: finalResult,
          success: result.success,
          name: finalToolName,
        };
      } catch (error) {
        const toolDuration = Date.now() - toolStartTime;
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Emit error
        if (displayConfig.showToolExecution) {
          if (renderer) {
            yield* renderer.handleEvent({
              type: "tool_execution_complete",
              toolCallId: toolCall.id,
              result: `Error: ${errorMessage}`,
              durationMs: toolDuration,
              success: false,
              error: errorMessage,
            });
          } else {
            const message = yield* presentationService.formatToolExecutionError(
              errorMessage,
              toolDuration,
            );
            yield* presentationService.writeOutput(message);
          }
        }

        recordToolError(runMetrics, name, error);
        yield* emitToolInvocation(runMetrics, {
          toolName: name,
          success: false,
          durationMs: toolDuration,
          error,
        });
        yield* logger.error("Tool execution failed", {
          agentId,
          conversationId,
          toolName: name,
          toolCallId: toolCall.id,
          error: errorMessage,
        });

        // Release the next queued approval after this failure too, so a failed
        // tool doesn't stall the approval queue.
        yield* presentationService.signalToolExecutionStarted();

        return {
          toolCallId: toolCall.id,
          result: { error: errorMessage },
          success: false,
          name,
        };
      }
    });
  }

  /**
   * Execute all tool calls and return results
   */
  static executeToolCalls(
    toolCalls: readonly ToolCall[],
    context: ToolExecutionContext,
    displayConfig: DisplayConfig,
    renderer: StreamingRenderer | null,
    runMetrics: ReturnType<typeof createAgentRunMetrics>,
    agentId: string,
    conversationId: string,
    agentName: string,
    interruptSignal?: Effect.Effect<void, never>,
  ): Effect.Effect<
    Array<{ toolCallId: string; result: unknown; name: string; success: boolean }>,
    Error,
    | ToolRegistry
    | LoggerService
    | AgentConfigService
    | ToolRequirements
    | PresentationService
    | LLMService
  > {
    return Effect.gen(function* () {
      const presentationService = yield* PresentationServiceTag;
      const logger = yield* LoggerServiceTag;
      const registry = yield* ToolRegistryTag;
      const toolNames = toolCalls.map((tc) => tc.function.name);

      // Fetch tool information to determine which require approval.
      // Do this in parallel so large tool batches don't pay a sequential pre-pass.
      const uniqueToolNames = Array.from(new Set(toolNames));
      const toolResults = yield* Effect.all(
        uniqueToolNames.map((toolName) => Effect.either(registry.getTool(toolName))),
        { concurrency: MAX_CONCURRENT_TOOLS },
      );
      const approvalToolNameSet = new Set<string>();
      for (let i = 0; i < uniqueToolNames.length; i++) {
        const uniqueToolName = uniqueToolNames[i];
        const toolResult = toolResults[i];
        if (
          uniqueToolName &&
          toolResult &&
          Either.isRight(toolResult) &&
          toolResult.right.approvalExecuteToolName
        ) {
          approvalToolNameSet.add(uniqueToolName);
        }
      }
      const toolsRequiringApproval = toolNames.filter((toolName) =>
        approvalToolNameSet.has(toolName),
      );

      // Show tools detected
      if (displayConfig.showToolExecution) {
        if (renderer) {
          yield* renderer.handleEvent({
            type: "tools_detected",
            toolNames,
            toolsRequiringApproval,
            agentName,
          });
        } else {
          const message = yield* presentationService.formatToolsDetected(
            agentName,
            toolNames,
            toolsRequiringApproval,
          );
          yield* presentationService.writeOutput(message);
        }
      }

      // Log tool details
      const toolDetails: string[] = [];
      for (const toolCall of toolCalls) {
        if (toolCall.type === "function") {
          const { name, arguments: argsString } = toolCall.function;
          try {
            const parsed: unknown = JSON.parse(argsString);
            const args: Record<string, unknown> =
              parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : {};
            const argsText = formatToolArguments(name, args, { style: "plain" });
            toolDetails.push(argsText ? `${name} ${argsText}` : name);
          } catch {
            toolDetails.push(name);
          }
        }
      }
      const toolsList = toolDetails.join(", ");
      yield* logger.info(`${agentName} is using tools: ${toolsList}`);

      const approvalSet = new Set(toolsRequiringApproval);
      // Only a lone tool call can park. In a batch a sibling may already have executed, and
      // resuming replays the batch — which would repeat that sibling's effects.
      const parkable = context.parkWhenUnattended === true && toolCalls.length === 1;

      // Limit concurrency to prevent resource exhaustion when many tools are requested
      const toolFibers = yield* Effect.all(
        toolCalls.map((toolCall) =>
          Effect.fork(
            ToolExecutor.executeToolCall(
              toolCall,
              context,
              displayConfig,
              renderer,
              runMetrics,
              agentId,
              conversationId,
              approvalSet,
              parkable,
            ),
          ),
        ),
        { concurrency: MAX_CONCURRENT_TOOLS },
      );

      const awaitResults = Effect.all(
        toolFibers.map((fiber) => Fiber.join(fiber)),
        { concurrency: "unbounded" },
      );

      if (!interruptSignal) {
        return yield* awaitResults;
      }

      const resultsOrInterrupt = yield* Effect.race(
        awaitResults.pipe(Effect.map((results) => ({ type: "results" as const, results }))),
        interruptSignal.pipe(Effect.as({ type: "interrupt" as const })),
      );

      if (resultsOrInterrupt.type === "interrupt") {
        // Settle the UI before waiting on fiber interrupt: execute_command used
        // to wrap spawn in Effect.promise, which is uninterruptible, so this
        // wait could block until the child exited — leaving the 30s "still
        // running" timer armed across the next turn.
        if (renderer && displayConfig.showToolExecution) {
          for (let index = 0; index < toolFibers.length; index++) {
            const fiber = toolFibers[index];
            const toolCall = toolCalls[index];
            if (fiber === undefined || toolCall === undefined || toolCall.type !== "function") {
              continue;
            }
            const poll = yield* Fiber.poll(fiber);
            if (Option.isNone(poll) || (Option.isSome(poll) && Exit.isInterrupted(poll.value))) {
              yield* renderer.handleEvent({
                type: "tool_execution_complete",
                toolCallId: toolCall.id,
                result: "Interrupted by user",
                durationMs: 0,
                success: false,
                error: "Interrupted by user",
              });
            }
          }
        }
        yield* Effect.all(
          toolFibers.map((fiber) => Fiber.interrupt(fiber)),
          { concurrency: "unbounded" },
        );
        return yield* Effect.fail(
          new GenerationInterruptedError({ reason: "Tool execution interrupted by user" }),
        );
      }

      return resultsOrInterrupt.results;
    });
  }
}

/**
 * Check if a command is auto-approved via the per-command allowlist.
 * Only applies to `execute_command` tools; returns false for all others.
 *
 * Compares the extracted approval key (binary + first subcommand token) against
 * the allowlist using exact or word-boundary matching only — never raw prefix
 * matching on the full command string, which would allow "git status && rm -rf /"
 * to match an approved "git status" entry.
 */
function isCommandAutoApproved(
  toolName: string,
  executeArgs: Record<string, unknown>,
  allowedCommands: readonly string[] | undefined,
): boolean {
  if (!allowedCommands?.length) return false;
  if (toolName !== "execute_command") return false;
  const command = executeArgs["command"];
  if (typeof command !== "string") return false;
  const commandKey = extractCommandApprovalKey(command);
  return allowedCommands.some(
    (allowed) => commandKey === allowed || commandKey.startsWith(allowed + " "),
  );
}

/**
 * Check if a tool is auto-approved via the per-tool allowlist.
 * Matches the approval tool name (e.g. "edit_file") against the session list.
 */
function isToolNameAutoApproved(
  toolName: string,
  approvedTools: readonly string[] | undefined,
): boolean {
  if (!approvedTools?.length) return false;
  return approvedTools.includes(toolName);
}
