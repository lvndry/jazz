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
  private lastAgentHeaderWritten: boolean = false;

  constructor(
    private readonly agentName: string,
    private readonly showMetrics: boolean,
  ) {}

  reset(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      this.activeTools.clear();
      this.liveText = "";
      this.lastAgentHeaderWritten = false;
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
          store.setStatus(`${this.agentName} is thinking…`);
          return;
        }

        case "thinking_complete": {
          // Keep status if tools are running; otherwise clear.
          if (this.activeTools.size === 0) {
            store.setStatus(null);
          }
          return;
        }

        case "tools_detected": {
          const tools = event.toolNames.join(", ");
          store.addLog({
            type: "info",
            message: ink(renderToolBadge(`Tools: ${tools}`)),
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
          store.addLog({
            type: "log",
            message: `⚙️  Executing tool: ${event.toolName}`,
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
          store.setStream({ agentName: this.agentName, text: "" });
          return;
        }

        case "text_chunk": {
          this.liveText = event.accumulated;
          store.setStream({ agentName: this.agentName, text: event.accumulated });
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

          if (finalText.length > 0) {
            store.addLog({
              type: "log",
              message: ink(
                React.createElement(AgentResponseCard, {
                  agentName: this.agentName,
                  content: finalText,
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
              store.addLog({ type: "debug", message: `[${parts.join(" | ")}]`, timestamp: new Date() });
            }
          }

          store.setStatus(null);
          store.setStream(null);
          this.liveText = "";
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

  formatThinking(agentName: string, isFirstIteration: boolean): Effect.Effect<string, never> {
    return this.getRenderer().formatThinking(agentName, isFirstIteration);
  }

  formatCompletion(agentName: string): Effect.Effect<string, never> {
    return this.getRenderer().formatCompletion(agentName);
  }

  formatWarning(agentName: string, message: string): Effect.Effect<string, never> {
    return this.getRenderer().formatWarning(agentName, message);
  }

  formatAgentResponse(agentName: string, content: string): Effect.Effect<string, never> {
    // We keep the legacy formatter (chalk/marked-terminal) so markdown looks decent,
    // but we *display* it inside Ink by logging the resulting string.
    return this.getRenderer().formatAgentResponse(agentName, content);
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
  ): Effect.Effect<string, never> {
    return this.getRenderer().formatToolsDetected(agentName, toolNames);
  }

  createStreamingRenderer(config: StreamingRendererConfig): Effect.Effect<StreamingRenderer, never> {
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

