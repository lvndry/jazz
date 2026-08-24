import { Effect, Layer, Option } from "effect";
import { DEFAULT_DISPLAY_CONFIG } from "@/core/agent/types";
import { AgentConfigServiceTag } from "@/core/interfaces/agent-config";
import type {
  EphemeralRegionCollapse,
  EphemeralRegionKind,
  PresentationService,
  StreamingRenderer,
  StreamingRendererConfig,
} from "@/core/interfaces/presentation";
import { PresentationServiceTag } from "@/core/interfaces/presentation";
import { resolveDisplayConfig } from "@/core/presentation/display-config";
import type { StreamEvent } from "@/core/types/streaming";
import type { ApprovalRequest, ApprovalOutcome } from "@/core/types/tools";

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

/** Shape of a line written back to `stdinStream` to resolve a pending approval. */
interface ApprovalDecisionLine {
  readonly type: "approval_decision";
  readonly toolCallId: string;
  readonly approved: boolean;
}

function parseApprovalDecisionLine(line: string): ApprovalDecisionLine | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate["type"] === "approval_decision" &&
    typeof candidate["toolCallId"] === "string" &&
    typeof candidate["approved"] === "boolean"
  ) {
    return {
      type: "approval_decision",
      toolCallId: candidate["toolCallId"],
      approved: candidate["approved"],
    };
  }
  return undefined;
}

/**
 * Presentation service for headless, one-shot agent runs (`jazz run`).
 *
 * Keeps stdout clean for a machine-readable payload: nothing the agent loop
 * emits reaches stdout. Operational chatter (status, warnings, stray writes)
 * is routed to stderr instead. Interactive prompts cannot be answered without
 * a human, so:
 *  - approvals are DECLINED instantly UNLESS `--events approval` (or `all`) is
 *    active, in which case a human may be watching the emitted
 *    `approval_required` NDJSON event and can answer by writing an
 *    `approval_decision` line back on `stdinStream` (e.g. the Telegram bridge).
 *    When no consumer could possibly be watching, the run's
 *    `autoApprovePolicy` already auto-approved everything it was allowed to;
 *    anything still asking is above the policy threshold and is refused
 *    rather than blanket-approved or left hanging forever,
 *  - user-input / file-picker requests return empty.
 *
 * This differs from QuietPresentationService, which blanket-approves every tool
 * and is meant for trusted background runs.
 */
export class OneShotPresentationService implements PresentationService {
  private readonly pendingApprovals = new Map<string, (outcome: ApprovalOutcome) => void>();
  private stdinReaderStarted = false;

  constructor(
    _displayConfig = DEFAULT_DISPLAY_CONFIG,
    private readonly emitEventTypes: ReadonlySet<StreamEvent["type"]> = new Set(),
    private readonly stdinStream: NodeJS.ReadableStream = process.stdin,
    private readonly onApprovalWaitStart?: () => void,
  ) {}

  /**
   * Start listening for `approval_decision` lines on stdin, once. Called lazily
   * from `requestApproval` so runs that never hit a gated tool never attach a
   * listener. Malformed or unmatched lines are ignored.
   */
  private ensureStdinReaderStarted(): void {
    if (this.stdinReaderStarted) return;
    this.stdinReaderStarted = true;

    let buffer = "";
    this.stdinStream.setEncoding?.("utf-8");
    this.stdinStream.on("data", (chunk: string | Buffer) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (line.length === 0) continue;
        const decision = parseApprovalDecisionLine(line);
        if (!decision) continue;
        const resolve = this.pendingApprovals.get(decision.toolCallId);
        if (!resolve) continue;
        this.pendingApprovals.delete(decision.toolCallId);
        resolve({ approved: decision.approved });
      }
    });
  }

  presentThinking(_agentName: string, _isFirstIteration: boolean): Effect.Effect<void, never> {
    return Effect.void;
  }

  presentCompletion(_agentName: string): Effect.Effect<void, never> {
    return Effect.void;
  }

  private get eventsActive(): boolean {
    return this.emitEventTypes.size > 0;
  }

  emitsToolEventsViaRenderer(): boolean {
    return this.eventsActive;
  }

  /**
   * Only with `--events`: an external consumer (a chat bridge) is then watching
   * the `approval_required` line and can write a decision back on stdin. Plain
   * headless has nobody, and `requestApproval` declines outright.
   */
  canPromptForApproval(): boolean {
    return this.eventsActive;
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
    config: StreamingRendererConfig,
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
    // A renderer is created per agent run, so the name it was built with is the one
    // authoring these events. Stamping it on every line is what lets a consumer keep
    // concurrent sub-agents apart: reasoning and text deltas carry no agent of their
    // own, and several specialists streaming at once are otherwise unattributable.
    const agentName = config.agentName;
    const emittingRenderer: StreamingRenderer = {
      handleEvent: (event: StreamEvent) =>
        Effect.sync(() => {
          if (emitEventTypes.has(event.type)) {
            // Don't truncate what a human is being asked to approve.
            const replacer = event.type === "approval_required" ? undefined : truncateLongStrings;
            const attributed = "agentName" in event ? event : { ...event, agentName };
            process.stderr.write(`${JSON.stringify(attributed, replacer)}\n`);
          }
        }),
      setInterruptHandler: (_handler: (() => void) | null) => Effect.void,
      reset: () => Effect.void,
      flush: () => Effect.void,
    };
    return Effect.succeed(emittingRenderer);
  }

  writeOutput(message: string, agentName?: string): Effect.Effect<void, never> {
    return Effect.sync(() => {
      if (this.eventsActive) {
        this.emitNdjson({
          type: "output",
          message,
          ...(agentName !== undefined ? { agentName } : {}),
        });
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
    agentName?: string,
  ): Effect.Effect<void, never> {
    return Effect.sync(() => {
      if (this.eventsActive) {
        this.emitNdjson({
          type: "status",
          level,
          message,
          ...(agentName !== undefined ? { agentName } : {}),
        });
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
    if (!this.eventsActive) {
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

    // Events are active, so an external consumer (e.g. the Telegram bridge) may
    // be watching the `approval_required` NDJSON event and can write a matching
    // `approval_decision` line back on stdin. Block until that happens (or the
    // run's deadline expires — onApprovalWaitStart pushes that deadline out
    // first, so time spent waiting on a human doesn't count against the same
    // budget as the agent's own work).
    this.onApprovalWaitStart?.();
    this.ensureStdinReaderStarted();
    const toolCallId = request.toolCallId;
    const pendingApprovals = this.pendingApprovals;
    return Effect.async<ApprovalOutcome, never>((resume) => {
      pendingApprovals.set(toolCallId, (outcome) => resume(Effect.succeed(outcome)));
      return Effect.sync(() => {
        pendingApprovals.delete(toolCallId);
      });
    });
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

  openEphemeralRegion(_kind: EphemeralRegionKind, _label: string): Effect.Effect<string, never> {
    return Effect.succeed("noop");
  }

  appendEphemeralRegion(_regionId: string, _text: string): Effect.Effect<void, never> {
    return Effect.void;
  }

  collapseEphemeralRegion(
    _regionId: string,
    _label: string,
    _outcome: EphemeralRegionCollapse,
  ): Effect.Effect<void, never> {
    return Effect.void;
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
  onApprovalWaitStart?: () => void,
) {
  return Layer.effect(
    PresentationServiceTag,
    Effect.gen(function* () {
      const configServiceOption = yield* Effect.serviceOption(AgentConfigServiceTag);
      const displayConfig = Option.isSome(configServiceOption)
        ? resolveDisplayConfig(yield* configServiceOption.value.appConfig)
        : DEFAULT_DISPLAY_CONFIG;
      return new OneShotPresentationService(
        displayConfig,
        emitEventTypes,
        undefined,
        onApprovalWaitStart,
      );
    }),
  );
}

export const OneShotPresentationServiceLayer = makeOneShotPresentationServiceLayer();
