import chalk from "chalk";
import { Effect, Layer, Option } from "effect";
import { DEFAULT_DISPLAY_CONFIG } from "@/core/agent/types";
import { AgentConfigServiceTag } from "@/core/interfaces/agent-config";
import type {
  PresentationService,
  StreamingRenderer,
  StreamingRendererConfig,
} from "@/core/interfaces/presentation";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import { TerminalServiceTag } from "@/core/interfaces/terminal";
import type { DisplayConfig } from "@/core/types/output";
import type { StreamEvent } from "@/core/types/streaming";
import type { ApprovalRequest, ApprovalOutcome } from "@/core/types/tools";
import { resolveDisplayConfig } from "@/core/utils/display-config";
import { CLIRenderer, type CLIRendererConfig } from "./cli-renderer";

/**
 * CLI implementation of PresentationService
 * Provides terminal-based presentation for agent output by delegating to CLIRenderer
 */
export class CLIPresentationService implements PresentationService {
  private renderer: CLIRenderer | null = null;

  constructor(
    private readonly displayConfig: DisplayConfig,
    private readonly confirm: (message: string, defaultValue?: boolean) => Effect.Effect<boolean, never>,
    private readonly ask: (message: string, options?: { defaultValue?: string }) => Effect.Effect<string, never>,
  ) {}

  /**
   * Get or create a singleton CLI renderer for formatting operations
   * This is used for non-streaming formatting methods
   */
  private getRenderer(): CLIRenderer {
    if (!this.renderer) {
      const config: CLIRendererConfig = {
        displayConfig: this.displayConfig,
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
        setInterruptHandler: (_handler: (() => void) | null): Effect.Effect<void, never> =>
          Effect.void,
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

  requestApproval(request: ApprovalRequest): Effect.Effect<ApprovalOutcome, never> {
    return Effect.gen(this, function* () {
      // Format the approval message with details about the action
      const toolLabel = chalk.cyan(request.toolName);
      const separator = chalk.dim("─".repeat(50));

      // Write the approval details
      yield* this.writeOutput(`\n${separator}\n`);
      yield* this.writeOutput(`${chalk.yellow("⚠️  Approval Required")} for ${toolLabel}\n\n`);
      yield* this.writeOutput(`${request.message}\n\n`);
      yield* this.writeOutput(`${separator}\n`);

      // Prompt for confirmation (default to Yes for faster workflow)
      const approved = yield* this.confirm("Approve this action?", true);

      if (approved) {
        return { approved: true };
      }

      // Rejected: prompt for optional message to guide the agent
      const userMessage = (yield* this.ask(
        "What should the agent do instead? (optional — press Enter to skip)",
        {},
      )).trim();

      return userMessage
        ? ({ approved: false, userMessage } as const)
        : ({ approved: false } as const);
    });
  }

  signalToolExecutionStarted(): Effect.Effect<void, never> {
    return Effect.void;
  }
}

/**
 * Layer providing the CLI presentation service
 * Requires TerminalService for user interaction (approval prompts)
 */
export const CLIPresentationServiceLayer = Layer.effect(
  PresentationServiceTag,
  Effect.gen(function* () {
    const configServiceOption = yield* Effect.serviceOption(AgentConfigServiceTag);
    const terminalServiceOption = yield* Effect.serviceOption(TerminalServiceTag);

    const displayConfig = Option.isSome(configServiceOption)
      ? resolveDisplayConfig(yield* configServiceOption.value.appConfig)
      : DEFAULT_DISPLAY_CONFIG;

    // Get confirm and ask from terminal service, or fallbacks
    const confirmFn = Option.isSome(terminalServiceOption)
      ? terminalServiceOption.value.confirm.bind(terminalServiceOption.value)
      : (_message: string, _defaultValue?: boolean) => Effect.succeed(false);
    const askFn = Option.isSome(terminalServiceOption)
      ? terminalServiceOption.value.ask.bind(terminalServiceOption.value)
      : (_message: string) => Effect.succeed("");

    return new CLIPresentationService(displayConfig, confirmFn, askFn);
  }),
);
