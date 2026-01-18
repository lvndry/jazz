import { Effect } from "effect";
import { z } from "zod";
import { GmailServiceTag, type GmailService } from "../../../interfaces/gmail";
import type { Tool } from "../../../interfaces/tool-registry";
import { defineTool } from "../base-tool";
import { formatEmailDetail } from "./utils";

/**
 * Get email tool
 */

export function createGetEmailTool(): Tool<GmailService> {
  const parameters = z
    .object({
      emailId: z.string().min(1).describe("ID of the email to retrieve"),
    })
    .strict();

  type GetEmailArgs = z.infer<typeof parameters>;
  return defineTool<GmailService, GetEmailArgs>({
    name: "get_email",
    description:
      "Retrieve the complete content of a specific email by its ID. Returns full email body, headers, recipients, attachments metadata, and labels. Use after list_emails or search_emails to read the full content of a specific message.",
    tags: ["gmail", "read"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (validatedArgs) =>
      Effect.gen(function* () {
        const gmailService = yield* GmailServiceTag;
        const email = yield* gmailService.getEmail(validatedArgs.emailId);
        return { success: true, result: formatEmailDetail(email) };
      }),
  });
}
