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
      name: z.string().min(1).describe("Name of the label to create"),
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
          textColor: z
            .enum(ALLOWED_LABEL_COLORS)
            .describe("Text color (must be one of the allowed Gmail label colors)"),
          backgroundColor: z
            .enum(ALLOWED_LABEL_COLORS)
            .describe("Background color (must be one of the allowed Gmail label colors)"),
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

  type CreateLabelArgs = z.infer<typeof parameters>;
  return defineTool<GmailService, CreateLabelArgs>({
    name: "create_label",
    description:
      "Create a new custom Gmail label with optional visibility settings and color customization. Labels help organize emails. Supports controlling whether the label appears in the label list and message list. Returns the created label with its ID.",
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
