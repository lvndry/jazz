import { Effect } from "effect";
import { z } from "zod";
import { GmailServiceTag, type GmailService } from "../../../interfaces/gmail";
import type { Tool } from "../../../interfaces/tool-registry";
import {
  defineTool,
  formatApprovalRequiredDescription,
  formatExecutionToolDescription,
} from "../base-tool";
import { createEmailPreviewMessage } from "./utils";

/**
 * Trash email tool
 */

export function createTrashEmailTool(): Tool<GmailService> {
  const parameters = z
    .object({
      emailId: z.string().min(1).describe("ID of the email to move to trash"),
    })
    .strict();

  return defineTool<GmailService, { emailId: string }>({
    name: "trash_email",
    description: formatApprovalRequiredDescription(
      "Move an email to trash (recoverable). Use this for safer email removal. This tool requests user approval and does NOT perform the trash operation directly. After the user confirms, you MUST call execute_trash_email with the exact arguments provided in the approval response.",
    ),
    parameters,
    validate: (args) => {
      const result = parameters.safeParse(args);
      return result.success
        ? ({ valid: true, value: result.data as unknown as { emailId: string } } as const)
        : ({ valid: false, errors: result.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args, _context) =>
        Effect.gen(function* () {
          const a = args as { emailId: string };
          const gmailService = yield* GmailServiceTag;

          try {
            const email = yield* gmailService.getEmail(a.emailId);
            const preview = createEmailPreviewMessage(email);
            return `${preview}\n\n🗑️  About to move this email to trash. It can be recovered later.\n\nIf the user confirms, call execute_trash_email with the same emailId.`;
          } catch (error) {
            // If we can't fetch email details, fall back to basic message
            return `About to move email '${a.emailId}' to trash. It can be recovered later.\n(Note: Could not fetch email details: ${error instanceof Error ? error.message : String(error)})`;
          }
        }),
      execute: {
        toolName: "execute_trash_email",
        buildArgs: (args) => ({ emailId: (args as { emailId: string }).emailId }),
      },
    },
    handler: (validatedArgs) =>
      Effect.gen(function* () {
        const gmailService = yield* GmailServiceTag;
        yield* gmailService.trashEmail(validatedArgs.emailId);
        return { success: true, result: `Email ${validatedArgs.emailId} moved to trash` };
      }),
  });
}

export function createExecuteTrashEmailTool(): Tool<GmailService> {
  const parameters = z
    .object({
      emailId: z.string().min(1).describe("ID of the email to move to trash"),
    })
    .strict();

  type ExecuteTrashEmailArgs = z.infer<typeof parameters>;
  return defineTool<GmailService, ExecuteTrashEmailArgs>({
    name: "execute_trash_email",
    description: formatExecutionToolDescription(
      "Performs the actual email trash operation after user approval of trash_email. Moves an email to trash (recoverable). This tool should only be called after trash_email receives user approval.",
    ),
    hidden: true,
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
        yield* gmailService.trashEmail(validatedArgs.emailId);
        return { success: true, result: `Email ${validatedArgs.emailId} moved to trash` };
      }),
  });
}
