import chalk from "chalk";
import { Effect, Layer } from "effect";
import { Box, Text } from "ink";
import React from "react";
import type {
  PresentationService,
  StreamingRenderer,
  StreamingRendererConfig,
} from "../../core/interfaces/presentation";
import { PresentationServiceTag } from "../../core/interfaces/presentation";
import { ink } from "../../core/interfaces/terminal";
import type { StreamEvent } from "../../core/types/streaming";
import { AgentResponseCard } from "../ui/AgentResponseCard";
import { store } from "../ui/App";
import { CLIRenderer, type CLIRendererConfig } from "./cli-renderer";
import { formatMarkdownAnsi } from "./markdown-ansi";

function renderToolBadge(label: string): React.ReactElement {
  return React.createElement(
    Box,
    { borderStyle: "round", borderColor: "cyan", paddingX: 1 },
    React.createElement(Text, { color: "cyan" }, label),
  );
}

class InkStreamingRenderer implements StreamingRenderer {
  private readonly activeTools = new Map<string, string>();
  private liveText: string = "";
  private reasoningBuffer: string = "";
  private lastAgentHeaderWritten: boolean = false;
  private lastFormattedText: string = "";
  private lastFormattedReasoning: string = "";

  constructor(
    private readonly agentName: string,
    private readonly showMetrics: boolean,
  ) {}

  reset(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      this.activeTools.clear();
      this.liveText = "";
      this.reasoningBuffer = "";
      this.lastAgentHeaderWritten = false;
      this.lastFormattedText = "";
      this.lastFormattedReasoning = "";
      store.setStatus(null);
      store.setStream(null);
    });
  }

  flush(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      if (this.liveText.trim().length > 0) {
        store.addLog({ type: "log", message: this.liveText, timestamp: new Date() });
      }
      this.liveText = "";
      store.setStream(null);
    });
  }

  handleEvent(event: StreamEvent): Effect.Effect<void, never> {
    return Effect.sync(() => {
      switch (event.type) {
        case "stream_start": {
          this.lastAgentHeaderWritten = true;
          store.addLog({
            type: "info",
            message: `${this.agentName} (${event.provider}/${event.model})`,
            timestamp: new Date(),
          });
          return;
        }

        case "thinking_start": {
          this.reasoningBuffer = "";
          this.updateLiveStream(false);
          store.setStatus(`${this.agentName} is thinking…`);
          return;
        }

        case "thinking_chunk": {
          this.reasoningBuffer += event.content;
          this.updateLiveStream();
          return;
        }

        case "thinking_complete": {
          // Keep status if tools are running; otherwise clear.
          if (this.activeTools.size === 0) {
            store.setStatus(null);
          }
          this.logReasoning();
          this.reasoningBuffer = "";
          this.lastFormattedReasoning = "";
          this.updateLiveStream(false);
          return;
        }

        case "tools_detected": {
          const approvalSet = new Set(event.toolsRequiringApproval as readonly string[]);
          const formattedTools = event.toolNames
            .map((name) => {
              if (approvalSet.has(name)) {
                return `${name} (requires approval)`;
              }
              return name;
            })
            .join(", ");
          store.addLog({
            type: "info",
            message: ink(renderToolBadge(`Tools: ${formattedTools}`)),
            timestamp: new Date(),
          });
          return;
        }

        case "tool_call": {
          store.addLog({
            type: "debug",
            message: `Tool call detected: ${event.toolCall.function.name}`,
            timestamp: new Date(),
          });
          return;
        }

        case "tool_execution_start": {
          this.activeTools.set(event.toolCallId, event.toolName);
          store.setStatus(this.formatToolStatus());
          const argsStr = CLIRenderer.formatToolArguments(event.toolName, event.arguments);
          const message = argsStr
            ? `⚙️  Executing tool: ${event.toolName}${argsStr}`
            : `⚙️  Executing tool: ${event.toolName}`;
          store.addLog({
            type: "log",
            message,
            timestamp: new Date(),
          });
          return;
        }

        case "tool_execution_complete": {
          const toolName = this.activeTools.get(event.toolCallId);
          this.activeTools.delete(event.toolCallId);

          const namePrefix = toolName ? `${toolName} ` : "";
          const summary = event.summary?.trim().length ? event.summary : namePrefix + "done";

          store.addLog({
            type: "success",
            message: `${summary} (${event.durationMs}ms)`,
            timestamp: new Date(),
          });

          store.setStatus(this.activeTools.size > 0 ? this.formatToolStatus() : null);
          return;
        }

        case "text_start": {
          this.liveText = "";
          this.updateLiveStream(false);
          return;
        }

        case "text_chunk": {
          this.liveText = event.accumulated;
          this.updateLiveStream();
          return;
        }

        case "usage_update": {
          return;
        }

        case "error": {
          store.addLog({
            type: "error",
            message: `Error: ${event.error.message}`,
            timestamp: new Date(),
          });
          store.setStatus(null);
          store.setStream(null);
          return;
        }

        case "complete": {
          // If streaming never started (fallback), we may still want to show the response.
          if (!this.lastAgentHeaderWritten) {
            store.addLog({
              type: "info",
              message: this.agentName,
              timestamp: new Date(),
            });
          }

          const finalText =
            this.liveText.trim().length > 0
              ? this.liveText
              : event.response.content.trim().length > 0
                ? event.response.content
                : "";
          const formattedFinalText = formatMarkdownAnsi(finalText);

          if (formattedFinalText.length > 0) {
            store.addLog({
              type: "log",
              message: ink(
                React.createElement(AgentResponseCard, {
                  agentName: this.agentName,
                  content: formattedFinalText,
                }),
              ),
              timestamp: new Date(),
            });
          }

          if (this.showMetrics && event.metrics) {
            const parts: string[] = [];
            if (event.metrics.firstTokenLatencyMs) {
              parts.push(`First token: ${event.metrics.firstTokenLatencyMs}ms`);
            }
            if (event.metrics.tokensPerSecond) {
              parts.push(`Speed: ${event.metrics.tokensPerSecond.toFixed(1)} tok/s`);
            }
            if (event.metrics.totalTokens) {
              parts.push(`Total: ${event.metrics.totalTokens} tokens`);
            }
            if (parts.length > 0) {
              store.addLog({
                type: "debug",
                message: `[${parts.join(" | ")}]`,
                timestamp: new Date(),
              });
            }
          }

          store.setStatus(null);
          store.setStream(null);
          this.liveText = "";
          this.lastFormattedText = "";
          this.lastFormattedReasoning = "";
          return;
        }
      }
    }).pipe(Effect.catchAll(() => Effect.void));
  }

  private formatToolStatus(): string {
    const uniqueToolNames = Array.from(new Set(this.activeTools.values()));
    if (uniqueToolNames.length === 0) return "Working…";
    if (uniqueToolNames.length === 1) return `Running ${uniqueToolNames[0]}…`;
    return `Running ${uniqueToolNames.length} tools… (${uniqueToolNames.join(", ")})`;
  }

  private updateLiveStream(includeReasoning: boolean = true): void {
    const formattedText = formatMarkdownAnsi(this.liveText);
    const shouldShowReasoning = includeReasoning && this.reasoningBuffer.trim().length > 0;
    const formattedReasoning = shouldShowReasoning ? formatMarkdownAnsi(this.reasoningBuffer) : "";

    // Only update if the formatted content actually changed
    // This prevents unnecessary re-renders that cause blinking
    if (
      formattedText !== this.lastFormattedText ||
      formattedReasoning !== this.lastFormattedReasoning
    ) {
      this.lastFormattedText = formattedText;
      this.lastFormattedReasoning = formattedReasoning;
      store.setStream({
        agentName: this.agentName,
        text: formattedText,
        reasoning: formattedReasoning,
      });
    }
  }

  private logReasoning(): void {
    const reasoning = this.reasoningBuffer.trim();
    if (reasoning.length === 0) {
      return;
    }
    const formattedReasoning = formatMarkdownAnsi(reasoning);
    store.addLog({
      type: "log",
      message: `\n🧠 Reasoning:\n${chalk.gray(formattedReasoning)}`,
      timestamp: new Date(),
    });
  }
}

/**
 * Ink implementation of PresentationService.
 *
 * Critical: does NOT write to stdout directly (which would clobber Ink rendering).
 * Instead, it pushes output into the Ink store.
 */
class InkPresentationService implements PresentationService {
  private renderer: CLIRenderer | null = null;

  private getRenderer(): CLIRenderer {
    if (!this.renderer) {
      const config: CLIRendererConfig = {
        displayConfig: {
          mode: "markdown",
          showThinking: false,
          showToolExecution: false,
        },
        streamingConfig: {},
        showMetrics: false,
        agentName: "Agent",
      };
      this.renderer = new CLIRenderer(config);
    }
    return this.renderer;
  }

  presentThinking(agentName: string, isFirstIteration: boolean): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      const msg = yield* this.getRenderer().formatThinking(agentName, isFirstIteration);
      // For non-streaming, we just log the thinking message
      // We could also set status, but checking strict parity with existing behavior first
      store.addLog({ type: "info", message: msg, timestamp: new Date() });
    });
  }

  presentCompletion(agentName: string): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      const msg = yield* this.getRenderer().formatCompletion(agentName);
      store.addLog({ type: "info", message: msg, timestamp: new Date() });
    });
  }

  presentWarning(agentName: string, message: string): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      const msg = yield* this.getRenderer().formatWarning(agentName, message);
      store.addLog({ type: "warn", message: msg, timestamp: new Date() });
    });
  }

  presentAgentResponse(agentName: string, content: string): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      const formatted = yield* this.getRenderer().formatAgentResponse(agentName, content);
      store.addLog({
        type: "log", // 'log' type uses default coloring (white/reset) which allows ANSI codes to shine
        message: formatted,
        timestamp: new Date(),
      });
    });
  }

  renderMarkdown(markdown: string): Effect.Effect<string, never> {
    return this.getRenderer().renderMarkdown(markdown);
  }

  formatToolArguments(toolName: string, args?: Record<string, unknown>): string {
    return CLIRenderer.formatToolArguments(toolName, args);
  }

  formatToolResult(toolName: string, result: string): string {
    return CLIRenderer.formatToolResult(toolName, result);
  }

  formatToolExecutionStart(
    toolName: string,
    args?: Record<string, unknown>,
  ): Effect.Effect<string, never> {
    return Effect.sync(() => {
      const argsStr = this.formatToolArguments(toolName, args);
      return argsStr;
    }).pipe(
      Effect.flatMap((argsStr) => this.getRenderer().formatToolExecutionStart(toolName, argsStr)),
    );
  }

  formatToolExecutionComplete(
    summary: string | null,
    durationMs: number,
  ): Effect.Effect<string, never> {
    return this.getRenderer().formatToolExecutionComplete(summary, durationMs);
  }

  formatToolExecutionError(errorMessage: string, durationMs: number): Effect.Effect<string, never> {
    return this.getRenderer().formatToolExecutionError(errorMessage, durationMs);
  }

  formatToolsDetected(
    agentName: string,
    toolNames: readonly string[],
    toolsRequiringApproval: readonly string[],
  ): Effect.Effect<string, never> {
    return this.getRenderer().formatToolsDetected(agentName, toolNames, toolsRequiringApproval);
  }

  createStreamingRenderer(
    config: StreamingRendererConfig,
  ): Effect.Effect<StreamingRenderer, never> {
    return Effect.sync(() => {
      return new InkStreamingRenderer(config.agentName, config.showMetrics);
    });
  }

  writeOutput(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      store.addLog({ type: "log", message, timestamp: new Date() });
    });
  }

  writeBlankLine(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      store.addLog({ type: "log", message: "", timestamp: new Date() });
    });
  }
}

export const InkPresentationServiceLayer = Layer.effect(
  PresentationServiceTag,
  Effect.sync(() => new InkPresentationService()),
);
