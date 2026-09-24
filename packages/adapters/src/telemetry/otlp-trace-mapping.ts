/** Builds connected OTLP spans from safe Jazz telemetry events, including recursive agent runs. */

import type { TelemetryEvent } from "@jazz/core/interfaces/telemetry";
import {
  buildResourceAttributes,
  eventToAttributes,
  type OtlpKeyValue,
  type ResourceOptions,
  spanIdentityOf,
  stringAttribute,
} from "./otlp-mapping";
export { rootSpanIdForRun, toolSpanIdForCall, traceIdForRun } from "./otlp-mapping";

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
      return "run-agent";
    }
    case "llm_usage": {
      if (data["purpose"] === "classifier") {
        return "classify-command-risk";
      }
      return "generate-response";
    }
    case "llm_retry":
      return "retry-llm";
    case "tool_invocation":
    case "tool_error":
      return "execute-tool";
    default:
      return event.type;
  }
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
 *
 * `process_sample` is excluded because it is a metric point, not a unit of
 * work. Turning each RSS reading into a span would drown the waterfall.
 */
const NON_SPAN_EVENT_TYPES = new Set(["agent_run_started", "command_executed", "process_sample"]);

export function isSpanEvent(event: TelemetryEvent): boolean {
  return !NON_SPAN_EVENT_TYPES.has(event.type);
}

export function toSpan(event: TelemetryEvent, captureContent: boolean): OtlpSpan {
  const { runId, isRunScoped, traceId, spanId, parentSpanId } = spanIdentityOf(event);
  const isRunSpan = event.type === "agent_run_completed" || event.type === "agent_run_failed";
  const isToolSpan = event.type === "tool_invocation" || event.type === "tool_error";

  const endMs = new Date(event.timestamp).getTime();
  const startMs = endMs - durationOf(event);

  const isError = ERROR_EVENT_TYPES.has(event.type);

  const attributes = [
    ...eventToAttributes(event, captureContent),
    ...(isRunScoped ? [stringAttribute("jazz.run.id", runId)] : []),
  ];
  if (isRunSpan) {
    attributes.push(stringAttribute("langfuse.observation.type", "agent"));
    attributes.push(stringAttribute("gen_ai.operation.name", "invoke_agent"));
    const agentName = event.data["agentName"];
    if (typeof agentName === "string") {
      attributes.push(stringAttribute("gen_ai.agent.name", agentName.slice(0, 256)));
    }
  } else if (event.type === "llm_usage") {
    attributes.push(stringAttribute("langfuse.observation.type", "generation"));
  } else if (isToolSpan) {
    attributes.push(stringAttribute("langfuse.observation.type", "tool"));
    attributes.push(stringAttribute("gen_ai.operation.name", "execute_tool"));
    const toolName = event.data["toolName"];
    if (typeof toolName === "string") {
      attributes.push(stringAttribute("gen_ai.tool.name", toolName.slice(0, 256)));
    }
  } else if (event.type === "llm_retry") {
    attributes.push(stringAttribute("langfuse.observation.type", "event"));
    attributes.push(stringAttribute("langfuse.observation.level", "WARNING"));
  } else {
    attributes.push(stringAttribute("langfuse.observation.type", "span"));
  }
  if (isError) attributes.push(stringAttribute("langfuse.observation.level", "ERROR"));

  return {
    traceId,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    name: spanNameOf(event),
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: toNanos(startMs),
    endTimeUnixNano: toNanos(endMs),
    attributes,
    status: {
      code: isError ? STATUS_ERROR : STATUS_UNSET,
      ...(isError
        ? { message: event.type === "tool_error" ? "Tool invocation failed" : "Agent run failed" }
        : {}),
    },
  };
}

export function buildTracesPayload(
  events: readonly TelemetryEvent[],
  options: ResourceOptions & {
    readonly captureContent: boolean;
  },
): OtlpTracesPayload {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: buildResourceAttributes(options),
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
