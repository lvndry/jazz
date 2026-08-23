import { createHash } from "node:crypto";
import type { TelemetryEvent } from "@/core/interfaces/telemetry";
import { eventToAttributes, stringAttribute, type OtlpKeyValue } from "./otlp-mapping";

/** OTLP span kind. Everything Jazz emits is INTERNAL work inside one process. */
const SPAN_KIND_INTERNAL = 1;

const STATUS_UNSET = 0;
const STATUS_ERROR = 2;

export interface OtlpSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: number;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly attributes: readonly OtlpKeyValue[];
  readonly status: { readonly code: number; readonly message?: string };
}

export interface OtlpTracesPayload {
  readonly resourceSpans: readonly {
    readonly resource: { readonly attributes: readonly OtlpKeyValue[] };
    readonly scopeSpans: readonly {
      readonly scope: { readonly name: string; readonly version: string };
      readonly spans: readonly OtlpSpan[];
    }[];
  }[];
}

/** Trace ids are 16 bytes of hex, span ids 8. Derive them deterministically. */
function deriveId(seed: string, bytes: number): string {
  return createHash("sha256")
    .update(seed)
    .digest("hex")
    .slice(0, bytes * 2);
}

export function traceIdForRun(runId: string): string {
  return deriveId(`jazz-trace:${runId}`, 16);
}

export function rootSpanIdForRun(runId: string): string {
  return deriveId(`jazz-run:${runId}`, 8);
}

function spanIdForEvent(eventId: string): string {
  return deriveId(`jazz-event:${eventId}`, 8);
}

/**
 * The run an event belongs to.
 *
 * `runId` is what actually groups a trace. Falling back to the conversation and
 * then the event's own id means an event recorded outside a run still produces a
 * valid single-span trace rather than being dropped.
 */
function runIdOf(event: TelemetryEvent): { readonly id: string; readonly isRunScoped: boolean } {
  const runId = event.data["runId"];
  if (typeof runId === "string" && runId.length > 0) return { id: runId, isRunScoped: true };
  if (event.logScope) return { id: event.logScope, isRunScoped: true };
  // Nothing ties this event to a run — `jazz agent list` and other bare CLI
  // commands land here. Give it its own trace rather than parenting it to a
  // root span that will never be emitted.
  return { id: event.id, isRunScoped: false };
}

function toNanos(milliseconds: number): string {
  return String(BigInt(Math.trunc(milliseconds)) * 1_000_000n);
}

function durationOf(event: TelemetryEvent): number {
  const durationMs = event.data["durationMs"];
  return typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0
    ? durationMs
    : 0;
}

function spanNameOf(event: TelemetryEvent): string {
  const data = event.data;
  switch (event.type) {
    case "agent_run_completed":
    case "agent_run_failed": {
      const agentName = data["agentName"];
      return typeof agentName === "string" ? `agent ${agentName}` : "agent run";
    }
    case "llm_usage": {
      // GenAI semconv names a chat span "{operation} {model}".
      const model = data["model"];
      return typeof model === "string" ? `chat ${model}` : "chat";
    }
    case "llm_retry":
      return "llm retry";
    case "tool_invocation":
    case "tool_error": {
      const toolName = data["toolName"];
      return typeof toolName === "string" ? `tool ${toolName}` : "tool";
    }
    default:
      return event.type;
  }
}

function errorMessageOf(event: TelemetryEvent): string | undefined {
  const error = event.data["error"];
  return typeof error === "string" && error.length > 0 ? error : undefined;
}

const ERROR_EVENT_TYPES = new Set(["agent_run_failed", "tool_error"]);

/**
 * Event types that do not become spans.
 *
 * `agent_run_started` is excluded because the run's span is built entirely from
 * the terminal event, which carries `durationMs`. Deriving both endpoints from
 * one event keeps the mapping stateless — no correlation buffer waiting for a
 * matching start, and nothing lost when a process exits mid-run.
 *
 * `command_executed` is excluded because a CLI invocation is not agent work. It
 * carries no run id, so it could only ever be its own root, which meant every
 * command emitted a second single-span trace next to the run it wrapped — half
 * the trace list was noise. Commands that spawn no run (`jazz agent list`) now
 * produce no trace at all, which is the honest answer: there was nothing to
 * observe. The event is still recorded locally and exported as a log record.
 */
const NON_SPAN_EVENT_TYPES = new Set(["agent_run_started", "command_executed"]);

export function isSpanEvent(event: TelemetryEvent): boolean {
  return !NON_SPAN_EVENT_TYPES.has(event.type);
}

export function toSpan(event: TelemetryEvent, captureContent: boolean): OtlpSpan {
  const { id: runId, isRunScoped } = runIdOf(event);
  const traceId = traceIdForRun(runId);
  const rootSpanId = rootSpanIdForRun(runId);

  const isRunSpan = event.type === "agent_run_completed" || event.type === "agent_run_failed";
  const isRoot = isRunSpan || !isRunScoped;
  const spanId = isRunSpan ? rootSpanId : spanIdForEvent(event.id);

  const endMs = new Date(event.timestamp).getTime();
  const startMs = endMs - durationOf(event);

  const errorMessage = errorMessageOf(event);
  const isError = ERROR_EVENT_TYPES.has(event.type);

  const attributes = [
    ...eventToAttributes(event, captureContent),
    stringAttribute("jazz.run.id", runId),
  ];

  return {
    traceId,
    spanId,
    ...(isRoot ? {} : { parentSpanId: rootSpanId }),
    name: spanNameOf(event),
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: toNanos(startMs),
    endTimeUnixNano: toNanos(endMs),
    attributes,
    status: {
      code: isError ? STATUS_ERROR : STATUS_UNSET,
      ...(isError && errorMessage ? { message: errorMessage } : {}),
    },
  };
}

export function buildTracesPayload(
  events: readonly TelemetryEvent[],
  options: {
    readonly serviceName: string;
    readonly serviceVersion: string;
    readonly captureContent: boolean;
  },
): OtlpTracesPayload {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            stringAttribute("service.name", options.serviceName),
            stringAttribute("service.version", options.serviceVersion),
            stringAttribute("telemetry.sdk.name", "jazz"),
            stringAttribute("telemetry.sdk.language", "nodejs"),
          ],
        },
        scopeSpans: [
          {
            scope: { name: "jazz", version: options.serviceVersion },
            spans: events.filter(isSpanEvent).map((event) => toSpan(event, options.captureContent)),
          },
        ],
      },
    ],
  };
}
