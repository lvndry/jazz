/**
 * OTLP/HTTP trace and log exporter with per-signal disk delivery.
 *
 * Payloads are mapped before they enter the bounded outbox. Successful and
 * permanently rejected requests are acknowledged independently, so one signal
 * or the local file sink never masks another signal's delivery failure.
 */

import type { TelemetryEvent } from "@jazz/core/interfaces/telemetry";
import { toError } from "@jazz/core/utils/errors";
import type { OtlpSignal, ResolvedOtlpConfig } from "./otlp-config";
import { buildLogsPayload } from "./otlp-mapping";
import { OtlpOutbox } from "./otlp-outbox";
import { buildTracesPayload, isSpanEvent } from "./otlp-trace-mapping";
import type { TelemetrySink } from "./sink";

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 250;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** OTLP permits retries only for these HTTP statuses. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function backoffDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return BASE_BACKOFF_MS * 2 ** (attempt - 1) * (0.5 + Math.random());
}

export interface OtlpSinkDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Storage root for the bounded, restart-safe export outbox. */
  readonly outboxPath?: string;
  readonly onExportError?: (signal: OtlpSignal, error: Error) => void;
  readonly onQueueDropped?: (count: number, reason: "capacity_or_age" | "permanent") => void;
}

type PostOutcome = "accepted" | "rejected" | "retry";

/** Maps Jazz events to OTLP payloads and exports each selected signal. */
export class OtlpTelemetrySink implements TelemetrySink {
  readonly name = "otlp";
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly outbox?: OtlpOutbox;
  private readonly onExportError: (signal: OtlpSignal, error: Error) => void;
  private operation: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: ResolvedOtlpConfig,
    private readonly serviceVersion: string,
    dependencies: OtlpSinkDependencies = {},
  ) {
    this.fetchImpl = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep =
      dependencies.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.onExportError = dependencies.onExportError ?? (() => {});
    if (dependencies.outboxPath) {
      this.outbox = new OtlpOutbox(
        dependencies.outboxPath,
        {
          traces: config.tracesEndpoint,
          logs: config.logsEndpoint,
          metrics: config.metricsEndpoint,
        },
        config.maxQueuedBytes,
        config.maxQueueAgeMs,
        dependencies.onQueueDropped,
      );
    }
  }

  async write(events: readonly TelemetryEvent[]): Promise<void> {
    if (events.length === 0) return;
    return this.serialize(async () => {
      const payloadOptions = {
        serviceName: this.config.serviceName,
        serviceVersion: this.serviceVersion,
        resourceAttributes: this.config.resourceAttributes,
        captureContent: this.config.captureContent,
      };
      const requests: { signal: "traces" | "logs"; body: string }[] = [];
      if (this.config.signals.includes("traces") && events.some(isSpanEvent)) {
        requests.push({
          signal: "traces",
          body: JSON.stringify(buildTracesPayload(events, payloadOptions)),
        });
      }
      if (this.config.signals.includes("logs")) {
        requests.push({
          signal: "logs",
          body: JSON.stringify(buildLogsPayload(events, payloadOptions)),
        });
      }
      if (this.outbox) {
        for (const request of requests) await this.outbox.enqueue(request.signal, request.body);
        await this.drainOutbox();
        return;
      }
      const results = await Promise.allSettled(
        requests.map(async ({ signal, body }) => {
          const outcome = await this.post(signal, body);
          if (outcome !== "accepted") throw new Error(`OTLP ${signal} export ${outcome}`);
        }),
      );
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    });
  }

  /** Retry pending requests, including those recovered from a previous process. */
  async flush(): Promise<void> {
    return this.serialize(() => this.drainOutbox());
  }

  private serialize(run: () => Promise<void>): Promise<void> {
    const next = this.operation.then(run);
    this.operation = next.catch(() => {});
    return next;
  }

  private async drainOutbox(): Promise<void> {
    if (!this.outbox) return;
    await Promise.all(
      (["traces", "logs"] as const)
        .filter((signal) => this.config.signals.includes(signal))
        .map((signal) => this.outbox!.drain(signal, (body) => this.post(signal, body))),
    );
  }

  private async post(signal: "traces" | "logs", body: string): Promise<PostOutcome> {
    const endpoint = signal === "traces" ? this.config.tracesEndpoint : this.config.logsEndpoint;
    const headers = this.config.signalHeaders[signal];
    let lastError = new Error(`OTLP ${signal} export failed`);
    let retryable = true;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let retryAfter: string | null = null;
      try {
        const response = await this.fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body,
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });
        if (response.ok) {
          await this.reportPartialSuccess(signal, response);
          return "accepted";
        }
        lastError = new Error(`OTLP ${signal} endpoint returned HTTP ${response.status}`);
        retryable = isRetryableStatus(response.status);
        retryAfter = response.headers.get("retry-after");
      } catch (error) {
        lastError = toError(error);
        retryable = true;
      }
      if (!retryable) break;
      if (attempt < MAX_ATTEMPTS) await this.sleep(backoffDelayMs(attempt, retryAfter));
    }

    this.onExportError(signal, lastError);
    if (!this.outbox) throw lastError;
    return retryable ? "retry" : "rejected";
  }

  private async reportPartialSuccess(signal: "traces" | "logs", response: Response): Promise<void> {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      this.onExportError(signal, new Error(`OTLP ${signal} response exceeded 4 MiB`));
      return;
    }
    let body = "";
    try {
      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let bytes = 0;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            this.onExportError(signal, new Error(`OTLP ${signal} response exceeded 4 MiB`));
            return;
          }
          body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
      }
    } catch {
      this.onExportError(signal, new Error(`OTLP ${signal} response could not be read`));
      return;
    }
    if (body.length === 0) return;
    try {
      const parsed: unknown = JSON.parse(body);
      if (!parsed || typeof parsed !== "object" || !("partialSuccess" in parsed)) return;
      const partial: unknown = parsed.partialSuccess;
      if (!partial || typeof partial !== "object") return;
      const fields = partial as Record<string, unknown>;
      const rejectedKey = signal === "traces" ? "rejectedSpans" : "rejectedLogRecords";
      const count = Number(fields[rejectedKey] ?? 0);
      const message = fields["errorMessage"];
      if (count > 0 || (typeof message === "string" && message.length > 0)) {
        this.onExportError(signal, new Error(`OTLP ${signal} partial success: ${count} rejected`));
      }
    } catch {
      this.onExportError(signal, new Error(`OTLP ${signal} response was not valid JSON`));
    }
  }
}
