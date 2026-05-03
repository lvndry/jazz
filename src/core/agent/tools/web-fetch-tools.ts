import { Effect } from "effect";
import { z } from "zod";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { defineTool, makeZodValidator } from "./base-tool";

const DEFAULT_MAX_CONTENT_LENGTH = 50_000;
const USER_AGENT = "Mozilla/5.0 (compatible; Jazz CLI)";

const SUPPORTED_CONTENT_TYPES = [
  "text/html",
  "text/plain",
  "application/json",
  "application/xml",
  "text/xml",
] as const;

function isSupportedContentType(contentType: string): boolean {
  return SUPPORTED_CONTENT_TYPES.some((type) => contentType.includes(type));
}

const webFetchSchema = z
  .object({
    url: z.string().url().describe("The URL to fetch content from"),
    max_length: z
      .number()
      .int()
      .min(1)
      .max(200_000)
      .optional()
      .describe(`Max content length in characters (default: ${DEFAULT_MAX_CONTENT_LENGTH})`),
  })
  .strict();

type WebFetchArgs = z.infer<typeof webFetchSchema>;

export function createWebFetchTool(): ReturnType<typeof defineTool<LoggerService, WebFetchArgs>> {
  return defineTool<LoggerService, WebFetchArgs>({
    name: "web_fetch",
    description: "Fetch and extract text content from a URL.",
    tags: ["web", "fetch"],
    parameters: webFetchSchema,
    validate: makeZodValidator(webFetchSchema),
    handler: (args: WebFetchArgs, _context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const logger = yield* LoggerServiceTag;
        const maxLength = args.max_length ?? DEFAULT_MAX_CONTENT_LENGTH;

        yield* logger.debug(`[Web Fetch] Fetching ${args.url}`);

        const response = yield* Effect.tryPromise({
          try: (signal) =>
            fetch(args.url, {
              headers: { "User-Agent": USER_AGENT },
              signal,
            }),
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
        let content: string;

        if (isHtml) {
          title = body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? "";
          content = body
            .replace(/<script\b[^<]*(?:(?!<\/script\b[^>]*>)<[^<]*)*<\/script\b[^>]*>/gi, " ")
            .replace(/<style\b[^<]*(?:(?!<\/style\b[^>]*>)<[^<]*)*<\/style\b[^>]*>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, maxLength);
        } else {
          content = body.slice(0, maxLength);
        }

        return {
          success: true,
          result: { url: args.url, title, content },
        } satisfies ToolExecutionResult;
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (!result.success || !result.result) return undefined;
      const res = result.result as { url: string; title: string; content: string };
      return `Fetched ${res.url}${res.title ? ` — "${res.title}"` : ""} (${res.content.length} chars)`;
    },
  });
}
