import { Effect } from "effect";
import { z } from "zod";
import { GmailServiceTag, type GmailService } from "../../../interfaces/gmail";
import type { Tool } from "../../../interfaces/tool-registry";
import { defineTool } from "../base-tool";
import { formatEmailDetail } from "./utils";

/**
 * Remove labels from email tool
 */

export function createRemoveLabelsFromEmailTool(): Tool<GmailService> {
  const parameters = z
    .object({
      emailId: z.string().min(1).describe("ID of the email to remove labels from"),
      labelIds: z.array(z.string()).min(1).describe("Array of label IDs to remove from the email"),
    })
    .strict();

  type RemoveLabelsFromEmailArgs = z.infer<typeof parameters>;
  return defineTool<GmailService, RemoveLabelsFromEmailArgs>({
    name: "remove_labels_from_email",
    description:
      "Remove one or more labels from a specific email. Use to un-categorize emails or clean up label assignments. Multiple labels can be removed in a single operation.",
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
        const email = yield* gmailService.modifyEmail(validatedArgs.emailId, {
          removeLabelIds: validatedArgs.labelIds,
        });
        return { success: true, result: formatEmailDetail(email) };
      }),
  });
}
