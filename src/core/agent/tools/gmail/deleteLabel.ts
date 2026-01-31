import { Effect } from "effect";
import { z } from "zod";
import { GmailServiceTag, type GmailService } from "@/core/interfaces/gmail";
import type { ToolExecutionContext } from "@/core/types";
import { defineApprovalTool, type ApprovalToolConfig, type ApprovalToolPair } from "../base-tool";

/**
 * Delete label tools (approval + execution)
 */

type DeleteLabelArgs = {
  labelId: string;
};

const deleteLabelParameters = z
  .object({
    labelId: z.string().min(1).describe("ID of the label to delete"),
  })
  .strict();

export function createDeleteLabelTools(): ApprovalToolPair<GmailService> {
  const config: ApprovalToolConfig<GmailService, DeleteLabelArgs> = {
    name: "delete_label",
    description:
      "Delete a Gmail label (only user-created labels can be deleted). This action cannot be undone.",
    tags: ["gmail", "labels"],
    parameters: deleteLabelParameters,
    validate: (args) => {
      const result = deleteLabelParameters.safeParse(args);
      return result.success
        ? { valid: true, value: result.data as DeleteLabelArgs }
        : { valid: false, errors: result.error.issues.map((i) => i.message) };
    },

    approvalMessage: (args: DeleteLabelArgs, _context: ToolExecutionContext) =>
      Effect.succeed(
        `Permanently deleting label '${args.labelId}'. This action cannot be undone.`,
      ),

    approvalErrorMessage: "Deleting label requires user confirmation.",

    handler: (args: DeleteLabelArgs, _context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const gmailService = yield* GmailServiceTag;
        yield* gmailService.deleteLabel(args.labelId);
        return { success: true, result: `Label ${args.labelId} deleted successfully` };
      }),
  };

  return defineApprovalTool<GmailService, DeleteLabelArgs>(config);
}
