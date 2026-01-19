import { Effect } from "effect";
import { z } from "zod";
import { GmailServiceTag, type GmailService } from "@/core/interfaces/gmail";
import type { Tool } from "@/core/interfaces/tool-registry";
import {
  defineTool,
  formatApprovalRequiredDescription,
  formatExecutionToolDescription,
} from "../base-tool";

/**
 * Delete label tool
 */

export function createDeleteLabelTool(): Tool<GmailService> {
  const parameters = z
    .object({
      labelId: z.string().min(1).describe("ID of the label to delete"),
    })
    .strict();

  type DeleteLabelArgs = z.infer<typeof parameters>;
  return defineTool<GmailService, DeleteLabelArgs>({
    name: "delete_label",
    description: formatApprovalRequiredDescription(
      "Delete a Gmail label (only user-created labels can be deleted). This tool requests user approval and does NOT perform the deletion directly. After the user confirms, you MUST call execute_delete_label with the exact arguments provided in the approval response.",
    ),
    tags: ["gmail", "labels"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args, _context) => {
        return Effect.succeed(
          `About to permanently delete label '${args.labelId}'. This action cannot be undone.\n\nIf the user confirms, call execute_delete_label with the same labelId.`,
        );
      },
      execute: {
        toolName: "execute_delete_label",
        buildArgs: (args) => ({ labelId: (args as { labelId: string }).labelId }),
      },
    },
    handler: (validatedArgs) =>
      Effect.gen(function* () {
        const gmailService = yield* GmailServiceTag;
        yield* gmailService.deleteLabel(validatedArgs.labelId);
        return { success: true, result: `Label ${validatedArgs.labelId} deleted successfully` };
      }),
  });
}

export function createExecuteDeleteLabelTool(): Tool<GmailService> {
  const parameters = z
    .object({
      labelId: z.string().min(1).describe("ID of the label to delete"),
    })
    .strict();

  type ExecuteDeleteLabelArgs = z.infer<typeof parameters>;
  return defineTool<GmailService, ExecuteDeleteLabelArgs>({
    name: "execute_delete_label",
    description: formatExecutionToolDescription(
      "Performs the actual Gmail label deletion after user approval of delete_label. Permanently deletes a Gmail label (only user-created labels can be deleted; system labels are protected). This tool should only be called after delete_label receives user approval.",
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
        yield* gmailService.deleteLabel(validatedArgs.labelId);
        return { success: true, result: `Label ${validatedArgs.labelId} deleted successfully` };
      }),
  });
}
