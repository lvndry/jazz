import { Effect, Either, Fiber } from "effect";
import { MAX_CONCURRENT_TOOLS, TOOL_TIMEOUT_MS } from "@/core/constants/agent";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
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
} from "@/core/types/tools";
import { formatToolArguments } from "@/core/utils/tool-formatter";
import {
  recordToolError,
  recordToolInvocation,
  type createAgentRunMetrics,
} from "../metrics/agent-run-metrics";

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
      if (timeoutMs === undefined) {
        const toolMeta = yield* registry.getTool(name).pipe(
          Effect.catchAll(() => Effect.succeed(undefined)),
        );
        timeoutMs = toolMeta?.timeoutMs ?? TOOL_TIMEOUT_MS;
      }
      const timeoutMinutes = Math.round(timeoutMs / 60000);
      const result = yield* registry.executeTool(name, args, context).pipe(
        Effect.timeoutFail({
          duration: timeoutMs,
          onTimeout: () =>
            new Error(
              `Tool '${name}' timed out after ${timeoutMinutes} minutes. The operation took too long to complete.`,
            ),
        }),
        Effect.catchAll((error) => {
          if (error instanceof Error && error.message.includes("timed out")) {
            void logger.warn(`Tool timeout: ${error.message}`);
          }
          return Effect.fail(error);
        }),
      );

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
  ): Effect.Effect<
    { toolCallId: string; result: unknown; success: boolean; name: string },
    Error,
    ToolRegistry | LoggerService | AgentConfigService | ToolRequirements | PresentationService
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
          );
        }

        const args: Record<string, unknown> =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};

        yield* logger.logToolCall(name, args);

        // Look up tool metadata for UI hints
        const registry = yield* ToolRegistryTag;
        const toolMeta = yield* registry.getTool(name).pipe(
          Effect.catchAll(() => Effect.succeed(undefined)),
        );
        const isLongRunning = toolMeta?.longRunning === true;

        // Emit tool execution start - skip for approval tools to avoid interleaving with
        // approval UI when multiple tools run in parallel (approval wrapper returns
        // immediately; the real "Executing tool" is emitted after user approval)
        const isApprovalTool = toolsRequiringApproval.has(name);
        if (displayConfig.showToolExecution && !isApprovalTool) {
          // Build metadata for specific tools (e.g., web_search provider)
          let metadata: Record<string, unknown> | undefined;
          if (name === "web_search") {
            const configService = yield* AgentConfigServiceTag;
            const appConfig = yield* configService.appConfig;
            const provider = appConfig.web_search?.provider;
            metadata = { provider: provider ?? "builtin" };
          }
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
            const message = yield* presentationService.formatToolExecutionStart(name, args);
            yield* presentationService.writeBlankLine();
            yield* presentationService.writeOutput(message);
          }
        }

        // Execute tool — pass pre-fetched timeout to avoid redundant getTool lookup
        let result = yield* ToolExecutor.executeTool(name, args, context, toolMeta?.timeoutMs);
        let toolDuration = Date.now() - toolStartTime;
        let finalToolName = name;

        // Check if this result requires approval (Cursor/Claude-style approval flow)
        // If so, we intercept here, show approval UI (or auto-approve), and execute the follow-up tool
        if (isApprovalRequiredResult(result.result)) {
          const approvalResult = result.result;
          const registry = yield* ToolRegistryTag;

          // Get the tool's risk level to check against auto-approve policy
          const toolInfo = yield* registry.getTool(name).pipe(
            Effect.catchAll(() => Effect.succeed({ riskLevel: "high-risk" as const })),
          );
          const riskLevel = toolInfo.riskLevel;
          const autoApprovePolicy = context.autoApprovePolicy;

          // Check if auto-approve policy allows this tool, or if per-command allowlist matches
          const isAutoApproved = shouldAutoApprove(riskLevel, autoApprovePolicy)
            || isCommandAutoApproved(name, approvalResult.executeArgs, context.autoApprovedCommands);

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

          // Show approval prompt to user (unless auto-approved)
          const outcome = isAutoApproved
            ? { approved: true as const }
            : yield* presentationService.requestApproval({
                toolName: name,
                message: approvalResult.message,
                executeToolName: approvalResult.executeToolName,
                executeArgs: approvalResult.executeArgs,
                ...(approvalResult.previewDiff ? { previewDiff: approvalResult.previewDiff } : {}),
              });

          if (outcome.approved) {
            // Handle "always approve this command" choice
            if (outcome.alwaysApproveCommand && context.onAutoApproveCommand) {
              context.onAutoApproveCommand(outcome.alwaysApproveCommand);
              yield* logger.info("User chose to always approve command", {
                command: outcome.alwaysApproveCommand,
              });
            }

            if (!isAutoApproved) {
              yield* logger.info("User approved tool execution", {
                toolName: name,
                executeToolName: approvalResult.executeToolName,
              });
            }

            // Execute the execution tool
            const executeStartTime = Date.now();

            // Emit execution start for the follow-up tool
            if (displayConfig.showToolExecution) {
              if (renderer) {
                yield* renderer.handleEvent({
                  type: "tool_execution_start",
                  toolName: approvalResult.executeToolName,
                  toolCallId: toolCall.id,
                  arguments: approvalResult.executeArgs,
                });
              } else {
                const message = yield* presentationService.formatToolExecutionStart(
                  approvalResult.executeToolName,
                  approvalResult.executeArgs,
                );
                yield* presentationService.writeBlankLine();
                yield* presentationService.writeOutput(message);
              }
            }

            // Signal that tool execution has started (allows next approval to proceed)
            yield* presentationService.signalToolExecutionStarted();

            // Execute the actual tool
            result = yield* ToolExecutor.executeTool(
              approvalResult.executeToolName,
              approvalResult.executeArgs,
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

        const finalResult = result.success
          ? result.result
          : { error: result.error ?? "Tool execution failed", result: result.result };
        return { toolCallId: toolCall.id, result: finalResult, success: result.success, name: finalToolName };
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
        yield* logger.error("Tool execution failed", {
          agentId,
          conversationId,
          toolName: name,
          toolCallId: toolCall.id,
          error: errorMessage,
        });

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
    ToolRegistry | LoggerService | AgentConfigService | ToolRequirements | PresentationService
  > {
    return Effect.gen(function* () {
      const presentationService = yield* PresentationServiceTag;
      const logger = yield* LoggerServiceTag;
      const registry = yield* ToolRegistryTag;
      const toolNames = toolCalls.map((tc) => tc.function.name);

      // Fetch tool information to determine which require approval
      const toolsRequiringApproval: string[] = [];
      for (const toolName of toolNames) {
        const toolResult = yield* Effect.either(registry.getTool(toolName));
        if (Either.isRight(toolResult)) {
          const tool = toolResult.right;
          if (tool.approvalExecuteToolName) {
            toolsRequiringApproval.push(toolName);
          }
        }
      }

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
  return allowedCommands.some((allowed) => command === allowed);
}
