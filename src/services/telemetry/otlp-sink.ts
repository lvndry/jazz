import type { TelemetryEvent } from "@/core/interfaces/telemetry";
import type { ResolvedOtlpConfig } from "./otlp-config";
import { buildLogsPayload } from "./otlp-mapping";
import { buildTracesPayload, isSpanEvent } from "./otlp-trace-mapping";
import type { TelemetrySink } from "./sink";

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 250;

/** 4xx other than 408/429 means the request itself is wrong — retrying cannot help. */
function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

function backoffDelayMs(attempt: number): number {
  return BASE_BACKOFF_MS * 2 ** (attempt - 1);
}

export interface OtlpSinkDependencies {
  /** Injected for testing; defaults to global fetch. */
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Exports telemetry events to an OTLP/HTTP endpoint.
 *
 * Encodes OTLP/JSON by hand rather than pulling in the OpenTelemetry SDK: the
 * payload is a well-specified JSON body, and Jazz's published install stays
 * dependency-free.
 *
 * Traces are the default signal because they are what LLM-observability backends
 * accept — Langfuse ingests OTLP traces and not logs — and what turns a run into
 * a readable waterfall. Logs carry the same events unstructured, for collectors
 * routing to a log store.
 */
export class OtlpTelemetrySink implements TelemetrySink {
  readonly name = "otlp";
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly config: ResolvedOtlpConfig,
    private readonly serviceVersion: string,
    dependencies: OtlpSinkDependencies = {},
  ) {
    this.fetchImpl = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep =
      dependencies.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async write(events: readonly TelemetryEvent[]): Promise<void> {
    if (events.length === 0) return;

    const payloadOptions = {
      serviceName: this.config.serviceName,
      serviceVersion: this.serviceVersion,
      captureContent: this.config.captureContent,
    };

    const sends: Promise<void>[] = [];

    if (this.config.signals.includes("traces") && events.some(isSpanEvent)) {
      sends.push(this.post(this.config.tracesEndpoint, buildTracesPayload(events, payloadOptions)));
    }

    if (this.config.signals.includes("logs")) {
      sends.push(this.post(this.config.logsEndpoint, buildLogsPayload(events, payloadOptions)));
    }

    if (sends.length === 0) return;

    // Both signals carry the same batch; one endpoint failing should not hide
    // the other's outcome, so report only after all have settled.
    const results = await Promise.allSettled(sends);
    const failure = results.find((result) => result.status === "rejected");
    if (failure && failure.status === "rejected") {
      throw failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason));
    }
  }

  private async post(endpoint: string, payload: unknown): Promise<void> {
    const body = JSON.stringify(payload);
    let lastError = new Error(`OTLP export to ${endpoint} failed`);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let retryable: boolean;

      try {
        const response = await this.fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...this.config.headers },
          body,
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });

        if (response.ok) return;

        lastError = new Error(
          `OTLP endpoint ${endpoint} returned ${response.status} ${response.statusText}`,
        );
        retryable = isRetryableStatus(response.status);
      } catch (error) {
        // Network failures and timeouts are transient by nature.
        lastError = error instanceof Error ? error : new Error(String(error));
        retryable = true;
      }

      if (!retryable) break;
      if (attempt < MAX_ATTEMPTS) await this.sleep(backoffDelayMs(attempt));
    }

    throw lastError;
  }
}
