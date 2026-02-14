import { Effect } from "effect";
import { z } from "zod";
import { GmailServiceTag, type GmailService } from "@/core/interfaces/gmail";
import type { ToolExecutionContext } from "@/core/types";
import { defineApprovalTool, type ApprovalToolConfig, type ApprovalToolPair } from "../base-tool";
import { createEmailPreviewMessage } from "./utils";

/**
 * Delete email tools (approval + execution)
 */

type DeleteEmailArgs = {
  emailId: string;
};

const deleteEmailParameters = z
  .object({
    emailId: z.string().min(1).describe("Email ID to delete permanently"),
  })
  .strict();

export function createDeleteEmailTools(): ApprovalToolPair<GmailService> {
  const config: ApprovalToolConfig<GmailService, DeleteEmailArgs> = {
    name: "delete_email",
    description: "Permanently delete an email. Irreversible.",
    tags: ["gmail", "delete"],
    parameters: deleteEmailParameters,
    validate: (args) => {
      const result = deleteEmailParameters.safeParse(args);
      return result.success
        ? { valid: true, value: result.data as DeleteEmailArgs }
        : { valid: false, errors: result.error.issues.map((i) => i.message) };
    },

    approvalMessage: (args: DeleteEmailArgs, _context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const gmailService = yield* GmailServiceTag;

        try {
          const email = yield* gmailService.getEmail(args.emailId);
          const preview = createEmailPreviewMessage(email);
          return `${preview}\n\n⚠️  PERMANENTLY DELETING this email. This cannot be undone!`;
        } catch (error) {
          return `Permanently deleting email '${args.emailId}'. This cannot be undone!\n(Note: Could not fetch email details: ${error instanceof Error ? error.message : String(error)})`;
        }
      }),

    approvalErrorMessage: "Permanently deleting email requires user confirmation.",

    handler: (args: DeleteEmailArgs, _context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const gmailService = yield* GmailServiceTag;
        yield* gmailService.deleteEmail(args.emailId);
        return { success: true, result: `Email ${args.emailId} deleted permanently` };
      }),
  };

  return defineApprovalTool<GmailService, DeleteEmailArgs>(config);
}
