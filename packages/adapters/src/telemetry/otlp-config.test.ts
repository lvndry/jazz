import { describe, expect, it } from "bun:test";
import {
  joinOtlpEndpoint,
  parseOtlpHeaders,
  redactHeaders,
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
});

describe("resolveOtlpConfig", () => {
  it("returns undefined when no endpoint is configured anywhere", () => {
    expect(resolveOtlpConfig(undefined, {})).toBeUndefined();
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

  it("drops a signal whose endpoint cannot be resolved rather than guessing one", () => {
    const resolved = resolveOtlpConfig(
      {
        tracesEndpoint: "https://langfuse.example/api/public/otel/v1/traces",
        signals: ["traces", "logs"],
      },
      {},
    );

    expect(resolved?.signals).toEqual(["traces"]);
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
});

describe("redactHeaders", () => {
  it("masks credential-bearing headers", () => {
    expect(
      redactHeaders({
        authorization: "Basic secret",
        "x-api-key": "abc",
        "x-tenant": "acme",
      }),
    ).toEqual({
      authorization: "<redacted>",
      "x-api-key": "<redacted>",
      "x-tenant": "acme",
    });
  });
});
