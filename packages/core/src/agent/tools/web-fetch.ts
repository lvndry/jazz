import { Defuddle } from "defuddle/node";
import { Effect } from "effect";
import { z } from "zod";
import type { AgentConfigService } from "@/core/interfaces/agent-config";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { toError } from "@/core/utils/errors";
import { defineTool, makeZodValidator } from "./base-tool";
import { EgressRefusedError, egressPolicyForContext, readBodyWithinBudget } from "./guarded-fetch";
import { fetchWithUserAgentFallback } from "./user-agent-fetch";

const DEFAULT_MAX_CONTENT_LENGTH = 50_000;

/** A page's raw body is read up to this many bytes before extraction; the rest is dropped. */
const MAX_WEB_FETCH_BYTES = 5 * 1024 * 1024;

/** Covers connecting, redirects and reading the body. */
const WEB_FETCH_TIMEOUT_MS = 30_000;

// Non-HTML bodies are returned as raw text, so the tool supports any textual type: every
// `text/*` subtype, the common textual `application/*` types, and structured-syntax suffixes
// (RFC 6839, e.g. `application/ld+json`, `application/rss+xml`). Binary types — PDFs, images,
// archives, `application/octet-stream` — are intentionally rejected; use http_request for those.
const TEXTUAL_APPLICATION_TYPES = [
  "application/json",
  "application/xml",
  "application/markdown",
  "application/yaml",
  "application/x-yaml",
  "application/csv",
] as const;

export function isSupportedContentType(contentType: string): boolean {
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mediaType.startsWith("text/")) return true;
  if (TEXTUAL_APPLICATION_TYPES.some((type) => type === mediaType)) return true;
  return /^application\/[\w.-]+\+(json|xml|yaml)$/.test(mediaType);
}

const webFetchSchema = z
  .object({
    url: z
      .url({
        protocol: /^https?$/,
        error: "URL must be absolute and include the protocol (http or https).",
      })
      .describe("Absolute http(s) URL."),
    max_length: z
      .number()
      .int()
      .min(1)
      .max(200_000)
      .optional()
      .describe(`Characters to return. Default ${DEFAULT_MAX_CONTENT_LENGTH}.`),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Character offset to resume from after a truncated result."),
  })
  .strict();

type WebFetchArgs = z.infer<typeof webFetchSchema>;

export function createWebFetchTool(): ReturnType<
  typeof defineTool<LoggerService | AgentConfigService, WebFetchArgs>
> {
  return defineTool<LoggerService | AgentConfigService, WebFetchArgs>({
    name: "web_fetch",
    disclosure: "public",
    // A GET is still a send: the model writes the URL, so anything it knows can ride out in
    // the path or query string, and the reply comes back for it to read.
    egress: true,
    description:
      "Fetch a known URL's main content as markdown. JavaScript does not run. A host on this machine or the local network is reached after the user approves it.",
    tags: ["web", "fetch"],
    parameters: webFetchSchema,
    validate: makeZodValidator(webFetchSchema),
    handler: (args: WebFetchArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const logger = yield* LoggerServiceTag;
        const maxLength = args.max_length ?? DEFAULT_MAX_CONTENT_LENGTH;

        let parsedUrl: URL;
        try {
          parsedUrl = new URL(args.url);
        } catch {
          return {
            success: false,
            result: null,
            error: `Invalid URL: ${args.url}`,
          } satisfies ToolExecutionResult;
        }
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
          return {
            success: false,
            result: null,
            error: "Only http and https URLs are supported.",
          } satisfies ToolExecutionResult;
        }

        yield* logger.debug("Web fetch started", {
          urlScheme: parsedUrl.protocol.slice(0, -1),
        });

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS);
        const egressPolicy = yield* egressPolicyForContext(context);
        const fetched = yield* Effect.tryPromise({
          try: async () => {
            const { response, url } = await fetchWithUserAgentFallback(args.url, {
              signal: controller.signal,
              policy: egressPolicy,
            });
            if (!response.ok) {
              await response.body?.cancel().catch(() => undefined);
              return { kind: "status", response } as const;
            }
            const contentType = response.headers.get("content-type") ?? "";
            if (!isSupportedContentType(contentType)) {
              await response.body?.cancel().catch(() => undefined);
              return { kind: "unsupported", contentType } as const;
            }
            const read = await readBodyWithinBudget(response, MAX_WEB_FETCH_BYTES);
            return {
              kind: "ok",
              url,
              contentType,
              body: new TextDecoder("utf-8", { fatal: false }).decode(read.bytes),
              bodyTruncated: read.truncated,
            } as const;
          },
          catch: (error) =>
            error instanceof Error && error.name === "AbortError"
              ? new Error(`Fetching ${args.url} timed out after ${String(WEB_FETCH_TIMEOUT_MS)}ms.`)
              : error instanceof EgressRefusedError
                ? error
                : new Error(`Failed to fetch ${args.url}: ${toError(error).message}`),
        }).pipe(Effect.ensuring(Effect.sync(() => clearTimeout(timer))), Effect.either);

        if (fetched._tag === "Left") {
          return {
            success: false,
            result: null,
            error: fetched.left.message,
          } satisfies ToolExecutionResult;
        }
        if (fetched.right.kind === "status") {
          const { response } = fetched.right;
          return {
            success: false,
            result: null,
            error: `HTTP ${response.status} ${response.statusText} for ${args.url}`,
          } satisfies ToolExecutionResult;
        }
        if (fetched.right.kind === "unsupported") {
          return {
            success: false,
            result: null,
            error: `Unsupported content type "${fetched.right.contentType}" for ${args.url}`,
          } satisfies ToolExecutionResult;
        }
        const { body, contentType, bodyTruncated } = fetched.right;

        const isHtml = contentType.includes("text/html");
        let title = "";
        let fullContent: string;

        if (isHtml) {
          const extracted = yield* Effect.tryPromise({
            try: () => Defuddle(body, args.url, { markdown: true }),
            catch: (error) => new Error(`Failed to extract content: ${toError(error).message}`),
          }).pipe(Effect.either);

          if (extracted._tag === "Right") {
            title = extracted.right.title?.trim() ?? "";
            fullContent = extracted.right.content.trim();
          } else {
            yield* logger.debug("Web extraction failed; using HTML text fallback", {
              errorType: "extraction_failed",
            });
            title = body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? "";
            fullContent = body
              .replace(/<script\b[^<]*(?:(?!<\/script\b[^>]*>)<[^<]*)*<\/script\b[^>]*>/gi, " ")
              .replace(/<style\b[^<]*(?:(?!<\/style\b[^>]*>)<[^<]*)*<\/style\b[^>]*>/gi, " ")
              .replace(/<[^>]+>/g, " ")
              .replace(/\s+/g, " ")
              .trim();
          }
        } else {
          fullContent = body;
        }

        const offset = args.offset ?? 0;
        const totalLength = fullContent.length;
        const content = fullContent.slice(offset, offset + maxLength);
        const truncated = offset + content.length < totalLength;

        return {
          success: true,
          result: {
            url: args.url,
            title,
            content,
            offset,
            total_length: totalLength,
            truncated,
            ...(truncated ? { next_offset: offset + content.length } : {}),
            ...(bodyTruncated ? { body_truncated_at_bytes: MAX_WEB_FETCH_BYTES } : {}),
          },
          untrusted: { kind: "external", source: `web_fetch ${fetched.right.url}` },
        } satisfies ToolExecutionResult;
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (!result.success || !result.result) return undefined;
      const res = result.result as {
        url: string;
        title: string;
        content: string;
        total_length: number;
        truncated: boolean;
      };
      const range =
        res.total_length > res.content.length
          ? ` (${res.content.length} of ${res.total_length} chars${res.truncated ? ", truncated" : ""})`
          : ` (${res.content.length} chars)`;
      return `Fetched ${res.url}${res.title ? ` — "${res.title}"` : ""}${range}`;
    },
  });
}
