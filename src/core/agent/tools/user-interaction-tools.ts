import { Effect } from "effect";
import { z } from "zod";
import { PresentationServiceTag, type UserInputRequest } from "@/core/interfaces/presentation";
import type { Tool, ToolRequirements } from "@/core/interfaces/tool-registry";
import { defineTool, makeZodValidator } from "./base-tool";

const askUserSchema = z.object({
  question: z.string().describe("A single, clear question to ask the user"),
  suggested_responses: z
    .array(
      z.object({
        value: z.string(),
        label: z.string().optional(),
        description: z.string().optional(),
      }),
    )
    .min(2)
    .describe(
      "At least 2 suggested responses the user can pick from. Keep suggestions concise and actionable.",
    ),
  allow_custom: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether to allow custom text input in addition to suggestions (default: true)"),
});

type AskUserArgs = z.infer<typeof askUserSchema>;

/**
 * Tools for user interaction during agent execution.
 * These tools allow the agent to gather clarifications before proceeding.
 */
export const userInteractionTools: Tool<ToolRequirements>[] = [
  defineTool({
    name: "ask_user_question",
    description:
      "Ask the user a question with suggested responses before proceeding. Use when you need to offer the user clear choices or alternatives. The user can select from suggestions or type a custom response. IMPORTANT: Ask only ONE question per call if you have multiple questions, call this tool multiple times sequentially.",
    parameters: askUserSchema,
    hidden: false,
    riskLevel: "read-only",
    validate: makeZodValidator(askUserSchema),
    handler: (args: AskUserArgs) =>
      Effect.gen(function* () {
        const presentation = yield* PresentationServiceTag;

        const request: UserInputRequest = {
          question: args.question,
          suggestions: args.suggested_responses,
          allowCustom: args.allow_custom !== false,
        };

        const response = yield* presentation.requestUserInput(request);

        return {
          success: true,
          result: `User responded: ${response}`,
        };
      }),
  }),
];
