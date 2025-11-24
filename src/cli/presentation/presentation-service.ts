import chalk from "chalk";
import { Effect, Layer } from "effect";
import type {
  PresentationService,
  StreamingRenderer,
  StreamingRendererConfig,
} from "../../core/interfaces/presentation";
import { PresentationServiceTag } from "../../core/interfaces/presentation";
import type { StreamEvent } from "../../core/types/llm";
import { MarkdownRenderer } from "./markdown-renderer";
import { OutputRenderer, type OutputRendererConfig } from "./output-renderer";

/**
 * CLI implementation of PresentationService
 * Provides terminal-based presentation for agent output
 */
class CLIPresentationService implements PresentationService {
  formatThinking(agentName: string, isFirstIteration: boolean): Effect.Effect<string, never> {
    return Effect.sync(() => MarkdownRenderer.formatThinking(agentName, isFirstIteration));
  }

  formatCompletion(agentName: string): Effect.Effect<string, never> {
    return Effect.sync(() => MarkdownRenderer.formatCompletion(agentName));
  }

  formatWarning(agentName: string, message: string): Effect.Effect<string, never> {
    return Effect.sync(() => MarkdownRenderer.formatWarning(agentName, message));
  }

  formatAgentResponse(agentName: string, content: string): Effect.Effect<string, never> {
    return Effect.sync(() => MarkdownRenderer.formatAgentResponse(agentName, content));
  }

  renderMarkdown(markdown: string): Effect.Effect<string, never> {
    return Effect.sync(() => MarkdownRenderer.render(markdown));
  }

  formatToolArguments(toolName: string, args?: Record<string, unknown>): string {
    return OutputRenderer.formatToolArguments(toolName, args);
  }

  formatToolResult(toolName: string, result: string): string {
    return OutputRenderer.formatToolResult(toolName, result);
  }

  formatToolExecutionStart(
    toolName: string,
    args?: Record<string, unknown>,
  ): Effect.Effect<string, never> {
    return Effect.sync(() => {
      const argsStr = this.formatToolArguments(toolName, args);
      return `\n${chalk.cyan("⚙️")}  Executing tool: ${chalk.cyan(toolName)}${argsStr}...`;
    });
  }

  formatToolExecutionComplete(
    summary: string | null,
    durationMs: number,
  ): Effect.Effect<string, never> {
    return Effect.sync(() => {
      return ` ${chalk.green("✓")}${summary ? ` ${summary}` : ""} ${chalk.dim(`(${durationMs}ms)`)}\n`;
    });
  }

  formatToolExecutionError(errorMessage: string, durationMs: number): Effect.Effect<string, never> {
    return Effect.sync(() => {
      return ` ${chalk.red("✗")} ${chalk.red(`(${errorMessage})`)} ${chalk.dim(`(${durationMs}ms)`)}\n`;
    });
  }

  formatToolsDetected(
    agentName: string,
    toolNames: readonly string[],
  ): Effect.Effect<string, never> {
    return Effect.sync(() => {
      const tools = toolNames.join(", ");
      return `\n${chalk.yellow("🔧")} ${chalk.yellow(agentName)} is using tools: ${chalk.cyan(tools)}\n`;
    });
  }

  createStreamingRenderer(
    config: StreamingRendererConfig,
  ): Effect.Effect<StreamingRenderer, never> {
    return Effect.sync(() => {
      const rendererConfig: OutputRendererConfig = {
        displayConfig: config.displayConfig,
        streamingConfig: config.streamingConfig,
        showMetrics: config.showMetrics,
        agentName: config.agentName,
        reasoningEffort: config.reasoningEffort,
      };
      const renderer = new OutputRenderer(rendererConfig);
      const streamingRenderer: StreamingRenderer = {
        handleEvent: (event: StreamEvent): Effect.Effect<void, never> =>
          renderer.handleEvent(event),
        reset: (): Effect.Effect<void, never> => renderer.reset(),
        flush: (): Effect.Effect<void, never> => renderer.flush(),
      };
      return streamingRenderer;
    });
  }

  writeOutput(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      process.stdout.write(message);
    });
  }

  writeBlankLine(): Effect.Effect<void, never> {
    return Effect.sync(() => {
      console.log();
    });
  }
}

/**
 * Layer providing the CLI presentation service
 */
export const CLIPresentationServiceLayer = Layer.succeed(
  PresentationServiceTag,
  new CLIPresentationService(),
);
