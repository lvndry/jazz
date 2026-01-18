import { Effect } from "effect";
import { z } from "zod";
import { GmailServiceTag, type GmailService } from "../../../interfaces/gmail";
import type { Tool } from "../../../interfaces/tool-registry";
import { defineTool } from "../base-tool";
import { formatEmailsForDisplay } from "./utils";

/**
 * Search emails tool
 */

export function createSearchEmailsTool(): Tool<GmailService> {
  const parameters = z
    .object({
      query: z.string().min(1).describe("Gmail search query to filter emails"),
      maxResults: z.number().int().min(1).max(100).optional().describe("Maximum emails to return"),
    })
    .strict();

  type SearchEmailsArgs = z.infer<typeof parameters>;
  return defineTool<GmailService, SearchEmailsArgs>({
    name: "search_emails",
    description:
      "Search Gmail using Gmail search query syntax. Supports advanced filters like 'from:', 'subject:', 'has:attachment', 'newer_than:', etc. Returns matching emails with metadata. More powerful than list_emails for finding specific emails.",
    tags: ["gmail", "search"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({
            valid: true,
            value: params.data,
          } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (validatedArgs) =>
      Effect.gen(function* () {
        const gmailService = yield* GmailServiceTag;
        const maxResults =
          typeof validatedArgs.maxResults === "number" ? validatedArgs.maxResults : 10;
        const result = yield* gmailService.searchEmails(validatedArgs.query, maxResults).pipe(
          Effect.map((emails) => ({
            success: true as const,
            result: formatEmailsForDisplay(emails),
          })),
          Effect.catchAll((error) => {
            // Handle authentication errors with a clearer message
            if (error._tag === "GmailAuthenticationError") {
              return Effect.succeed({
                success: false as const,
                result: null,
                error: `Authentication failed: ${error.message}. Please run 'bun run cli auth google login' to re-authenticate.`,
              });
            }
            return Effect.succeed({
              success: false as const,
              result: null,
              error: `Failed to search emails: ${error.message || String(error)}`,
            });
          }),
        );
        return result;
      }),
  });
}
