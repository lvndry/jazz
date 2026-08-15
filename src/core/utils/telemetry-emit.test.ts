import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import type { TelemetryService } from "@/core/interfaces/telemetry";
import { TelemetryServiceTag } from "@/core/interfaces/telemetry";
import { TelemetryError } from "@/core/types/errors";
import { emitTelemetry } from "./telemetry-emit";

function stubTelemetry(overrides: Partial<TelemetryService>): TelemetryService {
  const notCalled = () => Effect.void as Effect.Effect<never, TelemetryError>;
  return {
    recordAgentRunStarted: notCalled,
    recordAgentRunCompleted: notCalled,
    recordAgentRunFailed: notCalled,
    recordLLMUsage: notCalled,
    recordLLMRetry: notCalled,
    recordToolInvocation: notCalled,
    recordCommandExecuted: notCalled,
    recordEvent: notCalled,
    getEvents: notCalled,
    getUsageSummary: notCalled,
    flush: notCalled,
    ...overrides,
  } as TelemetryService;
}

describe("emitTelemetry", () => {
  it("is a no-op when no telemetry service is provided", async () => {
    // Test layers routinely omit telemetry; instrumenting a call site must not
    // break them.
    await Effect.runPromise(emitTelemetry(() => Effect.void));
  });

  it("calls the service when one is present", async () => {
    let called = false;
    const telemetry = stubTelemetry({
      recordEvent: () =>
        Effect.sync(() => {
          called = true;
        }),
    });

    await Effect.runPromise(
      emitTelemetry((service) => service.recordEvent("custom", {})).pipe(
        Effect.provide(Layer.succeed(TelemetryServiceTag, telemetry)),
      ),
    );

    expect(called).toBe(true);
  });

  it("swallows telemetry failures rather than failing the caller", async () => {
    const telemetry = stubTelemetry({
      recordEvent: () =>
        Effect.fail(new TelemetryError({ operation: "write", message: "disk full" })),
    });

    await Effect.runPromise(
      emitTelemetry((service) => service.recordEvent("custom", {})).pipe(
        Effect.provide(Layer.succeed(TelemetryServiceTag, telemetry)),
      ),
    );
  });

  it("swallows defects thrown by the service", async () => {
    const telemetry = stubTelemetry({
      recordEvent: () => {
        throw new Error("boom");
      },
    });

    await Effect.runPromise(
      emitTelemetry((service) => service.recordEvent("custom", {})).pipe(
        Effect.provide(Layer.succeed(TelemetryServiceTag, telemetry)),
      ),
    );
  });
});
