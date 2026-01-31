import { Effect } from "effect";
import { z } from "zod";
import { GmailServiceTag, type GmailService } from "@/core/interfaces/gmail";
import type { ToolExecutionContext } from "@/core/types";
import { defineApprovalTool, type ApprovalToolConfig, type ApprovalToolPair } from "../base-tool";
import { createEmailPreviewMessage } from "./utils";

/**
 * Trash email tools (approval + execution)
 */

type TrashEmailArgs = {
  emailId: string;
};

const trashEmailParameters = z
  .object({
    emailId: z.string().min(1).describe("ID of the email to move to trash"),
  })
  .strict();

export function createTrashEmailTools(): ApprovalToolPair<GmailService> {
  const config: ApprovalToolConfig<GmailService, TrashEmailArgs> = {
    name: "trash_email",
    description:
      "Move an email to trash (recoverable). Use this for safer email removal. Email can be recovered from trash later.",
    tags: ["gmail", "trash"],
    parameters: trashEmailParameters,
    validate: (args) => {
      const result = trashEmailParameters.safeParse(args);
      return result.success
        ? { valid: true, value: result.data as TrashEmailArgs }
        : { valid: false, errors: result.error.issues.map((i) => i.message) };
    },

    approvalMessage: (args: TrashEmailArgs, _context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const gmailService = yield* GmailServiceTag;

        try {
          const email = yield* gmailService.getEmail(args.emailId);
          const preview = createEmailPreviewMessage(email);
          return `${preview}\n\n🗑️  Moving this email to trash (recoverable).`;
        } catch (error) {
          return `Moving email '${args.emailId}' to trash (recoverable).\n(Note: Could not fetch email details: ${error instanceof Error ? error.message : String(error)})`;
        }
      }),

    approvalErrorMessage: "Moving email to trash requires user confirmation.",

    handler: (args: TrashEmailArgs, _context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const gmailService = yield* GmailServiceTag;
        yield* gmailService.trashEmail(args.emailId);
        return { success: true, result: `Email ${args.emailId} moved to trash` };
      }),
  };

  return defineApprovalTool<GmailService, TrashEmailArgs>(config);
}
