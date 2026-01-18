import { Effect } from "effect";
import { z } from "zod";
import { GmailServiceTag, type GmailService } from "../../../interfaces/gmail";
import type { Tool } from "../../../interfaces/tool-registry";
import { defineTool } from "../base-tool";
import { formatEmailsForDisplay } from "./utils";

/**
 * List emails tool
 */

export function createListEmailsTool(): Tool<GmailService> {
  const parameters = z
    .object({
      maxResults: z.number().int().min(1).max(100).optional().describe("Maximum emails to return"),
      query: z.string().optional().describe("Gmail search query, e.g. 'in:inbox newer_than:7d'"),
    })
    .strict();

  type ListEmailsArgs = z.infer<typeof parameters>;
  return defineTool<GmailService, ListEmailsArgs>({
    name: "list_emails",
    description:
      "List emails from the user's Gmail inbox with optional search query filtering. Returns email metadata (subject, sender, date, snippet, labels). Supports Gmail search syntax (e.g., 'in:inbox newer_than:7d'). Use to browse emails or find specific messages.",
    tags: ["gmail", "list"],
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
        const query = typeof validatedArgs.query === "string" ? validatedArgs.query : "";

        const result = yield* gmailService.listEmails(maxResults, query).pipe(
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
              error: `Failed to list emails: ${error.message || String(error)}`,
            });
          }),
        );
        return result;
      }),
  });
}
