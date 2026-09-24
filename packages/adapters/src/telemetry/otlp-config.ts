/** Resolves and parses `OtlpTelemetryConfig`/`OTEL_EXPORTER_OTLP_*` env vars into the settings `OtlpTelemetrySink` needs. */

import type { OtlpTelemetryConfig } from "@jazz/core/types/config";

export type OtlpSignal = "traces" | "logs" | "metrics";

export interface ResolvedOtlpConfig {
  readonly enabled: boolean;
  /** Signals to export. Traces are what LLM-observability backends accept. */
  readonly signals: readonly OtlpSignal[];
  /** Full URL to POST spans to, including the `/v1/traces` path. */
  readonly tracesEndpoint: string;
  /** Full URL to POST log records to, including the `/v1/logs` path. */
  readonly logsEndpoint: string;
  /** Full URL to POST metrics to, including the `/v1/metrics` path. */
  readonly metricsEndpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signalHeaders: Readonly<Record<OtlpSignal, Readonly<Record<string, string>>>>;
  readonly serviceName: string;
  /**
   * Resource attributes beyond `service.name`, e.g. `deployment.environment`.
   * Attached to every exported span and log record.
   */
  readonly resourceAttributes: Readonly<Record<string, string>>;
  readonly captureContent: boolean;
  readonly timeoutMs: number;
  readonly maxQueuedBytes: number;
  readonly maxQueueAgeMs: number;
  readonly metricExportIntervalMs: number;
}

const DEFAULT_SERVICE_NAME = "jazz";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_QUEUED_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_QUEUE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_METRIC_EXPORT_INTERVAL_MS = 30_000;
const DEFAULT_SIGNALS: readonly OtlpSignal[] = ["traces"];

function positiveIntegerEnv(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function endpoint(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value);
    if (
      !(["http:", "https:"].includes(url.protocol) && url.hostname) ||
      url.username ||
      url.password
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function sanitizePairs(
  values: Readonly<Record<string, string>>,
  validKey: RegExp,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([key, value]) =>
        validKey.test(key) &&
        !FORBIDDEN_KEYS.has(key) &&
        typeof value === "string" &&
        !/[\r\n]/.test(value),
    ),
  );
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const HEADER_KEY = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const RESOURCE_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,255}$/;

/**
 * Decode comma-separated `key=value` pairs with percent-encoded values,
 * rejecting keys and line breaks that cannot safely cross HTTP boundaries.
 */
function parseBaggagePairs(raw: string, validKey: RegExp): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    if (!validKey.test(key) || FORBIDDEN_KEYS.has(key)) continue;
    try {
      const decoded = decodeURIComponent(value);
      if (!/[\r\n]/.test(decoded)) pairs[key] = decoded;
    } catch {
      if (!/[\r\n]/.test(value)) pairs[key] = value;
    }
  }
  return pairs;
}

/** Decode an `OTEL_EXPORTER_OTLP_HEADERS` value. */
export function parseOtlpHeaders(raw: string): Record<string, string> {
  return parseBaggagePairs(raw, HEADER_KEY);
}

/**
 * Decode an `OTEL_RESOURCE_ATTRIBUTES` value into resource attributes attached
 * to every exported record — the standard way operators tag a process with
 * `deployment.environment`, `service.namespace`, `service.instance.id` and the
 * like so a shared collector can filter and route it.
 */
export function parseResourceAttributes(raw: string): Record<string, string> {
  return parseBaggagePairs(raw, RESOURCE_KEY);
}

/** Join an OTLP base endpoint with a signal path, tolerating a trailing slash. */
export function joinOtlpEndpoint(base: string, signalPath: string): string {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${signalPath}`;
  return url.toString();
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
  const baseEndpoint = endpoint(config?.endpoint ?? env["OTEL_EXPORTER_OTLP_ENDPOINT"]);

  const tracesEndpoint = endpoint(
    config?.tracesEndpoint ??
      env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] ??
      (baseEndpoint ? joinOtlpEndpoint(baseEndpoint, "/v1/traces") : undefined),
  );

  const logsEndpoint = endpoint(
    config?.logsEndpoint ??
      env["OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"] ??
      (baseEndpoint ? joinOtlpEndpoint(baseEndpoint, "/v1/logs") : undefined),
  );

  const metricsEndpoint = endpoint(
    config?.metricsEndpoint ??
      env["OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"] ??
      (baseEndpoint ? joinOtlpEndpoint(baseEndpoint, "/v1/metrics") : undefined),
  );

  if (tracesEndpoint === undefined && logsEndpoint === undefined && metricsEndpoint === undefined)
    return undefined;

  // A signal whose endpoint could not be resolved is dropped rather than
  // pointed at a guessed URL.
  const requestedSignals =
    config?.signals ??
    (tracesEndpoint !== undefined
      ? DEFAULT_SIGNALS
      : logsEndpoint !== undefined
        ? (["logs"] as const)
        : (["metrics"] as const));
  const signals = requestedSignals.filter((signal) =>
    signal === "traces"
      ? tracesEndpoint !== undefined
      : signal === "logs"
        ? logsEndpoint !== undefined
        : metricsEndpoint !== undefined,
  );

  // An endpoint alone enables export; `enabled: false` is an explicit opt-out.
  const enabled = config?.enabled ?? true;

  const envHeaders = env["OTEL_EXPORTER_OTLP_HEADERS"];
  const headers = config?.headers
    ? sanitizePairs(config.headers, HEADER_KEY)
    : envHeaders
      ? parseOtlpHeaders(envHeaders)
      : {};
  const signalHeaders = Object.fromEntries(
    (["traces", "logs", "metrics"] as const).map((signal) => {
      const raw = env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_HEADERS`];
      return [signal, config?.headers ? headers : raw ? parseOtlpHeaders(raw) : headers];
    }),
  ) as Record<OtlpSignal, Readonly<Record<string, string>>>;

  const envResourceAttributes = env["OTEL_RESOURCE_ATTRIBUTES"];
  const resourceAttributes = config?.resourceAttributes
    ? sanitizePairs(config.resourceAttributes, RESOURCE_KEY)
    : envResourceAttributes
      ? parseResourceAttributes(envResourceAttributes)
      : {};

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
    metricsEndpoint: metricsEndpoint ?? "",
    headers,
    signalHeaders,
    serviceName,
    resourceAttributes,
    captureContent: config?.captureContent ?? false,
    timeoutMs:
      config?.timeoutMs ??
      positiveIntegerEnv(env["OTEL_EXPORTER_OTLP_TIMEOUT"]) ??
      DEFAULT_TIMEOUT_MS,
    maxQueuedBytes: config?.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES,
    maxQueueAgeMs: config?.maxQueueAgeMs ?? DEFAULT_MAX_QUEUE_AGE_MS,
    metricExportIntervalMs: config?.metricExportIntervalMs ?? DEFAULT_METRIC_EXPORT_INTERVAL_MS,
  };
}
