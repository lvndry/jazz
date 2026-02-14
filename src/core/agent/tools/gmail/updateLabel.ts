import { Effect } from "effect";
import { z } from "zod";
import { GmailServiceTag, type GmailService } from "@/core/interfaces/gmail";
import type { Tool } from "@/core/interfaces/tool-registry";
import { defineTool } from "../base-tool";
import { ALLOWED_LABEL_COLORS, formatLabelForDisplay } from "./utils";

/**
 * Update label tool
 */

export function createUpdateLabelTool(): Tool<GmailService> {
  const parameters = z
    .object({
      labelId: z.string().min(1).describe("Label ID"),
      name: z.string().min(1).optional().describe("Label name"),
      labelListVisibility: z
        .enum(["labelShow", "labelHide"])
        .optional()
        .describe("Show in label list"),
      messageListVisibility: z.enum(["show", "hide"]).optional().describe("Show in message list"),
      color: z
        .object({
          textColor: z.enum(ALLOWED_LABEL_COLORS),
          backgroundColor: z.enum(ALLOWED_LABEL_COLORS),
        })
        .partial()
        .optional()
        .refine(
          (val) =>
            !val || (typeof val.textColor === "string" && typeof val.backgroundColor === "string"),
          { message: "Both textColor and backgroundColor must be provided when color is set" },
        )
        .describe("Label colors"),
    })
    .strict();

  type UpdateLabelArgs = z.infer<typeof parameters>;
  return defineTool<GmailService, UpdateLabelArgs>({
    name: "update_label",
    description: "Update a Gmail label's name, visibility, or color.",
    tags: ["gmail", "labels"],
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
        const { labelId, name, labelListVisibility, messageListVisibility, color } = validatedArgs;
        const updates: {
          name?: string;
          labelListVisibility?: "labelShow" | "labelHide";
          messageListVisibility?: "show" | "hide";
          color?: { textColor: string; backgroundColor: string };
        } = {};
        if (name !== undefined) updates.name = name;
        if (labelListVisibility !== undefined) updates.labelListVisibility = labelListVisibility;
        if (messageListVisibility !== undefined)
          updates.messageListVisibility = messageListVisibility;
        if (color !== undefined)
          updates.color = {
            textColor: color.textColor as string,
            backgroundColor: color.backgroundColor as string,
          };

        const label = yield* gmailService.updateLabel(labelId, updates);
        return { success: true, result: formatLabelForDisplay(label) };
      }),
  });
}
