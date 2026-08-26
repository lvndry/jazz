import type { TelemetryEvent } from "@jazz/core/interfaces/telemetry";

/**
 * A destination for telemetry events.
 *
 * Sinks are plain promise-based so they can be driven both from Effect code
 * and from the service's timer-based flush, which runs outside any Effect
 * context. A sink that rejects is logged and skipped — one broken destination
 * must never stop the others or reach the agent loop.
 */
export interface TelemetrySink {
  /** Stable identifier used in log messages. */
  readonly name: string;
  /** Persist or transmit a batch of events. */
  readonly write: (events: readonly TelemetryEvent[]) => Promise<void>;
  /** Release any resources held by the sink. */
  readonly close?: () => Promise<void>;
}

/**
 * A sink that can also read back what it stored, backing `getEvents` and
 * `getUsageSummary`. Only the local file sink implements this — an OTLP
 * collector is write-only from Jazz's point of view.
 */
export interface TelemetryEventReader {
  readonly readAll: () => Promise<TelemetryEvent[]>;
}

export function isEventReader(sink: TelemetrySink): sink is TelemetrySink & TelemetryEventReader {
  return typeof (sink as Partial<TelemetryEventReader>).readAll === "function";
}
