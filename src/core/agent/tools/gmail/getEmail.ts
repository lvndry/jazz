import { Effect } from "effect";
import { z } from "zod";
import { GmailServiceTag, type GmailService } from "@/core/interfaces/gmail";
import type { Tool } from "@/core/interfaces/tool-registry";
import { defineTool } from "../base-tool";
import { formatEmailDetail } from "./utils";

/**
 * Get email tool
 */

export function createGetEmailTool(): Tool<GmailService> {
  const parameters = z
    .object({
      emailId: z.string().min(1).describe("Email ID"),
    })
    .strict();

  type GetEmailArgs = z.infer<typeof parameters>;
  return defineTool<GmailService, GetEmailArgs>({
    name: "get_email",
    description: "Get the full content of an email by ID.",
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
