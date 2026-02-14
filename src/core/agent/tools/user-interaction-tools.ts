import { Effect } from "effect";
import { z } from "zod";
import {
  PresentationServiceTag,
  type UserInputRequest,
  type FilePickerRequest,
} from "@/core/interfaces/presentation";
import type { Tool, ToolRequirements } from "@/core/interfaces/tool-registry";
import { defineTool, makeZodValidator } from "./base-tool";

const askUserSchema = z.object({
  question: z.string().describe("Question to ask the user"),
  suggested_responses: z
    .array(
      z.object({
        value: z.string(),
        label: z.string().optional(),
        description: z.string().optional(),
      }),
    )
    .min(2)
    .default([])
    .describe("At least 2 selectable response options"),
  allow_custom: z
    .boolean()
    .optional()
    .default(true)
    .describe("Allow custom text input (default: true)"),
  allow_multiple: z
    .boolean()
    .optional()
    .default(false)
    .describe("Allow multiple selections (default: false)"),
});

type AskUserArgs = z.infer<typeof askUserSchema>;

const filePickerSchema = z.object({
  message: z.string().describe("Prompt message for file selection"),
  base_path: z.string().optional().describe("Starting directory (defaults to cwd)"),
  extensions: z.array(z.string()).optional().describe("Filter by extensions (e.g. ['ts', 'js'])"),
  include_directories: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include directories (default: false)"),
});

type FilePickerArgs = z.infer<typeof filePickerSchema>;

/**
 * Tools for user interaction during agent execution.
 * These tools allow the agent to gather clarifications before proceeding.
 */
export const userInteractionTools: Tool<ToolRequirements>[] = [
  defineTool({
    name: "ask_user_question",
    longRunning: true,
    description:
      "Ask the user a question with interactive selectable suggestions. One question per call.",
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
          allowMultiple: args.allow_multiple === true,
        };

        const response = yield* presentation.requestUserInput(request);

        return {
          success: true,
          result: `User responded: ${response}`,
        };
      }),
  }),
  defineTool({
    name: "ask_file_picker",
    longRunning: true,
    description: "Show an interactive file picker for the user to select a file.",
    parameters: filePickerSchema,
    hidden: false,
    riskLevel: "read-only",
    validate: makeZodValidator(filePickerSchema),
    handler: (args: FilePickerArgs) =>
      Effect.gen(function* () {
        const presentation = yield* PresentationServiceTag;

        const request: FilePickerRequest = {
          message: args.message,
          basePath: args.base_path,
          extensions: args.extensions,
          includeDirectories: args.include_directories === true,
        };

        const selectedPath = yield* presentation.requestFilePicker(request);

        return {
          success: true,
          result: selectedPath ? `User selected: ${selectedPath}` : "User cancelled file selection",
        };
      }),
  }),
];
