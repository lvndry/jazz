/** Resolves and parses `OtlpTelemetryConfig`/`OTEL_EXPORTER_OTLP_*` env vars into the settings `OtlpTelemetrySink` needs. */

import type { OtlpTelemetryConfig } from "@jazz/core/types/config";

export type OtlpSignal = "traces" | "logs";

export interface ResolvedOtlpConfig {
  readonly enabled: boolean;
  /** Signals to export. Traces are what LLM-observability backends accept. */
  readonly signals: readonly OtlpSignal[];
  /** Full URL to POST spans to, including the `/v1/traces` path. */
  readonly tracesEndpoint: string;
  /** Full URL to POST log records to, including the `/v1/logs` path. */
  readonly logsEndpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly serviceName: string;
  /**
   * Resource attributes beyond `service.name`, e.g. `deployment.environment`.
   * Attached to every exported span and log record.
   */
  readonly resourceAttributes: Readonly<Record<string, string>>;
  readonly captureContent: boolean;
  readonly timeoutMs: number;
}

const DEFAULT_SERVICE_NAME = "jazz";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_SIGNALS: readonly OtlpSignal[] = ["traces"];

/**
 * Decode a W3C Baggage value: comma-separated `key=value` pairs with
 * percent-encoded values. Both `OTEL_EXPORTER_OTLP_HEADERS` and
 * `OTEL_RESOURCE_ATTRIBUTES` use this format.
 */
function parseBaggagePairs(raw: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    if (key.length === 0) continue;
    try {
      pairs[key] = decodeURIComponent(value);
    } catch {
      pairs[key] = value;
    }
  }
  return pairs;
}

/** Decode an `OTEL_EXPORTER_OTLP_HEADERS` value. */
export function parseOtlpHeaders(raw: string): Record<string, string> {
  return parseBaggagePairs(raw);
}

/**
 * Decode an `OTEL_RESOURCE_ATTRIBUTES` value into resource attributes attached
 * to every exported record — the standard way operators tag a process with
 * `deployment.environment`, `service.namespace`, `service.instance.id` and the
 * like so a shared collector can filter and route it.
 */
export function parseResourceAttributes(raw: string): Record<string, string> {
  return parseBaggagePairs(raw);
}

/** Join an OTLP base endpoint with a signal path, tolerating a trailing slash. */
export function joinOtlpEndpoint(base: string, signalPath: string): string {
  return `${base.replace(/\/+$/, "")}${signalPath}`;
}

/**
 * Resolve OTLP export settings from config and environment.
 *
 * Precedence is explicit config > environment > default, matching how the rest
 * of Jazz resolves settings. Setting only `OTEL_EXPORTER_OTLP_ENDPOINT` is
 * enough to turn export on — that is the ergonomic operators expect from an
 * OTEL-aware process — but it never turns on `captureContent`, which has to be
 * asked for deliberately.
 */
export function resolveOtlpConfig(
  config: OtlpTelemetryConfig | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedOtlpConfig | undefined {
  const baseEndpoint = config?.endpoint ?? env["OTEL_EXPORTER_OTLP_ENDPOINT"];

  const tracesEndpoint =
    config?.tracesEndpoint ??
    env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] ??
    (baseEndpoint ? joinOtlpEndpoint(baseEndpoint, "/v1/traces") : undefined);

  const logsEndpoint =
    config?.logsEndpoint ??
    env["OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"] ??
    (baseEndpoint ? joinOtlpEndpoint(baseEndpoint, "/v1/logs") : undefined);

  if (tracesEndpoint === undefined && logsEndpoint === undefined) return undefined;

  // A signal whose endpoint could not be resolved is dropped rather than
  // pointed at a guessed URL.
  const requestedSignals = config?.signals ?? DEFAULT_SIGNALS;
  const signals = requestedSignals.filter((signal) =>
    signal === "traces" ? tracesEndpoint !== undefined : logsEndpoint !== undefined,
  );

  // An endpoint alone enables export; `enabled: false` is an explicit opt-out.
  const enabled = config?.enabled ?? true;

  const envHeaders = env["OTEL_EXPORTER_OTLP_HEADERS"];
  const headers = config?.headers ?? (envHeaders ? parseOtlpHeaders(envHeaders) : {});

  const envResourceAttributes = env["OTEL_RESOURCE_ATTRIBUTES"];
  const resourceAttributes =
    config?.resourceAttributes ??
    (envResourceAttributes ? parseResourceAttributes(envResourceAttributes) : {});

  // Per the OTEL spec, an explicit service name wins over `service.name` carried
  // in the resource attributes, which in turn beats the default.
  const serviceName =
    config?.serviceName ??
    env["OTEL_SERVICE_NAME"] ??
    resourceAttributes["service.name"] ??
    DEFAULT_SERVICE_NAME;

  return {
    enabled,
    signals,
    tracesEndpoint: tracesEndpoint ?? "",
    logsEndpoint: logsEndpoint ?? "",
    headers,
    serviceName,
    resourceAttributes,
    captureContent: config?.captureContent ?? false,
    timeoutMs: config?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

/**
 * Header names that must never be echoed into logs or written to disk.
 */
const SENSITIVE_HEADER_PATTERN = /authorization|api[-_]?key|token|secret|cookie/i;

/** Redact credential-bearing header values for logging. */
export function redactHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = SENSITIVE_HEADER_PATTERN.test(key) ? "<redacted>" : value;
  }
  return redacted;
}
