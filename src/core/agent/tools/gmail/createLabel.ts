import { Effect } from "effect";
import { z } from "zod";
import { GmailServiceTag, type GmailService } from "@/core/interfaces/gmail";
import type { Tool } from "@/core/interfaces/tool-registry";
import { defineTool } from "../base-tool";
import { ALLOWED_LABEL_COLORS, formatLabelForDisplay } from "./utils";

/**
 * Create label tool
 */

export function createCreateLabelTool(): Tool<GmailService> {
  const parameters = z
    .object({
      name: z.string().min(1).describe("Label name"),
      labelListVisibility: z
        .enum(["labelShow", "labelHide"])
        .optional()
        .describe("Show in label list"),
      messageListVisibility: z.enum(["show", "hide"]).optional().describe("Show in message list"),
      color: z
        .object({
          textColor: z.enum(ALLOWED_LABEL_COLORS).describe("Text color"),
          backgroundColor: z.enum(ALLOWED_LABEL_COLORS).describe("Background color"),
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

  type CreateLabelArgs = z.infer<typeof parameters>;
  return defineTool<GmailService, CreateLabelArgs>({
    name: "create_label",
    description: "Create a Gmail label with optional color and visibility settings.",
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
        const { name, labelListVisibility, messageListVisibility, color } = validatedArgs;
        const options: {
          labelListVisibility?: "labelShow" | "labelHide";
          messageListVisibility?: "show" | "hide";
          color?: { textColor: string; backgroundColor: string };
        } = {};
        if (labelListVisibility) options.labelListVisibility = labelListVisibility;
        if (messageListVisibility) options.messageListVisibility = messageListVisibility;
        if (color)
          options.color = {
            textColor: color.textColor as string,
            backgroundColor: color.backgroundColor as string,
          };

        const createResult = yield* gmailService.createLabel(name, options).pipe(
          Effect.catchAll((error) => {
            // Check if it's a 409 conflict error (label already exists)
            if (error._tag === "GmailOperationError" && "status" in error) {
              if (error.status === 409) {
                // Return a special marker to indicate the label already exists
                return Effect.succeed("LABEL_EXISTS" as const);
              }
            }
            return Effect.fail(error);
          }),
        );

        // Handle the case where label already exists
        if (createResult === "LABEL_EXISTS") {
          return { success: true, result: `Label "${name}" already exists` };
        }

        // If we get here, the label was created successfully
        return { success: true, result: formatLabelForDisplay(createResult) };
      }),
  });
}
