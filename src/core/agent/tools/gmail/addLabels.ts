import { Effect } from "effect";
import { z } from "zod";
import { GmailServiceTag, type GmailService } from "@/core/interfaces/gmail";
import type { Tool } from "@/core/interfaces/tool-registry";
import { defineTool } from "../base-tool";
import { formatEmailDetail } from "./utils";

/**
 * Add labels to email tool
 */

export function createAddLabelsToEmailTool(): Tool<GmailService> {
  const parameters = z
    .object({
      emailId: z.string().min(1).describe("Email ID"),
      labelIds: z.array(z.string()).min(1).describe("Label IDs to add"),
    })
    .strict();

  type AddLabelsToEmailArgs = z.infer<typeof parameters>;
  return defineTool<GmailService, AddLabelsToEmailArgs>({
    name: "add_labels_to_email",
    description: "Add labels to an email. Use list_labels for available IDs.",
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
        const email = yield* gmailService.modifyEmail(validatedArgs.emailId, {
          addLabelIds: validatedArgs.labelIds,
        });
        return { success: true, result: formatEmailDetail(email) };
      }),
  });
}
