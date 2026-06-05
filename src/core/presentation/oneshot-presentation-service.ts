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

const MAX_EVENT_STRING_LENGTH = 200;

function truncateString(value: string): string {
  return value.length > MAX_EVENT_STRING_LENGTH
    ? `${value.slice(0, MAX_EVENT_STRING_LENGTH)}…`
    : value;
}

/**
 * JSON replacer that caps any long string value so a single tool result or file
 * payload cannot gush megabytes onto stderr, and serializes `Error` instances to
 * a plain object (their `message`/`stack` are non-enumerable and would otherwise
 * stringify to `{}`). Bounds NDJSON line size to keep the live-progress stream
 * cheap to parse downstream.
 */
function truncateLongStrings(_key: string, value: unknown): unknown {
  if (typeof value === "string") {
    return truncateString(value);
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncateString(value.message),
      ...(value.stack !== undefined ? { stack: truncateString(value.stack) } : {}),
    };
  }
  return value;
}

/**
 * Presentation service for headless, one-shot agent runs (`jazz run`).
 *
 * Keeps stdout clean for a machine-readable payload: nothing the agent loop
 * emits reaches stdout. Operational chatter (status, warnings, stray writes)
 * is routed to stderr instead. Interactive prompts cannot be answered without
 * a human, so:
 *  - approvals are DECLINED (the run's `autoApprovePolicy` already auto-approved
 *    everything it was allowed to; anything still asking is above the policy
 *    threshold and is refused rather than blanket-approved),
 *  - user-input / file-picker requests return empty.
 *
 * This differs from QuietPresentationService, which blanket-approves every tool
 * and is meant for trusted background runs.
 */
export class OneShotPresentationService implements PresentationService {
  constructor(
    _displayConfig = DEFAULT_DISPLAY_CONFIG,
    private readonly emitEventTypes: ReadonlySet<StreamEvent["type"]> = new Set(),
  ) {}

  presentThinking(_agentName: string, _isFirstIteration: boolean): Effect.Effect<void, never> {
    return Effect.void;
  }

  presentCompletion(_agentName: string): Effect.Effect<void, never> {
    return Effect.void;
  }

  private get eventsActive(): boolean {
    return this.emitEventTypes.size > 0;
  }

  private emitNdjson(payload: Record<string, unknown>): void {
    process.stderr.write(`${JSON.stringify(payload, truncateLongStrings)}\n`);
  }

  presentWarning(agentName: string, message: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      if (this.eventsActive) {
        this.emitNdjson({ type: "warning", agentName, message });
        return;
      }
      process.stderr.write(`⚠ ${agentName}: ${message}\n`);
    });
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
    _options?: { readonly metadata?: Record<string, unknown> },
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
    if (this.emitEventTypes.size === 0) {
      const noopRenderer: StreamingRenderer = {
        handleEvent: (_event: StreamEvent) => Effect.void,
        setInterruptHandler: (_handler: (() => void) | null) => Effect.void,
        reset: () => Effect.void,
        flush: () => Effect.void,
      };
      return Effect.succeed(noopRenderer);
    }

    const emitEventTypes = this.emitEventTypes;
    const emittingRenderer: StreamingRenderer = {
      handleEvent: (event: StreamEvent) =>
        Effect.sync(() => {
          if (emitEventTypes.has(event.type)) {
            process.stderr.write(`${JSON.stringify(event, truncateLongStrings)}\n`);
          }
        }),
      setInterruptHandler: (_handler: (() => void) | null) => Effect.void,
      reset: () => Effect.void,
      flush: () => Effect.void,
    };
    return Effect.succeed(emittingRenderer);
  }

  writeOutput(message: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      if (this.eventsActive) {
        this.emitNdjson({ type: "output", message });
        return;
      }
      process.stderr.write(message);
    });
  }

  writeBlankLine(): Effect.Effect<void, never> {
    return Effect.void;
  }

  presentStatus(
    message: string,
    level: "info" | "success" | "warning" | "error" | "progress",
  ): Effect.Effect<void, never> {
    return Effect.sync(() => {
      if (this.eventsActive) {
        this.emitNdjson({ type: "status", level, message });
        return;
      }
      const prefixes: Record<typeof level, string> = {
        info: "ℹ",
        success: "✓",
        warning: "⚠",
        error: "✗",
        progress: "⏳",
      };
      process.stderr.write(`${prefixes[level]} ${message}\n`);
    });
  }

  requestApproval(request: ApprovalRequest): Effect.Effect<ApprovalOutcome, never> {
    // Headless: no human to approve. Decline, but steer the model away from the
    // default "ask the user to try again" recovery (there is no user) and toward
    // either an allowed tool or a clear explanation of what it could not do.
    const userMessage =
      `The "${request.toolName}" tool requires approval and was automatically declined ` +
      `because this is a non-interactive run. Do not ask the user to approve or retry — ` +
      `there is no one to respond. Either accomplish the task using tools that do not ` +
      `require approval, or clearly explain what could not be done and why.`;
    return Effect.succeed({ approved: false, userMessage });
  }

  signalToolExecutionStarted(): Effect.Effect<void, never> {
    return Effect.void;
  }

  requestUserInput(): Effect.Effect<string, never> {
    return Effect.succeed("");
  }

  requestFilePicker(): Effect.Effect<string, never> {
    return Effect.succeed("");
  }
}

/**
 * Layer providing the one-shot presentation service for `jazz run`.
 *
 * When `emitEventTypes` is non-empty, the streaming renderer emits matching
 * `StreamEvent`s as NDJSON to stderr for live-progress consumers; stdout stays
 * reserved for the final payload.
 */
export function makeOneShotPresentationServiceLayer(
  emitEventTypes: ReadonlySet<StreamEvent["type"]> = new Set(),
) {
  return Layer.effect(
    PresentationServiceTag,
    Effect.gen(function* () {
      const configServiceOption = yield* Effect.serviceOption(AgentConfigServiceTag);
      const displayConfig = Option.isSome(configServiceOption)
        ? resolveDisplayConfig(yield* configServiceOption.value.appConfig)
        : DEFAULT_DISPLAY_CONFIG;
      return new OneShotPresentationService(displayConfig, emitEventTypes);
    }),
  );
}

export const OneShotPresentationServiceLayer = makeOneShotPresentationServiceLayer();
