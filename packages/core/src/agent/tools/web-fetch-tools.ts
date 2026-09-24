import { Defuddle } from "defuddle/node";
import { Effect } from "effect";
import { z } from "zod";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { defineTool, makeZodValidator } from "./base-tool";
import { fetchWithUserAgentFallback } from "./user-agent-fetch";

const DEFAULT_MAX_CONTENT_LENGTH = 50_000;

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
      .describe(
        "Absolute http or https URL to fetch. This is not search — the URL must already be known.",
      ),
    max_length: z
      .number()
      .int()
      .min(1)
      .max(200_000)
      .optional()
      .describe(
        `Maximum number of characters to return. Default ${DEFAULT_MAX_CONTENT_LENGTH}, hard cap 200000.`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Character offset into the extracted content to start returning from. Use this to page through content longer than max_length — the result reports total_length and truncated so you know whether to fetch again with a higher offset.",
      ),
  })
  .strict();

type WebFetchArgs = z.infer<typeof webFetchSchema>;

export function createWebFetchTool(): ReturnType<typeof defineTool<LoggerService, WebFetchArgs>> {
  return defineTool<LoggerService, WebFetchArgs>({
    name: "web_fetch",
    disclosure: "public",
    // A GET is still a send: the model writes the URL, so anything it knows can ride out in
    // the path or query string, and the reply comes back for it to read.
    egress: true,
    description:
      "Fetch a URL over HTTP GET and return its title and main content as clean markdown, with navigation, ads, and boilerplate stripped. JavaScript is not run, so content that appears only after client-side rendering is not captured. " +
      "Default 50000 characters (max 200000) per call; if the result is `truncated`, call again with `offset` to page through the rest (`total_length` reports the full size). Redirects are followed. For PDFs, images, other binary, APIs, custom headers, or POST, use http_request. To find URLs, use web_search.",
    tags: ["web", "fetch"],
    parameters: webFetchSchema,
    validate: makeZodValidator(webFetchSchema),
    handler: (args: WebFetchArgs, _context: ToolExecutionContext) =>
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

        const response = yield* Effect.tryPromise({
          try: (signal) => fetchWithUserAgentFallback(args.url, { signal }),
          catch: (error) =>
            new Error(
              `Failed to fetch ${args.url}: ${error instanceof Error ? error.message : String(error)}`,
            ),
        });

        if (!response.ok) {
          return {
            success: false,
            result: null,
            error: `HTTP ${response.status} ${response.statusText} for ${args.url}`,
          } satisfies ToolExecutionResult;
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (!isSupportedContentType(contentType)) {
          return {
            success: false,
            result: null,
            error: `Unsupported content type "${contentType}" for ${args.url}`,
          } satisfies ToolExecutionResult;
        }

        const body = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: (error) =>
            new Error(
              `Failed to read response body: ${error instanceof Error ? error.message : String(error)}`,
            ),
        });

        const isHtml = contentType.includes("text/html");
        let title = "";
        let fullContent: string;

        if (isHtml) {
          const extracted = yield* Effect.tryPromise({
            try: () => Defuddle(body, args.url, { markdown: true }),
            catch: (error) =>
              new Error(
                `Failed to extract content: ${error instanceof Error ? error.message : String(error)}`,
              ),
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
          },
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
