import { Effect } from "effect";
import { z } from "zod";
import { GmailServiceTag, type GmailService } from "@/core/interfaces/gmail";
import type { Tool } from "@/core/interfaces/tool-registry";
import { defineTool } from "../base-tool";

/**
 * Batch modify emails tool
 */

export function createBatchModifyEmailsTool(): Tool<GmailService> {
  const parameters = z
    .object({
      emailIds: z.array(z.string()).min(1).max(1000).describe("Email IDs to modify"),
      addLabelIds: z.array(z.string()).optional().describe("Label IDs to add"),
      removeLabelIds: z.array(z.string()).optional().describe("Label IDs to remove"),
    })
    .strict();

  type BatchModifyEmailsArgs = z.infer<typeof parameters>;
  return defineTool<GmailService, BatchModifyEmailsArgs>({
    name: "batch_modify_emails",
    description: "Add or remove labels on multiple emails at once (up to 1000).",
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
        const { emailIds, addLabelIds, removeLabelIds } = validatedArgs;
        const options: {
          addLabelIds?: string[];
          removeLabelIds?: string[];
        } = {};
        if (addLabelIds) options.addLabelIds = addLabelIds;
        if (removeLabelIds) options.removeLabelIds = removeLabelIds;

        yield* gmailService.batchModifyEmails(emailIds, options);
        return {
          success: true,
          result: `Successfully modified ${emailIds.length} emails`,
        };
      }),
  });
}
