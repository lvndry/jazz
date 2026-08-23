import type { TelemetryEvent, TelemetryEventType } from "@/core/interfaces/telemetry";

/**
 * Targeted version of the OpenTelemetry GenAI semantic conventions.
 *
 * These attribute names are still evolving upstream. Pin the version here so a
 * rename upstream is a deliberate, visible change rather than silent drift.
 */
export const GENAI_SEMCONV_VERSION = "1.27.0";

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

/**
 * Event data keys that carry user or model text. Dropped unless the operator
 * explicitly opted into content capture.
 *
 * No event Jazz emits today populates any of these — the list exists so that
 * adding a content-bearing field later cannot leak it by default.
 */
const CONTENT_KEYS = new Set([
  "prompt",
  "prompts",
  "completion",
  "content",
  "messages",
  "input",
  "output",
  "text",
  "arguments",
  "result",
  "userMessage",
  "lastUserMessage",
]);

const MAX_ATTRIBUTE_CHARS_REDACTED = 256;
const MAX_ATTRIBUTE_CHARS_FULL = 8192;

const SEVERITY_BY_EVENT_TYPE: Partial<Record<TelemetryEventType, [number, string]>> = {
  agent_run_failed: [17, "ERROR"],
  tool_error: [17, "ERROR"],
  llm_retry: [13, "WARN"],
};

const DEFAULT_SEVERITY: [number, string] = [9, "INFO"];

export function stringAttribute(key: string, value: string): OtlpKeyValue {
  return { key, value: { stringValue: value } };
}

/** int64 is encoded as a string in proto3 JSON. */
export function intAttribute(key: string, value: number): OtlpKeyValue {
  return { key, value: { intValue: String(Math.trunc(value)) } };
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

/**
 * Flatten nested event data into dotted attribute keys, skipping keys that are
 * consumed by the semantic-convention mapping and content keys when content
 * capture is off.
 */
function flattenData(
  data: Readonly<Record<string, unknown>>,
  prefix: string,
  skipTopLevelKeys: ReadonlySet<string>,
  captureContent: boolean,
  attributes: OtlpKeyValue[],
  depth = 0,
): void {
  const maxChars = captureContent ? MAX_ATTRIBUTE_CHARS_FULL : MAX_ATTRIBUTE_CHARS_REDACTED;

  for (const [key, value] of Object.entries(data)) {
    if (depth === 0 && skipTopLevelKeys.has(key)) continue;
    if (!captureContent && CONTENT_KEYS.has(key)) continue;
    if (value === null || value === undefined) continue;

    const attributeKey = `${prefix}${key}`;

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      attributes.push(attributeFromPrimitive(attributeKey, value, maxChars));
      continue;
    }

    if (Array.isArray(value)) {
      attributes.push(intAttribute(`${attributeKey}.count`, value.length));
      continue;
    }

    if (typeof value === "object" && depth < 3) {
      flattenData(
        value as Record<string, unknown>,
        `${attributeKey}.`,
        skipTopLevelKeys,
        captureContent,
        attributes,
        depth + 1,
      );
    }
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
  const consumed = new Set<string>();

  // GenAI attributes describe one model call. An agent run is a rollup of many,
  // so tagging it with them makes observability backends read it as a further
  // LLM call and price its totals on top of the calls they already summarise —
  // double-counting every run's tokens and cost. The rollup keeps its numbers
  // under jazz.* instead.
  const describesSingleLLMCall = event.type === "llm_usage" || event.type === "llm_retry";

  if (describesSingleLLMCall) {
    const provider = data["provider"];
    if (typeof provider === "string") {
      attributes.push(stringAttribute("gen_ai.system", provider));
      consumed.add("provider");
    }

    const model = data["model"];
    if (typeof model === "string") {
      attributes.push(stringAttribute("gen_ai.request.model", model));
      attributes.push(stringAttribute("gen_ai.response.model", model));
      consumed.add("model");
    }

    attributes.push(stringAttribute("gen_ai.operation.name", "chat"));
  }

  const usage = data["usage"];
  if (usage && typeof usage === "object") {
    const usageRecord = usage as Record<string, unknown>;

    if (describesSingleLLMCall) {
      const promptTokens = usageRecord["promptTokens"];
      const completionTokens = usageRecord["completionTokens"];
      if (typeof promptTokens === "number") {
        attributes.push(intAttribute("gen_ai.usage.input_tokens", promptTokens));
      }
      if (typeof completionTokens === "number") {
        attributes.push(intAttribute("gen_ai.usage.output_tokens", completionTokens));
      }
    }

    // Everything else (cache, reasoning, tool-token estimates, and the run
    // rollup's totals) has no semconv equivalent and stays under jazz.usage.*.
    flattenData(usageRecord, "jazz.usage.", new Set(), captureContent, attributes);
    consumed.add("usage");
  }

  flattenData(data, "jazz.", consumed, captureContent, attributes);

  return attributes;
}

export function toLogRecord(event: TelemetryEvent, captureContent: boolean): OtlpLogRecord {
  const timeUnixNano = String(BigInt(new Date(event.timestamp).getTime()) * 1_000_000n);
  const [severityNumber, severityText] = SEVERITY_BY_EVENT_TYPE[event.type] ?? DEFAULT_SEVERITY;

  return {
    timeUnixNano,
    observedTimeUnixNano: timeUnixNano,
    severityNumber,
    severityText,
    body: { stringValue: event.type },
    attributes: eventToAttributes(event, captureContent),
  };
}

export function buildLogsPayload(
  events: readonly TelemetryEvent[],
  options: {
    readonly serviceName: string;
    readonly serviceVersion: string;
    readonly captureContent: boolean;
  },
): OtlpLogsPayload {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            stringAttribute("service.name", options.serviceName),
            stringAttribute("service.version", options.serviceVersion),
            stringAttribute("telemetry.sdk.name", "jazz"),
            stringAttribute("telemetry.sdk.language", "nodejs"),
          ],
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
