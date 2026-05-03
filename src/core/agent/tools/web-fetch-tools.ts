import { Effect } from "effect";
import { z } from "zod";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { defineTool, makeZodValidator } from "./base-tool";

const DEFAULT_MAX_CONTENT_LENGTH = 50_000;

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
          try: () =>
            fetch(args.url, {
              headers: { "User-Agent": "Mozilla/5.0 (compatible; Jazz CLI)" },
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

        const html = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: (error) =>
            new Error(
              `Failed to read response body: ${error instanceof Error ? error.message : String(error)}`,
            ),
        });

        const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        const title = titleMatch?.[1]?.trim() ?? "";

        const text = html
          .replace(/<script\b[^<]*(?:(?!<\/script\s*>)<[^<]*)*<\/script\s*>/gi, " ")
          .replace(/<style\b[^<]*(?:(?!<\/style\s*>)<[^<]*)*<\/style\s*>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, maxLength);

        return {
          success: true,
          result: { url: args.url, title, content: text },
        } satisfies ToolExecutionResult;
      }),
    createSummary: (result: ToolExecutionResult) => {
      if (!result.success || !result.result) return undefined;
      const res = result.result as { url: string; title: string; content: string };
      return `Fetched ${res.url}${res.title ? ` — "${res.title}"` : ""} (${res.content.length} chars)`;
    },
  });
}
