import { randomUUID } from "node:crypto";
import path from "node:path";
import { Effect, Layer } from "effect";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import type {
  AgentUsage,
  ModelUsage,
  TelemetryEvent,
  TelemetryEventType,
  TelemetryQueryOptions,
  TelemetryService,
  TokenUsage,
  UsageSummary,
} from "@/core/interfaces/telemetry";
import { TelemetryServiceTag } from "@/core/interfaces/telemetry";
import type { TelemetryConfig } from "@/core/types/config";
import { TelemetryError } from "@/core/types/errors";
import { getUserDataDirectory } from "@/core/utils/paths";
import { FileTelemetrySink } from "./file-sink";
import { redactHeaders, resolveOtlpConfig } from "./otlp-config";
import { OtlpTelemetrySink } from "./otlp-sink";
import { isEventReader, type TelemetrySink } from "./sink";
import packageJson from "../../../package.json";

// ── Constants ───────────────────────────────────────────────────────

const DEFAULT_BUFFER_SIZE = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const DEFAULT_RETENTION_DAYS = 90;

/**
 * Hard ceiling on retained-but-unflushed events, as a multiple of bufferSize.
 *
 * Failed writes are re-enqueued so a transient collector outage does not lose
 * data, but an endpoint that is down for the whole run must not grow the buffer
 * without bound. Past this point the oldest events are dropped.
 */
const MAX_BUFFER_MULTIPLIER = 10;

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Resolve the default telemetry storage directory.
 * Mirrors the pattern used by the logger for resolving log directories.
 */
function resolveDefaultStoragePath(): string {
  return path.join(getUserDataDirectory(), "telemetry");
}

function emptyUsageSummary(): UsageSummary {
  return {
    totalRequests: 0,
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    toolDefinitionTokens: 0,
    toolResultTokens: 0,
    toolDefinitionsOffered: 0,
    totalToolCalls: 0,
    totalToolErrors: 0,
    totalAgentRuns: 0,
    totalDurationMs: 0,
    byModel: {},
    byAgent: {},
  };
}

// ── Implementation ──────────────────────────────────────────────────

export interface TelemetryServiceOptions {
  readonly enabled: boolean;
  readonly bufferSize: number;
  readonly flushIntervalMs: number;
  /** Destinations events are fanned out to on every flush. */
  readonly sinks: readonly TelemetrySink[];
  /** Reports a sink failure. Wired to the logger by the layer. */
  readonly onSinkError?: (sinkName: string, error: unknown) => void;
  /** Reports events dropped because the buffer hit its ceiling. */
  readonly onEventsDropped?: (count: number) => void;
}

export class TelemetryServiceImpl implements TelemetryService {
  private buffer: TelemetryEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly enabled: boolean;
  private readonly bufferSize: number;
  private readonly flushIntervalMs: number;
  private readonly sinks: readonly TelemetrySink[];
  private readonly onSinkError: (sinkName: string, error: unknown) => void;
  private readonly onEventsDropped: (count: number) => void;

  constructor(options: TelemetryServiceOptions) {
    this.enabled = options.enabled;
    this.bufferSize = options.bufferSize;
    this.flushIntervalMs = options.flushIntervalMs;
    this.sinks = options.sinks;
    this.onSinkError = options.onSinkError ?? (() => {});
    this.onEventsDropped = options.onEventsDropped ?? (() => {});

    if (this.enabled && this.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        void this.flushSync();
      }, this.flushIntervalMs);
      // Prevent the timer from blocking Node's event loop shutdown.
      if (this.flushTimer && typeof this.flushTimer === "object" && "unref" in this.flushTimer) {
        this.flushTimer.unref();
      }
    }
  }

  // ── Recording ───────────────────────────────────────────────────

  recordAgentRunStarted(data: {
    readonly runId: string;
    readonly agentId: string;
    readonly agentName: string;
    readonly conversationId: string;
    readonly provider?: string;
    readonly model?: string;
  }): Effect.Effect<void, TelemetryError> {
    return this.appendEvent("agent_run_started", data, {
      agentId: data.agentId,
      logScope: data.conversationId,
    });
  }

  recordAgentRunCompleted(data: {
    readonly runId: string;
    readonly agentId: string;
    readonly agentName: string;
    readonly conversationId: string;
    readonly provider?: string;
    readonly model?: string;
    readonly durationMs: number;
    readonly iterationsUsed: number;
    readonly finished: boolean;
    readonly usage: TokenUsage;
    readonly toolCalls: number;
    readonly toolErrors: number;
  }): Effect.Effect<void, TelemetryError> {
    return this.appendEvent("agent_run_completed", data, {
      agentId: data.agentId,
      logScope: data.conversationId,
    });
  }

  recordAgentRunFailed(data: {
    readonly runId: string;
    readonly agentId: string;
    readonly agentName: string;
    readonly conversationId: string;
    readonly error: string;
    readonly durationMs: number;
  }): Effect.Effect<void, TelemetryError> {
    return this.appendEvent("agent_run_failed", data, {
      agentId: data.agentId,
      logScope: data.conversationId,
    });
  }

  recordLLMUsage(data: {
    readonly provider: string;
    readonly model: string;
    readonly usage: TokenUsage;
    readonly agentId?: string;
    readonly logScope?: string;
    readonly durationMs?: number;
  }): Effect.Effect<void, TelemetryError> {
    const opts: { agentId?: string; logScope?: string } = {};
    if (data.agentId !== undefined) opts.agentId = data.agentId;
    if (data.logScope !== undefined) opts.logScope = data.logScope;
    return this.appendEvent("llm_usage", data, opts);
  }

  recordLLMRetry(data: {
    readonly provider: string;
    readonly model: string;
    readonly error: string;
    readonly attempt: number;
    readonly agentId?: string;
  }): Effect.Effect<void, TelemetryError> {
    const opts: { agentId?: string } = {};
    if (data.agentId !== undefined) opts.agentId = data.agentId;
    return this.appendEvent("llm_retry", data, opts);
  }

  recordToolInvocation(data: {
    readonly toolName: string;
    readonly success: boolean;
    readonly durationMs?: number;
    readonly error?: string;
    readonly agentId?: string;
    readonly logScope?: string;
  }): Effect.Effect<void, TelemetryError> {
    const eventType: TelemetryEventType = data.success ? "tool_invocation" : "tool_error";
    const opts: { agentId?: string; logScope?: string } = {};
    if (data.agentId !== undefined) opts.agentId = data.agentId;
    if (data.logScope !== undefined) opts.logScope = data.logScope;
    return this.appendEvent(eventType, data, opts);
  }

  recordCommandExecuted(data: {
    readonly command: string;
    readonly args?: readonly string[];
    readonly durationMs?: number;
    readonly success: boolean;
    readonly error?: string;
  }): Effect.Effect<void, TelemetryError> {
    return this.appendEvent("command_executed", data);
  }

  recordEvent(
    type: TelemetryEventType,
    data: Record<string, unknown>,
    options?: {
      readonly agentId?: string;
      readonly logScope?: string;
    },
  ): Effect.Effect<void, TelemetryError> {
    return this.appendEvent(type, data, options);
  }

  // ── Querying ────────────────────────────────────────────────────

  getEvents(
    options?: TelemetryQueryOptions,
  ): Effect.Effect<readonly TelemetryEvent[], TelemetryError> {
    return Effect.gen(
      function* (this: TelemetryServiceImpl) {
        if (!this.enabled) return [];

        const allEvents = yield* this.loadAllEvents();
        let filtered = allEvents;

        if (options?.types && options.types.length > 0) {
          const typeSet = new Set(options.types);
          filtered = filtered.filter((e) => typeSet.has(e.type));
        }

        if (options?.agentId) {
          const agentId = options.agentId;
          filtered = filtered.filter((e) => e.agentId === agentId);
        }

        if (options?.logScope) {
          const logScope = options.logScope;
          filtered = filtered.filter((e) => e.logScope === logScope);
        }

        if (options?.from) {
          const from = options.from;
          filtered = filtered.filter((e) => e.timestamp >= from);
        }

        if (options?.to) {
          const to = options.to;
          filtered = filtered.filter((e) => e.timestamp <= to);
        }

        // Sort by timestamp descending (most recent first)
        filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

        const offset = options?.offset ?? 0;
        const limit = options?.limit ?? filtered.length;
        return filtered.slice(offset, offset + limit);
      }.bind(this),
    );
  }

  getUsageSummary(options?: {
    readonly from?: string;
    readonly to?: string;
    readonly agentId?: string;
  }): Effect.Effect<UsageSummary, TelemetryError> {
    return Effect.gen(
      function* (this: TelemetryServiceImpl) {
        if (!this.enabled) return emptyUsageSummary();

        const queryOpts: {
          from?: string;
          to?: string;
          agentId?: string;
        } = {};
        if (options?.from !== undefined) queryOpts.from = options.from;
        if (options?.to !== undefined) queryOpts.to = options.to;
        if (options?.agentId !== undefined) queryOpts.agentId = options.agentId;
        const events = yield* this.getEvents(queryOpts);

        return this.aggregateUsage(events);
      }.bind(this),
    );
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  flush(): Effect.Effect<void, TelemetryError> {
    return Effect.gen(
      function* (this: TelemetryServiceImpl) {
        yield* this.flushBuffer();
      }.bind(this),
    );
  }

  /**
   * Stop the periodic flush timer and flush any remaining events.
   * Should be called on shutdown.
   */
  shutdown(): Effect.Effect<void, TelemetryError> {
    return Effect.gen(
      function* (this: TelemetryServiceImpl) {
        if (this.flushTimer) {
          clearInterval(this.flushTimer);
          this.flushTimer = null;
        }
        yield* this.flushBuffer();
      }.bind(this),
    );
  }

  // ── Internal ──────────────────────────────────────────────────

  private appendEvent(
    type: TelemetryEventType,
    data: Record<string, unknown>,
    options?: { readonly agentId?: string; readonly logScope?: string },
  ): Effect.Effect<void, TelemetryError> {
    return Effect.gen(
      function* (this: TelemetryServiceImpl) {
        if (!this.enabled) return;

        const event: TelemetryEvent = {
          id: randomUUID(),
          type,
          timestamp: new Date().toISOString(),
          data,
          ...(options?.agentId ? { agentId: options.agentId } : {}),
          ...(options?.logScope ? { logScope: options.logScope } : {}),
        };

        this.buffer.push(event);

        if (this.buffer.length >= this.bufferSize) {
          yield* this.flushBuffer();
        }
      }.bind(this),
    );
  }

  private flushBuffer(): Effect.Effect<void, TelemetryError> {
    return Effect.promise(() => this.flushSync());
  }

  /**
   * Write the buffer out to every sink.
   *
   * Promise-based because the interval timer drives it from outside any Effect
   * context. Sinks are written concurrently and independently: one failing
   * destination never blocks another, and no failure is surfaced to the caller.
   * Events are re-enqueued only when every sink failed, so a working file sink
   * plus a dead collector does not duplicate rows on disk.
   */
  private async flushSync(): Promise<void> {
    if (this.buffer.length === 0 || this.sinks.length === 0) return;

    const toFlush = [...this.buffer];
    this.buffer = [];

    const results = await Promise.allSettled(this.sinks.map((sink) => sink.write(toFlush)));

    let failures = 0;
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        failures += 1;
        this.onSinkError(this.sinks[index]?.name ?? "unknown", result.reason);
      }
    });

    if (failures === this.sinks.length) {
      this.buffer.unshift(...toFlush);
      this.enforceBufferCeiling();
    }
  }

  private enforceBufferCeiling(): void {
    const ceiling = this.bufferSize * MAX_BUFFER_MULTIPLIER;
    if (this.buffer.length <= ceiling) return;

    const dropped = this.buffer.length - ceiling;
    this.buffer = this.buffer.slice(dropped);
    this.onEventsDropped(dropped);
  }

  private loadAllEvents(): Effect.Effect<TelemetryEvent[], TelemetryError> {
    const reader = this.sinks.find(isEventReader);
    if (!reader) return Effect.succeed([...this.buffer]);

    return Effect.tryPromise({
      try: async () => [...this.buffer, ...(await reader.readAll())],
      catch: (error) =>
        new TelemetryError({
          operation: "read",
          message: `Failed to read telemetry events: ${String(error)}`,
          cause: error,
        }),
    });
  }

  /**
   * Remove stored events older than the retention window.
   * Only the file sink retains anything locally; other sinks are no-ops here.
   */
  pruneOldEvents(): Effect.Effect<number, TelemetryError> {
    const fileSink = this.sinks.find(
      (sink): sink is FileTelemetrySink => sink instanceof FileTelemetrySink,
    );
    if (!fileSink) return Effect.succeed(0);

    return Effect.tryPromise({
      try: () => fileSink.prune(),
      catch: (error) =>
        new TelemetryError({
          operation: "prune",
          message: `Failed to prune telemetry events: ${String(error)}`,
          cause: error,
        }),
    });
  }

  private aggregateUsage(events: readonly TelemetryEvent[]): UsageSummary {
    const summary: {
      totalRequests: number;
      totalTokens: number;
      promptTokens: number;
      completionTokens: number;
      reasoningTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      toolDefinitionTokens: number;
      toolResultTokens: number;
      toolDefinitionsOffered: number;
      totalToolCalls: number;
      totalToolErrors: number;
      totalAgentRuns: number;
      totalDurationMs: number;
      byModel: Record<string, ModelUsage>;
      byAgent: Record<string, AgentUsage>;
    } = {
      totalRequests: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      toolDefinitionTokens: 0,
      toolResultTokens: 0,
      toolDefinitionsOffered: 0,
      totalToolCalls: 0,
      totalToolErrors: 0,
      totalAgentRuns: 0,
      totalDurationMs: 0,
      byModel: {},
      byAgent: {},
    };

    for (const event of events) {
      const data = event.data;

      switch (event.type) {
        case "llm_usage": {
          summary.totalRequests += 1;
          const usage = data["usage"] as TokenUsage | undefined;
          if (usage) {
            summary.totalTokens += usage.totalTokens;
            summary.promptTokens += usage.promptTokens;
            summary.completionTokens += usage.completionTokens;
            summary.reasoningTokens += usage.reasoningTokens ?? 0;
            summary.cacheReadTokens += usage.cacheReadTokens ?? 0;
            summary.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
            summary.toolDefinitionTokens += usage.toolDefinitionTokens ?? 0;
            summary.toolResultTokens += usage.toolResultTokens ?? 0;
            summary.toolDefinitionsOffered += usage.toolDefinitionsOffered ?? 0;

            const model = typeof data["model"] === "string" ? data["model"] : "unknown";
            const provider = typeof data["provider"] === "string" ? data["provider"] : "unknown";
            const modelKey = `${provider}/${model}`;
            const existing = summary.byModel[modelKey];
            if (existing) {
              summary.byModel[modelKey] = {
                ...existing,
                requests: existing.requests + 1,
                promptTokens: existing.promptTokens + usage.promptTokens,
                completionTokens: existing.completionTokens + usage.completionTokens,
                totalTokens: existing.totalTokens + usage.totalTokens,
                reasoningTokens: existing.reasoningTokens + (usage.reasoningTokens ?? 0),
              };
            } else {
              summary.byModel[modelKey] = {
                model,
                provider,
                requests: 1,
                promptTokens: usage.promptTokens,
                completionTokens: usage.completionTokens,
                totalTokens: usage.totalTokens,
                reasoningTokens: usage.reasoningTokens ?? 0,
              };
            }
          }
          break;
        }

        case "agent_run_completed": {
          summary.totalAgentRuns += 1;
          // `totalDurationMs` tracks wall clock, so only run duration counts —
          // per-request `llm_usage` durations are contained within it. Tool
          // counters come from the per-invocation events for the same reason.
          if (data["durationMs"] != null) {
            summary.totalDurationMs += Number(data["durationMs"]);
          }

          // Accumulate per-agent usage
          const agentId =
            typeof data["agentId"] === "string"
              ? data["agentId"]
              : typeof event.agentId === "string"
                ? event.agentId
                : "unknown";
          const agentName = typeof data["agentName"] === "string" ? data["agentName"] : "unknown";
          const usage = data["usage"] as TokenUsage | undefined;

          const existingAgent = summary.byAgent[agentId];
          if (existingAgent) {
            summary.byAgent[agentId] = {
              ...existingAgent,
              runs: existingAgent.runs + 1,
              totalTokens: existingAgent.totalTokens + (usage?.totalTokens ?? 0),
              totalToolCalls: existingAgent.totalToolCalls + Number(data["toolCalls"] ?? 0),
              totalDurationMs: existingAgent.totalDurationMs + Number(data["durationMs"] ?? 0),
            };
          } else {
            summary.byAgent[agentId] = {
              agentId,
              agentName,
              runs: 1,
              totalTokens: usage?.totalTokens ?? 0,
              totalToolCalls: Number(data["toolCalls"] ?? 0),
              totalDurationMs: Number(data["durationMs"] ?? 0),
            };
          }
          break;
        }

        case "agent_run_started": {
          // Counted separately; agent_run_completed is the canonical count
          break;
        }

        case "agent_run_failed": {
          summary.totalAgentRuns += 1;
          if (data["durationMs"] != null) {
            summary.totalDurationMs += Number(data["durationMs"]);
          }
          break;
        }

        case "tool_invocation": {
          summary.totalToolCalls += 1;
          break;
        }

        case "tool_error": {
          summary.totalToolCalls += 1;
          summary.totalToolErrors += 1;
          break;
        }

        default:
          // Other event types don't contribute to the usage summary
          break;
      }
    }

    return summary;
  }
}

// ── Layer Factory ───────────────────────────────────────────────────

/**
 * Create the TelemetryService layer.
 *
 * Reads telemetry configuration from AppConfig to determine storage path,
 * buffer size, flush interval, and retention policy.
 *
 * Dependencies: AgentConfigService (for reading AppConfig), LoggerService.
 */
export function createTelemetryServiceLayer(): Layer.Layer<
  TelemetryService,
  never,
  AgentConfigService | LoggerService
> {
  return Layer.effect(
    TelemetryServiceTag,
    Effect.gen(function* () {
      const configService = yield* AgentConfigServiceTag;
      const logger = yield* LoggerServiceTag;

      let telemetryConfig: TelemetryConfig | undefined;
      try {
        const appConfig = yield* configService.appConfig;
        telemetryConfig = appConfig.telemetry;
      } catch {
        // Config may not be available; use defaults
      }

      const enabled = telemetryConfig?.enabled ?? true;
      const storagePath = telemetryConfig?.storagePath ?? resolveDefaultStoragePath();
      const bufferSize = telemetryConfig?.bufferSize ?? DEFAULT_BUFFER_SIZE;
      const flushIntervalMs = telemetryConfig?.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
      const retentionDays = telemetryConfig?.retentionDays ?? DEFAULT_RETENTION_DAYS;

      const sinks: TelemetrySink[] = [new FileTelemetrySink(storagePath, retentionDays)];

      const otlpConfig = resolveOtlpConfig(telemetryConfig?.otlp);
      if (otlpConfig?.enabled === true) {
        sinks.push(new OtlpTelemetrySink(otlpConfig, packageJson.version));
      }

      yield* logger.debug("Telemetry service initialized", {
        enabled,
        storagePath,
        bufferSize,
        flushIntervalMs,
        retentionDays,
        sinks: sinks.map((sink) => sink.name),
        ...(otlpConfig && {
          otlp: {
            enabled: otlpConfig.enabled,
            logsEndpoint: otlpConfig.logsEndpoint,
            serviceName: otlpConfig.serviceName,
            captureContent: otlpConfig.captureContent,
            // Headers carry credentials and must never reach the log file.
            headers: redactHeaders(otlpConfig.headers),
          },
        }),
      });

      return new TelemetryServiceImpl({
        enabled,
        bufferSize,
        flushIntervalMs,
        sinks,
        onSinkError: (sinkName, error) => {
          Effect.runFork(
            logger.warn("Telemetry sink write failed", {
              sink: sinkName,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        },
        onEventsDropped: (count) => {
          Effect.runFork(
            logger.warn("Telemetry buffer full; dropped oldest events", { dropped: count }),
          );
        },
      });
    }),
  );
}
