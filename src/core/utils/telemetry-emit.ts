import { Context, Effect } from "effect";
import type { TelemetryService } from "@/core/interfaces/telemetry";
import { TelemetryServiceTag } from "@/core/interfaces/telemetry";

/**
 * Emit a telemetry event without adding `TelemetryService` to the caller's `R`.
 *
 * The service is looked up through the ambient context rather than required as
 * a dependency, so instrumenting a call site never changes its type signature
 * and never breaks test layers that omit telemetry. Failures are swallowed:
 * telemetry must never fail a run.
 */
export function emitTelemetry(
  emit: (telemetry: TelemetryService) => Effect.Effect<void, unknown>,
): Effect.Effect<void> {
  return Effect.flatMap(Effect.context<never>(), (context) => {
    const maybeTelemetry = Context.getOption(context, TelemetryServiceTag);
    if (maybeTelemetry._tag === "None") return Effect.void;
    // `Effect.suspend` brings a synchronous throw from `emit` itself into the
    // effect as a defect, so `catchAllDefect` can absorb it along with any
    // defect raised while running.
    return Effect.suspend(() => emit(maybeTelemetry.value));
  }).pipe(
    Effect.catchAll(() => Effect.void),
    Effect.catchAllDefect(() => Effect.void),
  );
}
