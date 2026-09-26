/**
 * Projects Jazz's local telemetry events into bounded, content-safe OTLP
 * attributes. Only named fields are exported; unknown event data stays local.
 */

import { createHash } from "node:crypto";
import type {
  TelemetryErrorCategory,
  TelemetryEvent,
  TelemetryEventType,
} from "@jazz/core/interfaces/telemetry";
import { isRecord } from "@jazz/core/utils/is-record";

/**
 * Targeted version of the OpenTelemetry GenAI semantic conventions.
 *
 * These attribute names are still evolving upstream. Pin the version here so a
 * rename upstream is a deliberate, visible change rather than silent drift.
 */
export const GENAI_SEMCONV_VERSION =
  "open-telemetry/semantic-conventions-genai@8ffdf568e1b4391a99adb081db16e8102e36918e";

/** OTLP/JSON `AnyValue`. */
export type OtlpAnyValue =
  | { readonly stringValue: string }
  | { readonly boolValue: boolean }
  | { readonly intValue: string }
  | { readonly doubleValue: number };

export interface OtlpKeyValue {
  readonly key: string;
  readonly value: OtlpAnyValue;
}

export interface OtlpLogRecord {
  readonly timeUnixNano: string;
  readonly observedTimeUnixNano: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly severityNumber: number;
  readonly severityText: string;
  readonly body: { readonly stringValue: string };
  readonly attributes: readonly OtlpKeyValue[];
}

export interface OtlpLogsPayload {
  readonly resourceLogs: readonly {
    readonly resource: { readonly attributes: readonly OtlpKeyValue[] };
    readonly scopeLogs: readonly {
      readonly scope: { readonly name: string; readonly version: string };
      readonly logRecords: readonly OtlpLogRecord[];
    }[];
  }[];
}

/** Only these event fields are safe to export as scalar attributes. */
const SAFE_FIELDS: Record<TelemetryEventType, readonly string[]> = {
  agent_run_started: ["runId", "agentName", "provider", "model"],
  agent_run_completed: [
    "runId",
    "agentName",
    "provider",
    "model",
    "durationMs",
    "iterationsUsed",
    "finished",
    "toolCalls",
    "toolErrors",
  ],
  agent_run_failed: ["runId", "agentName", "durationMs"],
  llm_request: ["runId", "provider", "model", "durationMs", "purpose"],
  llm_usage: ["runId", "durationMs", "purpose"],
  llm_retry: ["runId", "attempt"],
  tool_invocation: ["runId", "toolName", "success", "durationMs"],
  tool_error: ["runId", "toolName", "success", "durationMs"],
  command_executed: ["command", "success", "durationMs"],
  workflow_executed: [],
  workflow_scheduled: [],
  session_started: [],
  session_ended: [],
  process_sample: ["runId"],
  custom: [],
};

const USAGE_FIELDS = [
  "promptTokens",
  "completionTokens",
  "totalTokens",
  "reasoningTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "toolDefinitionTokens",
  "toolResultTokens",
  "toolDefinitionsOffered",
] as const;
const CLASSIFIER_USAGE_FIELDS = [
  "promptTokens",
  "completionTokens",
  "totalTokens",
  "requests",
  "durationMs",
] as const;
const DECISION_USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "requests",
  "durationMs",
  "costUSD",
  "costUnknown",
] as const;
const PROCESS_FIELDS = [
  "rssBytes",
  "heapUsedBytes",
  "heapTotalBytes",
  "externalBytes",
  "cpuUserMs",
  "cpuSystemMs",
] as const;

const MAX_ATTRIBUTE_CHARS_REDACTED = 256;
const MAX_ATTRIBUTE_CHARS_FULL = 8192;

const SEVERITY_BY_EVENT_TYPE: Partial<Record<TelemetryEventType, [number, string]>> = {
  agent_run_failed: [17, "ERROR"],
  tool_error: [17, "ERROR"],
  llm_retry: [13, "WARN"],
  llm_usage: [5, "DEBUG"],
  tool_invocation: [5, "DEBUG"],
  process_sample: [5, "DEBUG"],
};

const DEFAULT_SEVERITY: [number, string] = [9, "INFO"];

const ERROR_CATEGORIES: ReadonlySet<string> = new Set<TelemetryErrorCategory>([
  "authentication",
  "rate_limit",
  "timeout",
  "network",
  "permission",
  "not_found",
  "validation",
  "interrupted",
  "provider",
  "unknown",
]);

/** Stable ids let logs correlate with trace spans even when exported in separate batches. */
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

export function toolSpanIdForCall(runId: string, toolCallId: string): string {
  return deriveId(`jazz-tool:${runId}:${toolCallId}`, 8);
}

export function spanIdForEvent(eventId: string): string {
  return deriveId(`jazz-event:${eventId}`, 8);
}

export interface RunIdentity {
  readonly id: string;
  readonly traceRunId: string;
  readonly isRunScoped: boolean;
  readonly parentRunId?: string;
  readonly parentToolCallId?: string;
}

/** Resolve recursive runs to their original trace while retaining child span identity. */
export function runIdentityOf(event: TelemetryEvent): RunIdentity {
  const runId = event.data["runId"];
  if (typeof runId === "string" && runId.length > 0) {
    const traceParent = event.data["telemetryParent"];
    if (traceParent && typeof traceParent === "object" && !Array.isArray(traceParent)) {
      const parent = traceParent as Record<string, unknown>;
      if (typeof parent["topRunId"] === "string" && typeof parent["parentRunId"] === "string") {
        return {
          id: runId,
          traceRunId: parent["topRunId"],
          isRunScoped: true,
          parentRunId: parent["parentRunId"],
          ...(typeof parent["parentToolCallId"] === "string"
            ? { parentToolCallId: parent["parentToolCallId"] }
            : {}),
        };
      }
    }
    return { id: runId, traceRunId: runId, isRunScoped: true };
  }
  // A conversation without a run is a session, not an emitted root span. Give
  // the event its own trace; langfuse.session.id still groups the conversation.
  return { id: event.id, traceRunId: event.id, isRunScoped: false };
}

export function spanIdentityOf(event: TelemetryEvent): {
  readonly runId: string;
  readonly isRunScoped: boolean;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
} {
  const {
    id: runId,
    traceRunId,
    isRunScoped,
    parentRunId,
    parentToolCallId,
  } = runIdentityOf(event);
  const rootSpanId = rootSpanIdForRun(runId);
  const isRunSpan = event.type === "agent_run_completed" || event.type === "agent_run_failed";
  const isRunStart = event.type === "agent_run_started";
  const isProcessSample = event.type === "process_sample";
  const isToolSpan = event.type === "tool_invocation" || event.type === "tool_error";
  const toolCallId = event.data["toolCallId"];
  const spanId =
    isRunSpan || isRunStart || isProcessSample
      ? rootSpanId
      : isToolSpan && typeof toolCallId === "string" && toolCallId.length > 0
        ? toolSpanIdForCall(runId, toolCallId)
        : spanIdForEvent(event.id);
  const parentSpanId = isRunSpan
    ? parentRunId
      ? parentToolCallId
        ? toolSpanIdForCall(parentRunId, parentToolCallId)
        : rootSpanIdForRun(parentRunId)
      : undefined
    : isRunScoped && !isRunStart && !isProcessSample
      ? rootSpanId
      : undefined;

  return {
    runId,
    isRunScoped,
    traceId: traceIdForRun(traceRunId),
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
  };
}

export function stringAttribute(key: string, value: string): OtlpKeyValue {
  return { key, value: { stringValue: value } };
}

/** int64 is encoded as a string in proto3 JSON. */
export function intAttribute(key: string, value: number): OtlpKeyValue {
  return { key, value: { intValue: String(Math.trunc(value)) } };
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function attributeFromPrimitive(
  key: string,
  value: string | number | boolean,
  maxChars: number,
): OtlpKeyValue {
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? intAttribute(key, value)
      : { key, value: { doubleValue: value } };
  }
  return stringAttribute(key, value.length > maxChars ? value.slice(0, maxChars) : value);
}

function appendSafeScalars(
  data: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  prefix: string,
  attributes: OtlpKeyValue[],
): void {
  for (const field of fields) {
    const value = data[field];
    if (typeof value === "string" || typeof value === "boolean") {
      attributes.push(
        attributeFromPrimitive(`${prefix}${field}`, value, MAX_ATTRIBUTE_CHARS_REDACTED),
      );
    } else if (typeof value === "number" && Number.isFinite(value)) {
      attributes.push(
        attributeFromPrimitive(`${prefix}${field}`, value, MAX_ATTRIBUTE_CHARS_REDACTED),
      );
    }
  }
}

function appendSafeRecord(
  data: Readonly<Record<string, unknown>>,
  field: string,
  fields: readonly string[],
  prefix: string,
  attributes: OtlpKeyValue[],
): void {
  const value = data[field];
  if (!isRecord(value)) return;
  appendSafeScalars(value, fields, prefix, attributes);
}

/** Content is serialized only when the operator explicitly opted in. */
function appendContent(event: TelemetryEvent, attributes: OtlpKeyValue[]): void {
  const data = event.data;
  const input = data["input"] ?? data["prompt"] ?? data["arguments"];
  const output = data["output"] ?? data["completion"] ?? data["result"];
  for (const [key, value] of [
    ["input", input],
    ["output", output],
  ] as const) {
    if (value === undefined || value === null) continue;
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      continue;
    }
    if (typeof serialized !== "string" || serialized.length > MAX_ATTRIBUTE_CHARS_FULL) continue;
    attributes.push(stringAttribute(`langfuse.observation.${key}`, serialized));
  }
}

/**
 * Map a Jazz telemetry event onto GenAI semantic-convention attributes where
 * one exists, and `jazz.*` attributes for everything else.
 */
export function eventToAttributes(event: TelemetryEvent, captureContent: boolean): OtlpKeyValue[] {
  const attributes: OtlpKeyValue[] = [
    stringAttribute("jazz.event.type", event.type),
    stringAttribute("jazz.event.id", event.id),
  ];

  if (event.agentId) attributes.push(stringAttribute("jazz.agent.id", event.agentId));
  if (event.conversationId)
    attributes.push(stringAttribute("jazz.conversation.id", event.conversationId));

  const data = event.data;
  const telemetryParent = data["telemetryParent"];
  const parent =
    telemetryParent && typeof telemetryParent === "object" && !Array.isArray(telemetryParent)
      ? (telemetryParent as Record<string, unknown>)
      : undefined;
  const sessionId = parent?.["sessionId"] ?? event.conversationId ?? data["conversationId"];
  if (typeof sessionId === "string" && sessionId.length > 0) {
    attributes.push(stringAttribute("langfuse.session.id", sessionId));
  }
  if (event.agentId) {
    attributes.push(stringAttribute("langfuse.observation.metadata.agent_id", event.agentId));
  }
  if (typeof data["runId"] === "string") {
    attributes.push(stringAttribute("langfuse.trace.name", "jazz-agent-run"));
  }

  // GenAI attributes describe one model call. An agent run is a rollup of many,
  // so tagging it with them makes observability backends read it as a further
  // LLM call and price its totals on top of the calls they already summarise —
  // double-counting every run's tokens and cost. The rollup keeps its numbers
  // under jazz.* instead.
  const describesSingleLLMCall = event.type === "llm_usage";

  if (describesSingleLLMCall) {
    const provider = data["provider"];
    if (typeof provider === "string") {
      attributes.push(stringAttribute("gen_ai.provider.name", provider));
    }

    const model = data["model"];
    if (typeof model === "string") {
      attributes.push(stringAttribute("gen_ai.request.model", model));
      attributes.push(stringAttribute("gen_ai.response.model", model));
    }

    attributes.push(stringAttribute("gen_ai.operation.name", "chat"));
  }

  const usage = data["usage"];
  if (usage && typeof usage === "object") {
    const usageRecord = usage as Record<string, unknown>;

    if (describesSingleLLMCall) {
      const promptTokens = usageRecord["promptTokens"];
      const completionTokens = usageRecord["completionTokens"];
      if (isTokenCount(promptTokens)) {
        attributes.push(intAttribute("gen_ai.usage.input_tokens", promptTokens));
      }
      if (isTokenCount(completionTokens)) {
        attributes.push(intAttribute("gen_ai.usage.output_tokens", completionTokens));
      }
    }

    if (describesSingleLLMCall) {
      const cacheReadTokens = usageRecord["cacheReadTokens"];
      const cacheWriteTokens = usageRecord["cacheWriteTokens"];
      const reasoningTokens = usageRecord["reasoningTokens"];
      if (isTokenCount(cacheReadTokens)) {
        attributes.push(intAttribute("gen_ai.usage.cache_read.input_tokens", cacheReadTokens));
      }
      if (isTokenCount(cacheWriteTokens)) {
        attributes.push(intAttribute("gen_ai.usage.cache_write.input_tokens", cacheWriteTokens));
      }
      if (isTokenCount(reasoningTokens)) {
        attributes.push(intAttribute("gen_ai.usage.reasoning.output_tokens", reasoningTokens));
      }
    }
    appendSafeScalars(usageRecord, USAGE_FIELDS, "jazz.usage.", attributes);
  }

  appendSafeScalars(data, SAFE_FIELDS[event.type], "jazz.", attributes);
  appendSafeRecord(
    data,
    "classifierUsage",
    CLASSIFIER_USAGE_FIELDS,
    "jazz.classifierUsage.",
    attributes,
  );
  appendSafeRecord(data, "decisionUsage", DECISION_USAGE_FIELDS, "jazz.decisionUsage.", attributes);
  appendSafeRecord(data, "process", PROCESS_FIELDS, "jazz.process.", attributes);
  if (
    event.type === "agent_run_failed" ||
    event.type === "tool_error" ||
    event.type === "llm_retry"
  ) {
    const category = data["error"];
    attributes.push(
      stringAttribute(
        "error.type",
        typeof category === "string" && ERROR_CATEGORIES.has(category) ? category : event.type,
      ),
    );
  }
  if (captureContent) appendContent(event, attributes);

  return attributes;
}

export function toLogRecord(event: TelemetryEvent, captureContent: boolean): OtlpLogRecord {
  const timeUnixNano = String(BigInt(new Date(event.timestamp).getTime()) * 1_000_000n);
  const [severityNumber, severityText] = SEVERITY_BY_EVENT_TYPE[event.type] ?? DEFAULT_SEVERITY;
  const runId = event.data["runId"];
  const hasEventSpan =
    event.type !== "agent_run_started" &&
    event.type !== "command_executed" &&
    event.type !== "process_sample";
  const spanContext =
    (typeof runId === "string" && runId.length > 0) || hasEventSpan
      ? spanIdentityOf(event)
      : undefined;

  return {
    timeUnixNano,
    observedTimeUnixNano: timeUnixNano,
    ...(spanContext ? { traceId: spanContext.traceId, spanId: spanContext.spanId } : {}),
    severityNumber,
    severityText,
    body: { stringValue: event.type },
    attributes: eventToAttributes(event, captureContent),
  };
}

/** Attributes describing the process, shared by the logs and traces payloads. */
export interface ResourceOptions {
  readonly serviceName: string;
  readonly serviceVersion: string;
  /** Operator-supplied extras, e.g. `deployment.environment`. */
  readonly resourceAttributes?: Readonly<Record<string, string>>;
}

/**
 * The OTLP resource attributes for a Jazz process: the identifiers Jazz sets
 * itself, followed by any operator-supplied extras. Jazz's own keys win, so a
 * stray `service.name` in `resourceAttributes` cannot shadow the resolved one.
 */
export function buildResourceAttributes(options: ResourceOptions): OtlpKeyValue[] {
  const reserved = new Set([
    "service.name",
    "service.version",
    "telemetry.sdk.name",
    "telemetry.sdk.language",
  ]);
  const attributes = [
    stringAttribute("service.name", options.serviceName),
    stringAttribute("service.version", options.serviceVersion),
    stringAttribute("telemetry.sdk.name", "jazz"),
    stringAttribute("telemetry.sdk.language", "nodejs"),
  ];
  for (const [key, value] of Object.entries(options.resourceAttributes ?? {})) {
    if (reserved.has(key)) continue;
    attributes.push(stringAttribute(key, value));
  }
  return attributes;
}

export function buildLogsPayload(
  events: readonly TelemetryEvent[],
  options: ResourceOptions & {
    readonly captureContent: boolean;
  },
): OtlpLogsPayload {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: buildResourceAttributes(options),
        },
        scopeLogs: [
          {
            scope: { name: "jazz", version: options.serviceVersion },
            logRecords: events.map((event) => toLogRecord(event, options.captureContent)),
          },
        ],
      },
    ],
  };
}
