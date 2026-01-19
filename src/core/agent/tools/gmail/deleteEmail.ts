import { Effect } from "effect";
import { z } from "zod";
import { GmailServiceTag, type GmailService } from "@/core/interfaces/gmail";
import type { Tool } from "@/core/interfaces/tool-registry";
import {
  defineTool,
  formatApprovalRequiredDescription,
  formatExecutionToolDescription,
} from "../base-tool";
import { createEmailPreviewMessage } from "./utils";

/**
 * Delete email tool
 */

export function createDeleteEmailTool(): Tool<GmailService> {
  const parameters = z
    .object({
      emailId: z.string().min(1).describe("ID of the email to delete permanently"),
    })
    .strict();

  type DeleteEmailArgs = z.infer<typeof parameters>;
  return defineTool<GmailService, DeleteEmailArgs>({
    name: "delete_email",
    description: formatApprovalRequiredDescription(
      "Permanently delete an email. This action cannot be undone. Consider using trash_email for safer removal. This tool requests user approval and does NOT perform the deletion directly. After the user confirms, you MUST call execute_delete_email with the exact arguments provided in the approval response.",
    ),
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args, _context) =>
        Effect.gen(function* () {
          const gmailService = yield* GmailServiceTag;

          try {
            const email = yield* gmailService.getEmail(args.emailId);
            const preview = createEmailPreviewMessage(email);
            return `${preview}\n\n About to PERMANENTLY DELETE this email. This cannot be undone!\n\nIf the user confirms, call execute_delete_email with the same emailId.`;
          } catch (error) {
            // If we can't fetch email details, fall back to basic message
            return `About to permanently delete email '${args.emailId}'. This cannot be undone!\n(Note: Could not fetch email details: ${error instanceof Error ? error.message : String(error)})`;
          }
        }),
      execute: {
        toolName: "execute_delete_email",
        buildArgs: (args) => ({ emailId: args.emailId }),
      },
    },
    handler: (validatedArgs) =>
      Effect.gen(function* () {
        const gmailService = yield* GmailServiceTag;
        yield* gmailService.deleteEmail(validatedArgs.emailId);
        return { success: true, result: `Email ${validatedArgs.emailId} deleted permanently` };
      }),
  });
}

export function createExecuteDeleteEmailTool(): Tool<GmailService> {
  const parameters = z
    .object({
      emailId: z.string().min(1).describe("ID of the email to delete permanently"),
    })
    .strict();

  type ExecuteDeleteEmailArgs = z.infer<typeof parameters>;
  return defineTool<GmailService, ExecuteDeleteEmailArgs>({
    name: "execute_delete_email",
    description: formatExecutionToolDescription(
      "Performs the actual email deletion after user approval of delete_email. Permanently deletes an email (this action cannot be undone). This tool should only be called after delete_email receives user approval.",
    ),
    hidden: true,
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
        yield* gmailService.deleteEmail(validatedArgs.emailId);
        return { success: true, result: `Email ${validatedArgs.emailId} deleted permanently` };
      }),
  });
}
