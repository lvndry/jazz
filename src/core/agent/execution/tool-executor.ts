import { Effect } from "effect";
import { type AgentConfigService } from "../../interfaces/agent-config";
import { LoggerServiceTag, type LoggerService } from "../../interfaces/logger";
import {
  PresentationServiceTag,
  type PresentationService,
  type StreamingRenderer,
} from "../../interfaces/presentation";
import {
  ToolRegistryTag,
  type ToolRegistry,
  type ToolRequirements,
} from "../../interfaces/tool-registry";
import type { DisplayConfig } from "../../types/output";
import type { ToolCall, ToolExecutionContext, ToolExecutionResult } from "../../types/tools";
import { formatToolArguments } from "../../utils/tool-formatter";
import {
  recordToolError,
  recordToolInvocation,
  type createAgentRunTracker,
} from "../tracking/agent-run-tracker";

/**
 * Service for executing tools
 */
export class ToolExecutor {
  /**
   * Execute a tool by name with the provided arguments
   */
  static executeTool(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Effect.Effect<
    ToolExecutionResult,
    Error,
    ToolRegistry | LoggerService | AgentConfigService | ToolRequirements
  > {
    return Effect.gen(function* () {
      const registry = yield* ToolRegistryTag;
      return yield* registry.executeTool(name, args, context);
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
    runTracker: ReturnType<typeof createAgentRunTracker>,
    agentId: string,
    conversationId: string,
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
      recordToolInvocation(runTracker, name);
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

        // Emit tool execution start
        if (displayConfig.showToolExecution) {
          if (renderer) {
            yield* renderer.handleEvent({
              type: "tool_execution_start",
              toolName: name,
              toolCallId: toolCall.id,
              arguments: args,
            });
          } else {
            const message = yield* presentationService.formatToolExecutionStart(name, args);
            yield* presentationService.writeOutput(message);
          }
        }

        // Execute tool
        const result = yield* ToolExecutor.executeTool(name, args, context);
        const toolDuration = Date.now() - toolStartTime;
        const resultString = JSON.stringify(result.result);

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
              const summary = presentationService.formatToolResult(name, resultString);
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

        return { toolCallId: toolCall.id, result: result.result, success: result.success, name };
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

        recordToolError(runTracker, name, error);
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
    runTracker: ReturnType<typeof createAgentRunTracker>,
    agentId: string,
    conversationId: string,
    agentName: string,
  ): Effect.Effect<
    Array<{ toolCallId: string; result: unknown; name: string; success: boolean }>,
    Error,
    ToolRegistry | LoggerService | AgentConfigService | ToolRequirements | PresentationService
  > {
    return Effect.gen(function* () {
      const presentationService = yield* PresentationServiceTag;
      const logger = yield* LoggerServiceTag;
      const toolNames = toolCalls.map((tc) => tc.function.name);

      // Show tools detected
      if (displayConfig.showToolExecution) {
        if (renderer) {
          yield* renderer.handleEvent({
            type: "tools_detected",
            toolNames,
            agentName,
          });
        } else {
          const message = yield* presentationService.formatToolsDetected(agentName, toolNames);
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

      return yield* Effect.all(
        toolCalls.map((toolCall) =>
          ToolExecutor.executeToolCall(
            toolCall,
            context,
            displayConfig,
            renderer,
            runTracker,
            agentId,
            conversationId,
          ),
        ),
        { concurrency: "unbounded" },
      );
    });
  }
}
