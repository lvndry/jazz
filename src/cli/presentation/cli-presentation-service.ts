import { Effect, Layer } from "effect";
import type {
  PresentationService,
  StreamingRenderer,
  StreamingRendererConfig,
} from "../../core/interfaces/presentation";
import { PresentationServiceTag } from "../../core/interfaces/presentation";
import type { StreamEvent } from "../../core/types/streaming";
import { CLIRenderer, type CLIRendererConfig } from "./cli-renderer";

/**
 * CLI implementation of PresentationService
 * Provides terminal-based presentation for agent output by delegating to CLIRenderer
 */
class CLIPresentationService implements PresentationService {
  private renderer: CLIRenderer | null = null;

  /**
   * Get or create a singleton CLI renderer for formatting operations
   * This is used for non-streaming formatting methods
   */
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
    return this.getRenderer().formatAgentResponse(agentName, content);
  }

  presentThinking(agentName: string, isFirstIteration: boolean): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      const msg = yield* this.formatThinking(agentName, isFirstIteration);
      yield* this.writeOutput(msg);
    });
  }

  presentCompletion(agentName: string): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      const msg = yield* this.formatCompletion(agentName);
      yield* this.writeOutput(msg);
    });
  }

  presentWarning(agentName: string, message: string): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      const msg = yield* this.formatWarning(agentName, message);
      yield* this.writeOutput(msg);
    });
  }

  presentAgentResponse(agentName: string, content: string): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      const formatted = yield* this.formatAgentResponse(agentName, content);
      yield* this.writeOutput(formatted);
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
      const rendererConfig: CLIRendererConfig = {
        displayConfig: config.displayConfig,
        streamingConfig: config.streamingConfig,
        showMetrics: config.showMetrics,
        agentName: config.agentName,
        reasoningEffort: config.reasoningEffort,
      };
      const renderer = new CLIRenderer(rendererConfig);
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
