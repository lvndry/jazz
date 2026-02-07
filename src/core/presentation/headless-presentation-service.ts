import { Effect, Layer, Option } from "effect";
import { DEFAULT_DISPLAY_CONFIG } from "@/core/agent/types";
import { AgentConfigServiceTag } from "@/core/interfaces/agent-config";
import type {
  PresentationService,
  StreamingRenderer,
  StreamingRendererConfig,
} from "@/core/interfaces/presentation";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import type { StreamEvent } from "@/core/types/streaming";
import type { ApprovalRequest, ApprovalOutcome } from "@/core/types/tools";
import { resolveDisplayConfig } from "@/core/utils/display-config";

/**
 * Headless presentation service for background groove runs (e.g. catch-up).
 * Does not update the shared UI (store.setStatus / setStream), so the main
 * command's terminal is not overwritten by "pilot is thinking" or tool output.
 * All presentation methods no-op; approval requests are auto-approved.
 */
class HeadlessPresentationService implements PresentationService {
  constructor(_displayConfig = DEFAULT_DISPLAY_CONFIG) {}

  presentThinking(_agentName: string, _isFirstIteration: boolean): Effect.Effect<void, never> {
    return Effect.void;
  }

  presentCompletion(_agentName: string): Effect.Effect<void, never> {
    return Effect.void;
  }

  presentWarning(_agentName: string, _message: string): Effect.Effect<void, never> {
    return Effect.void;
  }

  presentAgentResponse(_agentName: string, _content: string): Effect.Effect<void, never> {
    return Effect.void;
  }

  renderMarkdown(markdown: string): Effect.Effect<string, never> {
    return Effect.succeed(markdown);
  }

  formatToolArguments(_toolName: string, args?: Record<string, unknown>): string {
    if (!args || Object.keys(args).length === 0) return "";
    return ` ${JSON.stringify(args)}`;
  }

  formatToolResult(_toolName: string, result: string): string {
    return result;
  }

  formatToolExecutionStart(
    _toolName: string,
    _args?: Record<string, unknown>,
  ): Effect.Effect<string, never> {
    return Effect.succeed("");
  }

  formatToolExecutionComplete(
    _summary: string | null,
    _durationMs: number,
  ): Effect.Effect<string, never> {
    return Effect.succeed("");
  }

  formatToolExecutionError(
    _errorMessage: string,
    _durationMs: number,
  ): Effect.Effect<string, never> {
    return Effect.succeed("");
  }

  formatToolsDetected(
    _agentName: string,
    _toolNames: readonly string[],
    _toolsRequiringApproval: readonly string[],
  ): Effect.Effect<string, never> {
    return Effect.succeed("");
  }

  createStreamingRenderer(
    _config: StreamingRendererConfig,
  ): Effect.Effect<StreamingRenderer, never> {
    const noopRenderer: StreamingRenderer = {
      handleEvent: (_event: StreamEvent) => Effect.void,
      setInterruptHandler: (_handler: (() => void) | null) => Effect.void,
      reset: () => Effect.void,
      flush: () => Effect.void,
    };
    return Effect.succeed(noopRenderer);
  }

  writeOutput(_message: string): Effect.Effect<void, never> {
    return Effect.void;
  }

  writeBlankLine(): Effect.Effect<void, never> {
    return Effect.void;
  }

  requestApproval(_request: ApprovalRequest): Effect.Effect<ApprovalOutcome, never> {
    return Effect.succeed({ approved: true });
  }

  signalToolExecutionStarted(): Effect.Effect<void, never> {
    return Effect.void;
  }

  // Headless mode cannot ask user - return empty string
  requestUserInput(): Effect.Effect<string, never> {
    return Effect.succeed("");
  }

  // Headless mode cannot show file picker - return empty string
  requestFilePicker(): Effect.Effect<string, never> {
    return Effect.succeed("");
  }
}

/**
 * Layer that provides a headless presentation service for background runs.
 * Use with Effect.provide when forking groove catch-up so the main UI is not updated.
 */
export const HeadlessPresentationServiceLayer = Layer.effect(
  PresentationServiceTag,
  Effect.gen(function* () {
    const configServiceOption = yield* Effect.serviceOption(AgentConfigServiceTag);
    const displayConfig = Option.isSome(configServiceOption)
      ? resolveDisplayConfig(yield* configServiceOption.value.appConfig)
      : DEFAULT_DISPLAY_CONFIG;
    return new HeadlessPresentationService(displayConfig);
  }),
);
