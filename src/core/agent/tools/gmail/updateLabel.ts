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
      labelId: z.string().min(1).describe("ID of the label to update"),
      name: z.string().min(1).optional().describe("New name for the label"),
      labelListVisibility: z
        .enum(["labelShow", "labelHide"])
        .optional()
        .describe("Whether to show the label in the label list"),
      messageListVisibility: z
        .enum(["show", "hide"])
        .optional()
        .describe("Whether to show the label in the message list"),
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
        .describe("Color settings for the label"),
    })
    .strict();

  type UpdateLabelArgs = z.infer<typeof parameters>;
  return defineTool<GmailService, UpdateLabelArgs>({
    name: "update_label",
    description:
      "Modify an existing Gmail label's properties including name, visibility settings, and colors. Use to rename labels, change their appearance, or adjust visibility. Only works on user-created labels (system labels cannot be modified).",
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
