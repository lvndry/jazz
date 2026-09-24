import { describe, expect, it } from "bun:test";
import {
  joinOtlpEndpoint,
  parseOtlpHeaders,
  parseResourceAttributes,
  resolveOtlpConfig,
} from "./otlp-config";

describe("parseOtlpHeaders", () => {
  it("parses comma-separated key=value pairs", () => {
    expect(parseOtlpHeaders("api-key=abc,x-tenant=acme")).toEqual({
      "api-key": "abc",
      "x-tenant": "acme",
    });
  });

  it("percent-decodes values per the W3C Baggage format", () => {
    expect(parseOtlpHeaders("authorization=Basic%20cHViOnNlYw%3D%3D")).toEqual({
      authorization: "Basic cHViOnNlYw==",
    });
  });

  it("keeps values containing '=' intact", () => {
    expect(parseOtlpHeaders("authorization=Basic cHVi==")).toEqual({
      authorization: "Basic cHVi==",
    });
  });

  it("skips malformed pairs instead of throwing", () => {
    expect(parseOtlpHeaders("novalue,=orphan,good=1")).toEqual({ good: "1" });
  });

  it("rejects prototype keys, invalid header names, and decoded line breaks", () => {
    const headers = parseOtlpHeaders(
      "__proto__=polluted,constructor=x,prototype=y,bad name=x,X-Break=%0D%0Aevil,Authorization=ok",
    );
    expect(headers).toEqual({ Authorization: "ok" });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

describe("joinOtlpEndpoint", () => {
  it("appends the signal path", () => {
    expect(joinOtlpEndpoint("http://localhost:4318", "/v1/logs")).toBe(
      "http://localhost:4318/v1/logs",
    );
  });

  it("tolerates trailing slashes", () => {
    expect(joinOtlpEndpoint("http://localhost:4318///", "/v1/logs")).toBe(
      "http://localhost:4318/v1/logs",
    );
  });

  it("preserves a base URL query while appending the signal path", () => {
    expect(joinOtlpEndpoint("https://collector.test/otlp?tenant=one", "/v1/metrics")).toBe(
      "https://collector.test/otlp/v1/metrics?tenant=one",
    );
  });
});

describe("resolveOtlpConfig", () => {
  it("returns undefined when no endpoint is configured anywhere", () => {
    expect(resolveOtlpConfig(undefined, {})).toBeUndefined();
  });

  it("rejects empty, non-HTTP, and credential-bearing endpoints", () => {
    expect(() => resolveOtlpConfig({ endpoint: "" }, {})).toThrow("telemetry.otlp.endpoint");
    expect(() => resolveOtlpConfig({ endpoint: "file:///tmp/collector" }, {})).toThrow(
      "telemetry.otlp.endpoint",
    );
    expect(() => resolveOtlpConfig({ endpoint: "https://user:secret@collector.test" }, {})).toThrow(
      "telemetry.otlp.endpoint",
    );
  });

  it("reports an invalid explicit endpoint even when an environment endpoint is valid", () => {
    expect(() =>
      resolveOtlpConfig(
        { endpoint: "invalid://configured" },
        { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" },
      ),
    ).toThrow("telemetry.otlp.endpoint");
  });

  it("reports invalid environment and selected signal endpoints", () => {
    expect(() =>
      resolveOtlpConfig(undefined, { OTEL_EXPORTER_OTLP_ENDPOINT: "not-a-url" }),
    ).toThrow("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(() =>
      resolveOtlpConfig({ logsEndpoint: "http://collector/v1/logs", signals: ["traces"] }, {}),
    ).toThrow("OTLP traces export is selected but has no endpoint");
    expect(() => resolveOtlpConfig({ endpoint: "http://collector:4318", signals: [] }, {})).toThrow(
      "OTLP signals must select at least one signal",
    );
  });

  it("sanitizes explicit header and resource maps at the boundary", () => {
    const resolved = resolveOtlpConfig(
      {
        endpoint: "https://collector.test",
        headers: { "X-Good": "ok", "bad name": "x", "X-Break": "a\r\nb" },
        resourceAttributes: { "deployment.environment": "test", "bad key": "x" },
      },
      {},
    );
    expect(resolved?.headers).toEqual({ "X-Good": "ok" });
    expect(resolved?.resourceAttributes).toEqual({ "deployment.environment": "test" });
  });

  it("enables export from the environment alone", () => {
    const resolved = resolveOtlpConfig(undefined, {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
    });

    expect(resolved?.enabled).toBe(true);
    expect(resolved?.tracesEndpoint).toBe("http://collector:4318/v1/traces");
    expect(resolved?.logsEndpoint).toBe("http://collector:4318/v1/logs");
  });

  it("defaults to traces, the signal LLM-observability backends accept", () => {
    const resolved = resolveOtlpConfig(undefined, {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
    });

    expect(resolved?.signals).toEqual(["traces"]);
  });

  it("honours an explicit signal selection", () => {
    const resolved = resolveOtlpConfig(
      { endpoint: "http://collector:4318", signals: ["traces", "logs"] },
      {},
    );

    expect(resolved?.signals).toEqual(["traces", "logs"]);
  });

  it("resolves metrics-only endpoints without guessing a traces endpoint", () => {
    const resolved = resolveOtlpConfig(undefined, {
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://prometheus.test/api/v1/otlp/v1/metrics",
    });
    expect(resolved?.signals).toEqual(["metrics"]);
    expect(resolved?.metricsEndpoint).toBe("https://prometheus.test/api/v1/otlp/v1/metrics");
  });

  it("uses signal-specific environment headers for each signal", () => {
    const resolved = resolveOtlpConfig(undefined, {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.test",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20common",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "authorization=Bearer%20trace",
      OTEL_EXPORTER_OTLP_METRICS_HEADERS: "x-metrics-key=abc",
    });
    expect(resolved?.signalHeaders.traces).toEqual({ authorization: "Bearer trace" });
    expect(resolved?.signalHeaders.logs).toEqual({ authorization: "Bearer common" });
    expect(resolved?.signalHeaders.metrics).toEqual({ "x-metrics-key": "abc" });
  });

  it("uses a valid OTLP timeout from the environment", () => {
    const resolved = resolveOtlpConfig(undefined, {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_EXPORTER_OTLP_TIMEOUT: "2500",
    });
    expect(resolved?.timeoutMs).toBe(2500);
  });

  it("reports a selected signal whose endpoint cannot be resolved", () => {
    expect(() =>
      resolveOtlpConfig(
        {
          tracesEndpoint: "https://langfuse.example/api/public/otel/v1/traces",
          signals: ["traces", "logs"],
        },
        {},
      ),
    ).toThrow("OTLP logs export is selected but has no endpoint");
  });

  it("never enables content capture from the environment", () => {
    const resolved = resolveOtlpConfig(undefined, {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
    });

    expect(resolved?.captureContent).toBe(false);
  });

  it("prefers explicit config over the environment", () => {
    const resolved = resolveOtlpConfig(
      { endpoint: "http://configured:4318", serviceName: "jazz-prod" },
      { OTEL_EXPORTER_OTLP_ENDPOINT: "http://env:4318", OTEL_SERVICE_NAME: "from-env" },
    );

    expect(resolved?.logsEndpoint).toBe("http://configured:4318/v1/logs");
    expect(resolved?.serviceName).toBe("jazz-prod");
  });

  it("prefers the signal-specific endpoint and uses it verbatim", () => {
    const resolved = resolveOtlpConfig(undefined, {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://cloud.langfuse.com/api/public/otel/v1/traces",
    });

    expect(resolved?.tracesEndpoint).toBe("https://cloud.langfuse.com/api/public/otel/v1/traces");
    // The base URL still resolves the other signal.
    expect(resolved?.logsEndpoint).toBe("http://collector:4318/v1/logs");
  });

  it("honours an explicit opt-out while keeping the endpoint", () => {
    const resolved = resolveOtlpConfig(
      { enabled: false },
      { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" },
    );

    expect(resolved?.enabled).toBe(false);
    expect(resolved?.tracesEndpoint).toBe("http://collector:4318/v1/traces");
  });

  it("reads headers from the environment", () => {
    const resolved = resolveOtlpConfig(undefined, {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20token",
    });

    expect(resolved?.headers).toEqual({ authorization: "Bearer token" });
  });

  it("reads resource attributes from the environment", () => {
    const resolved = resolveOtlpConfig(undefined, {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=production,service.namespace=ksyl",
    });

    expect(resolved?.resourceAttributes).toEqual({
      "deployment.environment": "production",
      "service.namespace": "ksyl",
    });
  });

  it("takes service.name from the resource attributes when nothing else sets it", () => {
    const resolved = resolveOtlpConfig(undefined, {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_RESOURCE_ATTRIBUTES: "service.name=ksyl-reviewer,deployment.environment=production",
    });

    expect(resolved?.serviceName).toBe("ksyl-reviewer");
  });

  it("lets OTEL_SERVICE_NAME win over service.name in the resource attributes", () => {
    const resolved = resolveOtlpConfig(undefined, {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_SERVICE_NAME: "explicit",
      OTEL_RESOURCE_ATTRIBUTES: "service.name=from-attrs",
    });

    expect(resolved?.serviceName).toBe("explicit");
  });
});

describe("parseResourceAttributes", () => {
  it("parses comma-separated key=value pairs", () => {
    expect(parseResourceAttributes("deployment.environment=prod,service.namespace=ksyl")).toEqual({
      "deployment.environment": "prod",
      "service.namespace": "ksyl",
    });
  });

  it("skips malformed pairs instead of throwing", () => {
    expect(parseResourceAttributes("novalue,=orphan,good=1")).toEqual({ good: "1" });
  });

  it("rejects prototype keys and malformed resource names", () => {
    expect(
      parseResourceAttributes("__proto__=x,constructor=x,bad%20key=x,service.name=jazz"),
    ).toEqual({
      "service.name": "jazz",
    });
  });
});
