/**
 * Implements `TelemetryService`: buffers events in memory and flushes them on an interval to
 * one or more sinks (local file, OTLP), plus periodic process resource sampling.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import { LoggerServiceTag, type LoggerService } from "@jazz/core/interfaces/logger";
import type {
  AgentUsage,
  ModelUsage,
  TelemetryEvent,
  TelemetryEventType,
  TelemetryQueryOptions,
  TelemetryService,
  TokenUsage,
  UsageSummary,
} from "@jazz/core/interfaces/telemetry";
import { TelemetryServiceTag } from "@jazz/core/interfaces/telemetry";
import type { TelemetryConfig } from "@jazz/core/types/config";
import { TelemetryError } from "@jazz/core/types/errors";
import { getUserDataDirectory } from "@jazz/core/utils/paths";
import { sampleProcessResources } from "@jazz/core/utils/process-resources";
import { Effect, Layer } from "effect";
import { FileTelemetrySink } from "./file-sink";
import { OtlpMetricsSink } from "./metrics";
import { resolveOtlpConfig } from "./otlp-config";
import { OtlpTelemetrySink } from "./otlp-sink";
import { isEventReader, type TelemetrySink } from "./sink";
import packageJson from "../../../../package.json";

// ── Constants ───────────────────────────────────────────────────────

const DEFAULT_BUFFER_SIZE = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const DEFAULT_RETENTION_DAYS = 90;
/** How often to sample Jazz RSS/heap/CPU during a live run. 0 disables. */
const DEFAULT_PROCESS_SAMPLE_INTERVAL_MS = 10_000;
const PROCESS_INSTANCE_ID = randomUUID();

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
    classifierPromptTokens: 0,
    classifierCompletionTokens: 0,
    classifierRequests: 0,
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
  /**
   * Interval for Jazz process RSS/heap/CPU samples during a run.
   * `0` disables sampling (tests). Production default is 10s.
   */
  readonly processSampleIntervalMs?: number;
  /** Destinations events are fanned out to on every flush. */
  readonly sinks: readonly TelemetrySink[];
  /** Eagerly establishes the zero sample for short-lived run counters. */
  readonly metricsSink?: OtlpMetricsSink;
  /** Reports a sink failure. Wired to the logger by the layer. */
  readonly onSinkError?: (sinkName: string, error: unknown) => void;
  /** Reports events dropped because the buffer hit its ceiling. */
  readonly onEventsDropped?: (count: number) => void;
}

export class TelemetryServiceImpl implements TelemetryService {
  private buffer: TelemetryEvent[] = [];
  private readonly pendingBySink = new Map<TelemetrySink, TelemetryEvent[]>();
  private flushChain: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly runSamplers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly enabled: boolean;
  private readonly bufferSize: number;
  private readonly flushIntervalMs: number;
  private readonly processSampleIntervalMs: number;
  private readonly sinks: readonly TelemetrySink[];
  private readonly metricsSink: OtlpMetricsSink | undefined;
  private readonly onSinkError: (sinkName: string, error: unknown) => void;
  private readonly onEventsDropped: (count: number) => void;

  constructor(options: TelemetryServiceOptions) {
    this.enabled = options.enabled;
    this.bufferSize = options.bufferSize;
    this.flushIntervalMs = options.flushIntervalMs;
    this.processSampleIntervalMs = options.processSampleIntervalMs ?? 0;
    this.sinks = options.sinks;
    this.metricsSink = options.metricsSink;
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

  recordAgentRunStarted(
    data: Parameters<TelemetryService["recordAgentRunStarted"]>[0],
  ): Effect.Effect<void, TelemetryError> {
    return Effect.sync(() => {
      this.startRunSampler(data.runId, data.agentId, data.conversationId);
      if (this.enabled && this.metricsSink) {
        try {
          void this.metricsSink.primeRun(data.agentId);
        } catch (error) {
          this.onSinkError(this.metricsSink.name, error);
        }
      }
    }).pipe(
      Effect.zipRight(
        this.appendEvent(
          "agent_run_started",
          { ...data, process: data.process ?? sampleProcessResources() },
          {
            agentId: data.agentId,
            conversationId: data.conversationId,
          },
        ),
      ),
    );
  }

  recordAgentRunCompleted(
    data: Parameters<TelemetryService["recordAgentRunCompleted"]>[0],
  ): Effect.Effect<void, TelemetryError> {
    this.stopRunSampler(data.runId);
    return this.appendEvent(
      "agent_run_completed",
      { ...data, process: data.process ?? sampleProcessResources() },
      {
        agentId: data.agentId,
        conversationId: data.conversationId,
      },
    );
  }

  recordAgentRunFailed(
    data: Parameters<TelemetryService["recordAgentRunFailed"]>[0],
  ): Effect.Effect<void, TelemetryError> {
    this.stopRunSampler(data.runId);
    return this.appendEvent(
      "agent_run_failed",
      { ...data, process: data.process ?? sampleProcessResources() },
      {
        agentId: data.agentId,
        conversationId: data.conversationId,
      },
    );
  }

  recordLLMUsage(
    data: Parameters<TelemetryService["recordLLMUsage"]>[0],
  ): Effect.Effect<void, TelemetryError> {
    const opts: { agentId?: string; conversationId?: string } = {};
    if (data.agentId !== undefined) opts.agentId = data.agentId;
    if (data.conversationId !== undefined) opts.conversationId = data.conversationId;
    return this.appendEvent("llm_usage", { ...data, process: sampleProcessResources() }, opts);
  }

  recordLLMRetry(
    data: Parameters<TelemetryService["recordLLMRetry"]>[0],
  ): Effect.Effect<void, TelemetryError> {
    const opts: { agentId?: string; conversationId?: string } = {};
    if (data.agentId !== undefined) opts.agentId = data.agentId;
    if (data.conversationId !== undefined) opts.conversationId = data.conversationId;
    return this.appendEvent("llm_retry", data, opts);
  }

  recordToolInvocation(
    data: Parameters<TelemetryService["recordToolInvocation"]>[0],
  ): Effect.Effect<void, TelemetryError> {
    const eventType: TelemetryEventType = data.success ? "tool_invocation" : "tool_error";
    const opts: { agentId?: string; conversationId?: string } = {};
    if (data.agentId !== undefined) opts.agentId = data.agentId;
    if (data.conversationId !== undefined) opts.conversationId = data.conversationId;
    return this.appendEvent(eventType, { ...data, process: sampleProcessResources() }, opts);
  }

  recordCommandExecuted(
    data: Parameters<TelemetryService["recordCommandExecuted"]>[0],
  ): Effect.Effect<void, TelemetryError> {
    return this.appendEvent("command_executed", data);
  }

  recordProcessSample(
    data: Parameters<TelemetryService["recordProcessSample"]>[0],
  ): Effect.Effect<void, TelemetryError> {
    const opts: { agentId?: string; conversationId?: string } = {};
    if (data.agentId !== undefined) opts.agentId = data.agentId;
    if (data.conversationId !== undefined) opts.conversationId = data.conversationId;
    return this.appendEvent("process_sample", data, opts);
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

        if (options?.conversationId) {
          const conversationId = options.conversationId;
          filtered = filtered.filter((e) => e.conversationId === conversationId);
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
        this.stopAllRunSamplers();
        // Metric reader shutdown performs its own final export. Avoid sending
        // the same terminal measurement once here and again on close.
        yield* Effect.promise(() => this.flushSync(false));
        yield* Effect.promise(async () => {
          await Promise.all(
            this.sinks.map(async (sink) => {
              try {
                await sink.close?.();
              } catch (error) {
                this.onSinkError(sink.name, error);
              }
            }),
          );
        });
      }.bind(this),
    );
  }

  // ── Internal ──────────────────────────────────────────────────

  private startRunSampler(runId: string, agentId: string, conversationId: string): void {
    this.stopRunSampler(runId);
    if (!this.enabled || this.processSampleIntervalMs <= 0) return;

    const timer = setInterval(() => {
      void Effect.runPromise(
        this.recordProcessSample({
          runId,
          process: sampleProcessResources(),
          agentId,
          conversationId,
        }),
      );
    }, this.processSampleIntervalMs);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
    this.runSamplers.set(runId, timer);
  }

  private stopRunSampler(runId: string): void {
    const timer = this.runSamplers.get(runId);
    if (timer === undefined) return;
    clearInterval(timer);
    this.runSamplers.delete(runId);
  }

  private stopAllRunSamplers(): void {
    for (const runId of this.runSamplers.keys()) {
      this.stopRunSampler(runId);
    }
  }

  private appendEvent(
    type: TelemetryEventType,
    data: Record<string, unknown>,
    options?: { readonly agentId?: string; readonly conversationId?: string },
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
          ...(options?.conversationId ? { conversationId: options.conversationId } : {}),
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

  /** Serialize flushes so a timer and a caller cannot duplicate one batch. */
  private flushSync(flushMetrics = true): Promise<void> {
    const next = this.flushChain.then(() => this.flushOnce(flushMetrics));
    this.flushChain = next.catch(() => {});
    return next;
  }

  /** Fan out independently; each failing sink retains only its own pending rows. */
  private async flushOnce(flushMetrics: boolean): Promise<void> {
    if (this.sinks.length === 0) {
      this.enforceBufferCeiling();
      return;
    }
    const newEvents = this.buffer;
    this.buffer = [];
    await Promise.all(
      this.sinks.map(async (sink) => {
        const pending = this.pendingBySink.get(sink) ?? [];
        const events = pending.length === 0 ? newEvents : [...pending, ...newEvents];
        if (events.length > 0) {
          try {
            await sink.write(events);
            this.pendingBySink.delete(sink);
          } catch (error) {
            this.onSinkError(sink.name, error);
            this.pendingBySink.set(sink, this.boundPending(events));
            return;
          }
        }
        if (
          (events.length === 0 && sink.name === "otlp") ||
          (events.length > 0 && sink.name === "otlp-metrics" && flushMetrics)
        ) {
          try {
            await sink.flush?.();
          } catch (error) {
            this.onSinkError(sink.name, error);
          }
        }
      }),
    );
  }

  private boundPending(events: TelemetryEvent[]): TelemetryEvent[] {
    const ceiling = this.bufferSize * MAX_BUFFER_MULTIPLIER;
    if (events.length <= ceiling) return events;
    const dropped = events.length - ceiling;
    this.onEventsDropped(dropped);
    return events.slice(dropped);
  }

  private enforceBufferCeiling(): void {
    this.buffer = this.boundPending(this.buffer);
  }

  private loadAllEvents(): Effect.Effect<TelemetryEvent[], TelemetryError> {
    const reader = this.sinks.find(isEventReader);
    if (!reader) return Effect.succeed([...this.buffer]);

    return Effect.tryPromise({
      try: async () => [
        ...this.buffer,
        ...(this.pendingBySink.get(reader) ?? []),
        ...(await reader.readAll()),
      ],
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
      classifierPromptTokens: number;
      classifierCompletionTokens: number;
      classifierRequests: number;
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
      classifierPromptTokens: 0,
      classifierCompletionTokens: 0,
      classifierRequests: 0,
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

            if (data["purpose"] === "classifier") {
              summary.classifierRequests += 1;
              summary.classifierPromptTokens += usage.promptTokens;
              summary.classifierCompletionTokens += usage.completionTokens;
            }

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

      let resolvedOtlpConfig: ReturnType<typeof resolveOtlpConfig>;
      try {
        resolvedOtlpConfig = resolveOtlpConfig(telemetryConfig?.otlp);
      } catch (error) {
        yield* logger.error("OTLP export disabled by invalid configuration", {
          reason: error instanceof Error ? error.message : "Invalid OTLP endpoint",
        });
      }
      const otlpConfig = resolvedOtlpConfig
        ? {
            ...resolvedOtlpConfig,
            resourceAttributes: {
              ...resolvedOtlpConfig.resourceAttributes,
              "service.instance.id":
                resolvedOtlpConfig.resourceAttributes["service.instance.id"] ?? PROCESS_INSTANCE_ID,
            },
          }
        : undefined;
      let metricsSink: OtlpMetricsSink | undefined;
      if (enabled && otlpConfig?.enabled === true) {
        if (otlpConfig.signals.includes("metrics")) {
          metricsSink = new OtlpMetricsSink(otlpConfig, packageJson.version, () => {
            Effect.runFork(logger.warn("OTLP metrics export failed"));
          });
          sinks.push(metricsSink);
        }
        if (otlpConfig.signals.some((signal) => signal === "traces" || signal === "logs"))
          sinks.push(
            new OtlpTelemetrySink(otlpConfig, packageJson.version, {
              outboxPath: storagePath,
              onExportError: (signal, error) => {
                metricsSink?.recordExportFailure(
                  signal,
                  error.message.includes("partial success") ? "partial" : "request",
                );
                Effect.runFork(logger.warn("OTLP export failed", { signal }));
              },
              onQueueDropped: (count, reason) => {
                metricsSink?.recordDropped(count, reason);
                Effect.runFork(logger.warn("OTLP requests dropped", { dropped: count, reason }));
              },
            }),
          );
      }

      yield* logger.debug("Telemetry service initialized", {
        enabled,
        bufferSize,
        flushIntervalMs,
        retentionDays,
        sinks: sinks.map((sink) => sink.name),
        ...(otlpConfig && {
          otlp: {
            enabled: otlpConfig.enabled,
            captureContent: otlpConfig.captureContent,
            signals: otlpConfig.signals,
          },
        }),
      });

      return new TelemetryServiceImpl({
        enabled,
        bufferSize,
        flushIntervalMs,
        processSampleIntervalMs: DEFAULT_PROCESS_SAMPLE_INTERVAL_MS,
        sinks,
        ...(metricsSink ? { metricsSink } : {}),
        onSinkError: (sinkName) => {
          if (sinkName === "otlp-metrics") metricsSink?.recordExportFailure("metrics", "sink");
          Effect.runFork(
            logger.warn("Telemetry sink write failed", {
              sink:
                sinkName === "otlp" || sinkName === "otlp-metrics" || sinkName === "file"
                  ? sinkName
                  : "unknown",
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
