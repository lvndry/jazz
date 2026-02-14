import { Effect } from "effect";
import { z } from "zod";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { defineTool } from "./base-tool";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

type HttpMethod = (typeof HTTP_METHODS)[number];
type ResponseType = "json" | "text" | "bytes";

type QueryValue = string | number | boolean;

interface HttpJsonBody extends Record<string, unknown> {
  readonly type: "json";
  readonly value: unknown;
}

interface HttpTextBody extends Record<string, unknown> {
  readonly type: "text";
  readonly value: string;
}

interface HttpFormBody extends Record<string, unknown> {
  readonly type: "form";
  readonly value: Record<string, string>;
}

type HttpBody = HttpJsonBody | HttpTextBody | HttpFormBody;

interface HttpResponseBodyJson {
  readonly type: "json";
  readonly data: unknown;
  readonly rawText?: string;
  readonly parseError?: string;
}

interface HttpResponseBodyText {
  readonly type: "text";
  readonly text: string;
}

interface HttpResponseBodyBytes {
  readonly type: "bytes";
  readonly base64: string;
}

type HttpResponseBody = HttpResponseBodyJson | HttpResponseBodyText | HttpResponseBodyBytes;

interface HttpRequestResult {
  readonly request: {
    readonly method: HttpMethod;
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly query?: Record<string, string>;
    readonly body?: {
      readonly type: HttpBody["type"];
      readonly value: unknown;
      readonly truncated?: boolean;
    };
    readonly timeoutMs: number;
    readonly followRedirects: boolean;
    readonly maxResponseBytes: number;
    readonly responseType: ResponseType;
  };
  readonly response: {
    readonly status: number;
    readonly statusText: string;
    readonly headers: Record<string, string>;
    readonly elapsedMs: number;
    readonly size: number;
    readonly truncated: boolean;
    readonly body: HttpResponseBody;
  };
}

const HttpBodySchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("json"),
      value: z.unknown().describe("JSON body value"),
    })
    .strict(),
  z
    .object({
      type: z.literal("text"),
      value: z.string().min(1, "Text body cannot be empty").describe("Text body"),
    })
    .strict(),
  z
    .object({
      type: z.literal("form"),
      value: z.record(z.string(), z.string()).describe("Form fields (URL-encoded)"),
    })
    .strict(),
]);

const HttpRequestSchema = z
  .object({
    method: z.enum(HTTP_METHODS).describe("HTTP method"),
    url: z
      .url("URL must be absolute and include the protocol (http or https).")
      .describe("Absolute URL (http/https)"),
    headers: z.record(z.string(), z.string()).optional().describe("Request headers"),
    query: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]) as z.ZodType<QueryValue>)
      .optional()
      .describe("Query parameters"),
    body: HttpBodySchema.optional().describe("Request body"),
    timeoutMs: z
      .number()
      .int("Timeout must be an integer number of milliseconds.")
      .positive("Timeout must be greater than zero.")
      .max(120_000, "Timeout cannot exceed two minutes.")
      .optional()
      .describe("Timeout in ms (default: 15000)"),
    followRedirects: z.boolean().optional().describe("Follow redirects (default: true)"),
    maxResponseBytes: z
      .number()
      .int("maxResponseBytes must be an integer number of bytes.")
      .positive("maxResponseBytes must be greater than zero.")
      .max(5_000_000, "maxResponseBytes cannot exceed 5MB.")
      .optional()
      .describe("Max response bytes (default: 1MB)"),
    cacheTtlSeconds: z
      .number()
      .int("Cache TTL must be an integer number of seconds.")
      .positive("Cache TTL must be greater than zero.")
      .max(3600, "Cache TTL cannot exceed one hour.")
      .optional()
      .describe("Cache duration in seconds (adds Cache-Control: max-age header)"),
  })
  .strict();

type HttpRequestArgs = z.infer<typeof HttpRequestSchema>;

const SENSITIVE_HEADER_PATTERNS = [
  /authorization/i,
  /cookie/i,
  /token/i,
  /secret/i,
  /api[-_]?key/i,
  /credential/i,
] as const;

const DEFAULT_TIMEOUT_MS = 15_000; // 15 seconds
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576; // 1MB

interface HeaderEntry {
  readonly originalName: string;
  readonly value: string;
}

function sanitizeHeaders(
  entries: ReadonlyArray<readonly [string, string]>,
): Record<string, string> {
  const sanitized: Record<string, string> = {};

  for (const [name, value] of entries) {
    const redacted = SENSITIVE_HEADER_PATTERNS.some((pattern) => pattern.test(name))
      ? "<redacted>"
      : value;
    sanitized[name] = redacted;
  }

  return sanitized;
}

function buildHeaderMap(
  headers: Record<string, string> | undefined,
): Map<string, HeaderEntry> | { error: string } {
  if (!headers) {
    return new Map<string, HeaderEntry>();
  }

  const entries = Object.entries(headers);

  if (entries.length > 32) {
    return { error: "Too many headers provided (maximum 32 allowed)." };
  }

  const headerNamePattern = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;
  const map = new Map<string, HeaderEntry>();

  for (const [nameRaw, valueRaw] of entries) {
    const name = nameRaw.trim();
    const value = valueRaw.trim();

    if (name.length === 0) {
      return { error: "Header names cannot be empty." };
    }

    if (!headerNamePattern.test(name)) {
      return {
        error: `Invalid header name "${name}". Header names must use visible ASCII characters without spaces.`,
      };
    }

    if (value.length > 4096) {
      return { error: `Header "${name}" value is too long (maximum 4096 characters).` };
    }

    const lower = name.toLowerCase();
    map.set(lower, { originalName: name, value });
  }

  return map;
}

function ensureHeader(map: Map<string, HeaderEntry>, name: string, value: string): void {
  const key = name.toLowerCase();
  if (!map.has(key)) {
    map.set(key, { originalName: name, value });
  }
}

function prepareRequestBody(
  method: HttpMethod,
  body: HttpBody | undefined,
  headerMap: Map<string, HeaderEntry>,
):
  | {
      readonly initBody?: BodyInit | null;
      readonly summary?: { readonly type: HttpBody["type"]; readonly value: unknown };
    }
  | { readonly error: string } {
  if (!body) {
    return {};
  }

  if (method === "GET" || method === "HEAD") {
    return { error: `HTTP ${method} requests cannot include a body.` };
  }

  switch (body.type) {
    case "json": {
      let serialized: string;
      try {
        serialized = JSON.stringify(body.value);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { error: `Failed to serialize JSON body: ${message}` };
      }
      ensureHeader(headerMap, "Content-Type", "application/json");
      return {
        initBody: serialized,
        summary: {
          type: "json",
          value: body.value,
        },
      };
    }
    case "text": {
      ensureHeader(headerMap, "Content-Type", "text/plain; charset=utf-8");
      return {
        initBody: body.value,
        summary: {
          type: "text",
          value: body.value.length > 2000 ? `${body.value.slice(0, 2000)}…` : body.value,
        },
      };
    }
    case "form": {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(body.value)) {
        params.set(key, value);
      }
      ensureHeader(headerMap, "Content-Type", "application/x-www-form-urlencoded");
      return {
        initBody: params.toString(),
        summary: {
          type: "form",
          value: body.value,
        },
      };
    }
    default:
      return { error: "Unsupported body type." };
  }
}

function mapToRecord(map: Map<string, HeaderEntry>): Record<string, string> {
  const record: Record<string, string> = {};
  for (const entry of map.values()) {
    record[entry.originalName] = entry.value;
  }
  return record;
}

function formatQuery(
  query: Record<string, QueryValue> | undefined,
): Record<string, string> | undefined {
  if (!query) {
    return undefined;
  }
  const formatted: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    formatted[key] = String(value);
  }
  return formatted;
}

function truncateBytes(
  buffer: Uint8Array,
  maxBytes: number,
): { bytes: Uint8Array; truncated: boolean } {
  if (buffer.byteLength <= maxBytes) {
    return { bytes: buffer, truncated: false };
  }
  return {
    bytes: buffer.subarray(0, maxBytes),
    truncated: true,
  };
}

function parseJsonBody(text: string): { data: unknown; error?: string } {
  if (text.trim().length === 0) {
    return { data: null };
  }
  try {
    return { data: JSON.parse(text) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { data: undefined, error: `Failed to parse JSON response: ${message}` };
  }
}

export function createHttpRequestTool(): Tool<never> {
  return defineTool<never, HttpRequestArgs>({
    name: "http_request",
    description:
      "Send HTTP requests. Supports all methods, headers, query params, and body formats.",
    tags: ["http", "network", "api"],
    parameters: HttpRequestSchema,
    validate: (args) => {
      const params = HttpRequestSchema.safeParse(args);
      if (!params.success) {
        return {
          valid: false,
          errors: params.error.issues.map((issue) => issue.message),
        };
      }
      const parsed = params.data;
      if (parsed.body?.type === "form" && Object.keys(parsed.body.value).length === 0) {
        return {
          valid: false,
          errors: ["Form body requires at least one field"],
        };
      }
      return {
        valid: true,
        value: parsed,
      };
    },
    handler: (args: HttpRequestArgs, _context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const method = args.method;

        let urlInstance: URL;
        try {
          urlInstance = new URL(args.url);
        } catch {
          return {
            success: false,
            result: null,
            error: `Invalid URL: ${args.url}`,
          } satisfies ToolExecutionResult;
        }

        if (urlInstance.protocol !== "http:" && urlInstance.protocol !== "https:") {
          return {
            success: false,
            result: null,
            error: "Only http and https protocols are supported.",
          } satisfies ToolExecutionResult;
        }

        const formattedQuery = formatQuery(args.query);
        if (formattedQuery) {
          for (const [key, value] of Object.entries(formattedQuery)) {
            urlInstance.searchParams.set(key, value);
          }
        }

        const headerMap = buildHeaderMap(args.headers);
        if ("error" in headerMap) {
          return {
            success: false,
            result: null,
            error: headerMap.error,
          } satisfies ToolExecutionResult;
        }

        ensureHeader(headerMap, "User-Agent", "Jazz/1.0");

        if (args.cacheTtlSeconds) {
          ensureHeader(headerMap, "Cache-Control", `max-age=${args.cacheTtlSeconds}`);
        }

        const preparedBody = prepareRequestBody(method, args.body, headerMap);
        if ("error" in preparedBody) {
          return {
            success: false,
            result: null,
            error: preparedBody.error,
          } satisfies ToolExecutionResult;
        }

        const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const followRedirects = args.followRedirects ?? true;
        const maxResponseBytes = args.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          controller.abort();
        }, timeoutMs);

        const requestHeaders = mapToRecord(headerMap);
        const requestInit: RequestInit = {
          method,
          headers: requestHeaders,
          body: preparedBody.initBody ?? null,
          redirect: followRedirects ? "follow" : "manual",
          signal: controller.signal,
        };

        const start = Date.now();

        const response = yield* Effect.tryPromise({
          try: () => fetch(urlInstance.toString(), requestInit),
          catch: (error) =>
            error instanceof Error ? error : new Error(`HTTP request failed: ${String(error)}`),
        }).pipe(
          Effect.catchAll((error: Error) =>
            Effect.succeed({
              success: false,
              result: null,
              error:
                error.name === "AbortError"
                  ? `Request timed out after ${timeoutMs}ms.`
                  : error.message,
            } satisfies ToolExecutionResult),
          ),
        );

        clearTimeout(timeoutId);

        if ("success" in response) {
          return response;
        }

        const effectiveResponseType: ResponseType = (() => {
          const contentType = response.headers.get("content-type")?.toLowerCase() || "";
          if (contentType.includes("application/json")) {
            return "json";
          }
          if (
            contentType.startsWith("image/") ||
            contentType.startsWith("audio/") ||
            contentType.startsWith("video/")
          ) {
            return "bytes";
          }
          return "text";
        })();

        const elapsedMs = Date.now() - start;

        const rawArrayBuffer = yield* Effect.tryPromise({
          try: () => response.arrayBuffer(),
          catch: (error) =>
            error instanceof Error
              ? error
              : new Error(`Failed to read response body: ${String(error)}`),
        }).pipe(
          Effect.catchAll((error: Error) =>
            Effect.succeed({
              success: false,
              result: null,
              error: error.message,
            } satisfies ToolExecutionResult),
          ),
        );

        if ("success" in rawArrayBuffer) {
          return rawArrayBuffer;
        }

        const fullBytes = new Uint8Array(rawArrayBuffer);
        const { bytes, truncated } = truncateBytes(fullBytes, maxResponseBytes);
        const byteLength = fullBytes.byteLength;
        const decoder = new TextDecoder("utf-8", { fatal: false });
        const bodyText = decoder.decode(bytes);

        let body: HttpResponseBody;
        switch (effectiveResponseType) {
          case "json": {
            const parsed = parseJsonBody(bodyText);
            if (parsed.error) {
              body = {
                type: "json",
                data: parsed.data,
                rawText: bodyText,
                parseError: parsed.error,
              };
            } else {
              body = {
                type: "json",
                data: parsed.data,
                ...(truncated ? { rawText: bodyText } : {}),
              };
            }
            break;
          }
          case "text": {
            body = {
              type: "text",
              text: truncated ? `${bodyText}…` : bodyText,
            };
            break;
          }
          case "bytes": {
            body = {
              type: "bytes",
              base64: Buffer.from(bytes).toString("base64"),
            };
            break;
          }
          default: {
            body = {
              type: "text",
              text: truncated ? `${bodyText}…` : bodyText,
            };
            break;
          }
        }

        const responseHeadersRecord = sanitizeHeaders(Array.from(response.headers.entries()));
        const requestHeadersSanitized = sanitizeHeaders(
          Array.from(headerMap.values()).map((entry) => [entry.originalName, entry.value] as const),
        );

        const result: HttpRequestResult = {
          request: {
            method,
            url: urlInstance.toString(),
            headers: requestHeadersSanitized,
            ...(formattedQuery ? { query: formattedQuery } : {}),
            ...(preparedBody.summary
              ? {
                  body: {
                    type: preparedBody.summary.type,
                    value: preparedBody.summary.value,
                    truncated:
                      preparedBody.summary.type === "text" &&
                      typeof preparedBody.summary.value === "string" &&
                      preparedBody.summary.value.endsWith("…"),
                  },
                }
              : {}),
            timeoutMs,
            followRedirects,
            maxResponseBytes,
            responseType: effectiveResponseType,
          },
          response: {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeadersRecord,
            elapsedMs,
            size: byteLength,
            truncated,
            body,
          },
        };

        return {
          success: true,
          result,
        } satisfies ToolExecutionResult;
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (!result.success || !result.result) {
        return "HTTP request failed";
      }
      const data = result.result as HttpRequestResult;
      return `HTTP ${data.request.method} ${data.request.url} -> ${data.response.status}`;
    },
  });
}
