import { Effect } from "effect";
import { z } from "zod";
import { GmailServiceTag, type GmailService } from "../../../interfaces/gmail";
import type { Tool } from "../../../interfaces/tool-registry";
import { defineTool } from "../base-tool";
import { formatEmailDetail } from "./utils";

/**
 * Add labels to email tool
 */

export function createAddLabelsToEmailTool(): Tool<GmailService> {
  const parameters = z
    .object({
      emailId: z.string().min(1).describe("ID of the email to add labels to"),
      labelIds: z.array(z.string()).min(1).describe("Array of label IDs to add to the email"),
    })
    .strict();

  type AddLabelsToEmailArgs = z.infer<typeof parameters>;
  return defineTool<GmailService, AddLabelsToEmailArgs>({
    name: "add_labels_to_email",
    description:
      "Apply one or more labels to a specific email. Labels help organize and categorize emails. Use list_labels to find available label IDs. Multiple labels can be added in a single operation.",
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
