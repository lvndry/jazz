import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, unlink } from "node:fs/promises";
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
import { TelemetryError, TelemetryWriteError } from "@/core/types/errors";
import { getUserDataDirectory } from "@/core/utils/runtime-detection";

// ── Constants ───────────────────────────────────────────────────────

const DEFAULT_BUFFER_SIZE = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const DEFAULT_RETENTION_DAYS = 90;
const EVENTS_DIR = "events";

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Resolve the default telemetry storage directory.
 * Mirrors the pattern used by the logger for resolving log directories.
 */
function resolveDefaultStoragePath(): string {
  return path.join(getUserDataDirectory(), "telemetry");
}

/**
 * Create a date string suitable for partitioning event files: YYYY-MM-DD.
 */
function datePartition(date: Date): string {
  return date.toISOString().slice(0, 10);
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

export class TelemetryServiceImpl implements TelemetryService {
  private buffer: TelemetryEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private dirCreated = false;

  constructor(
    private readonly storagePath: string,
    private readonly enabled: boolean,
    private readonly bufferSize: number,
    private readonly flushIntervalMs: number,
    private readonly retentionDays: number,
  ) {
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
      sessionId: data.conversationId,
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
    return this.appendEvent("agent_run_completed", data as unknown as Record<string, unknown>, {
      agentId: data.agentId,
      sessionId: data.conversationId,
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
    return this.appendEvent("agent_run_failed", data as unknown as Record<string, unknown>, {
      agentId: data.agentId,
      sessionId: data.conversationId,
    });
  }

  recordLLMUsage(data: {
    readonly provider: string;
    readonly model: string;
    readonly usage: TokenUsage;
    readonly agentId?: string;
    readonly sessionId?: string;
    readonly durationMs?: number;
  }): Effect.Effect<void, TelemetryError> {
    const opts: { agentId?: string; sessionId?: string } = {};
    if (data.agentId !== undefined) opts.agentId = data.agentId;
    if (data.sessionId !== undefined) opts.sessionId = data.sessionId;
    return this.appendEvent("llm_usage", data as unknown as Record<string, unknown>, opts);
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
    return this.appendEvent("llm_retry", data as unknown as Record<string, unknown>, opts);
  }

  recordToolInvocation(data: {
    readonly toolName: string;
    readonly success: boolean;
    readonly durationMs?: number;
    readonly error?: string;
    readonly agentId?: string;
    readonly sessionId?: string;
  }): Effect.Effect<void, TelemetryError> {
    const eventType: TelemetryEventType = data.success ? "tool_invocation" : "tool_error";
    const opts: { agentId?: string; sessionId?: string } = {};
    if (data.agentId !== undefined) opts.agentId = data.agentId;
    if (data.sessionId !== undefined) opts.sessionId = data.sessionId;
    return this.appendEvent(eventType, data as unknown as Record<string, unknown>, opts);
  }

  recordCommandExecuted(data: {
    readonly command: string;
    readonly args?: readonly string[];
    readonly durationMs?: number;
    readonly success: boolean;
    readonly error?: string;
  }): Effect.Effect<void, TelemetryError> {
    return this.appendEvent("command_executed", data as unknown as Record<string, unknown>);
  }

  recordEvent(
    type: TelemetryEventType,
    data: Record<string, unknown>,
    options?: {
      readonly agentId?: string;
      readonly sessionId?: string;
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

        if (options?.sessionId) {
          const sessionId = options.sessionId;
          filtered = filtered.filter((e) => e.sessionId === sessionId);
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
    options?: { readonly agentId?: string; readonly sessionId?: string },
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
          ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
        };

        this.buffer.push(event);

        if (this.buffer.length >= this.bufferSize) {
          yield* this.flushBuffer();
        }
      }.bind(this),
    );
  }

  private flushBuffer(): Effect.Effect<void, TelemetryError> {
    return Effect.gen(
      function* (this: TelemetryServiceImpl) {
        if (this.buffer.length === 0) return;

        const toFlush = [...this.buffer];
        this.buffer = [];

        yield* this.writeEvents(toFlush);
      }.bind(this),
    );
  }

  /**
   * Synchronous flush (used by the interval timer outside of Effect context).
   */
  private async flushSync(): Promise<void> {
    if (this.buffer.length === 0) return;

    const toFlush = [...this.buffer];
    this.buffer = [];

    const eventsDir = path.join(this.storagePath, EVENTS_DIR);

    try {
      if (!this.dirCreated) {
        await mkdir(eventsDir, { recursive: true });
        this.dirCreated = true;
      }

      // Group by date partition
      const grouped = new Map<string, TelemetryEvent[]>();
      for (const event of toFlush) {
        const partition = datePartition(new Date(event.timestamp));
        const existing = grouped.get(partition);
        if (existing) {
          existing.push(event);
        } else {
          grouped.set(partition, [event]);
        }
      }

      for (const [partition, events] of grouped) {
        const filePath = path.join(eventsDir, `${partition}.ndjson`);
        const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
        await appendFile(filePath, lines, { encoding: "utf8" });
      }
    } catch {
      // Re-enqueue events that failed to flush (best-effort)
      this.buffer.unshift(...toFlush);
    }
  }

  private writeEvents(events: readonly TelemetryEvent[]): Effect.Effect<void, TelemetryError> {
    return Effect.gen(
      function* (this: TelemetryServiceImpl) {
        const eventsDir = path.join(this.storagePath, EVENTS_DIR);

        yield* Effect.tryPromise({
          try: async () => {
            if (!this.dirCreated) {
              await mkdir(eventsDir, { recursive: true });
              this.dirCreated = true;
            }
          },
          catch: (error) =>
            new TelemetryWriteError({
              path: eventsDir,
              message: `Failed to create telemetry directory: ${String(error)}`,
              cause: error,
              suggestion: "Check file system permissions for the telemetry storage path.",
            }),
        }).pipe(
          Effect.mapError(
            (err) =>
              new TelemetryError({
                operation: "flush",
                message: err.message,
                cause: err,
              }),
          ),
        );

        // Group events by date partition for file organization
        const grouped = new Map<string, TelemetryEvent[]>();
        for (const event of events) {
          const partition = datePartition(new Date(event.timestamp));
          const existing = grouped.get(partition);
          if (existing) {
            existing.push(event);
          } else {
            grouped.set(partition, [event]);
          }
        }

        for (const [partition, partitionEvents] of grouped) {
          const filePath = path.join(eventsDir, `${partition}.ndjson`);
          const lines = partitionEvents.map((e) => JSON.stringify(e)).join("\n") + "\n";

          yield* Effect.tryPromise({
            try: () => appendFile(filePath, lines, { encoding: "utf8" }),
            catch: (error) =>
              new TelemetryError({
                operation: "write",
                message: `Failed to write telemetry events to ${filePath}: ${String(error)}`,
                cause: error,
                suggestion: "Check file system permissions for the telemetry storage path.",
              }),
          });
        }
      }.bind(this),
    );
  }

  private loadAllEvents(): Effect.Effect<TelemetryEvent[], TelemetryError> {
    return Effect.gen(
      function* (this: TelemetryServiceImpl) {
        const eventsDir = path.join(this.storagePath, EVENTS_DIR);

        const files = yield* Effect.tryPromise({
          try: async () => {
            try {
              return await readdir(eventsDir);
            } catch {
              return [];
            }
          },
          catch: (error) =>
            new TelemetryError({
              operation: "read",
              message: `Failed to list telemetry events directory: ${String(error)}`,
              cause: error,
            }),
        });

        const ndjsonFiles = files.filter((f) => f.endsWith(".ndjson")).sort();
        const allEvents: TelemetryEvent[] = [];

        // Also include buffered (not yet flushed) events
        allEvents.push(...this.buffer);

        for (const file of ndjsonFiles) {
          const filePath = path.join(eventsDir, file);
          const content = yield* Effect.tryPromise({
            try: () => readFile(filePath, { encoding: "utf8" }),
            catch: (error) =>
              new TelemetryError({
                operation: "read",
                message: `Failed to read telemetry file ${filePath}: ${String(error)}`,
                cause: error,
              }),
          });

          const lines = content.split("\n").filter((line) => line.trim().length > 0);
          for (const line of lines) {
            try {
              const event = JSON.parse(line) as TelemetryEvent;
              allEvents.push(event);
            } catch {
              // Skip malformed lines
            }
          }
        }

        return allEvents;
      }.bind(this),
    );
  }

  /**
   * Remove telemetry files older than retentionDays.
   */
  pruneOldEvents(): Effect.Effect<number, TelemetryError> {
    return Effect.gen(
      function* (this: TelemetryServiceImpl) {
        const eventsDir = path.join(this.storagePath, EVENTS_DIR);
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - this.retentionDays);
        const cutoffPartition = datePartition(cutoff);

        const files = yield* Effect.tryPromise({
          try: async () => {
            try {
              return await readdir(eventsDir);
            } catch {
              return [];
            }
          },
          catch: (error) =>
            new TelemetryError({
              operation: "prune",
              message: `Failed to list telemetry directory for pruning: ${String(error)}`,
              cause: error,
            }),
        });

        let pruned = 0;
        for (const file of files) {
          if (!file.endsWith(".ndjson")) continue;
          // File name format: YYYY-MM-DD.ndjson
          const partition = file.replace(".ndjson", "");
          if (partition < cutoffPartition) {
            yield* Effect.tryPromise({
              try: () => unlink(path.join(eventsDir, file)),
              catch: (error) =>
                new TelemetryError({
                  operation: "prune",
                  message: `Failed to delete old telemetry file ${file}: ${String(error)}`,
                  cause: error,
                }),
            });
            pruned += 1;
          }
        }

        return pruned;
      }.bind(this),
    );
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
          if (data["durationMs"] != null) {
            summary.totalDurationMs += Number(data["durationMs"]);
          }
          break;
        }

        case "agent_run_completed": {
          summary.totalAgentRuns += 1;
          if (data["durationMs"] != null) {
            summary.totalDurationMs += Number(data["durationMs"]);
          }
          if (data["toolCalls"] != null) {
            summary.totalToolCalls += Number(data["toolCalls"]);
          }
          if (data["toolErrors"] != null) {
            summary.totalToolErrors += Number(data["toolErrors"]);
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

          // Accumulate tool token usage from agent run
          if (usage) {
            summary.toolDefinitionTokens += usage.toolDefinitionTokens ?? 0;
            summary.toolResultTokens += usage.toolResultTokens ?? 0;
            summary.toolDefinitionsOffered += usage.toolDefinitionsOffered ?? 0;
          }

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

      yield* logger.debug("Telemetry service initialized", {
        enabled,
        storagePath,
        bufferSize,
        flushIntervalMs,
        retentionDays,
      });

      return new TelemetryServiceImpl(
        storagePath,
        enabled,
        bufferSize,
        flushIntervalMs,
        retentionDays,
      );
    }),
  );
}
