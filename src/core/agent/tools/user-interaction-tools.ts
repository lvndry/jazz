import { Effect } from "effect";
import { z } from "zod";
import {
  PresentationServiceTag,
  type FilePickerRequest,
  type UserInputRequest,
} from "@/core/interfaces/presentation";
import type { Tool, ToolRequirements } from "@/core/interfaces/tool-registry";
import { defineTool, makeZodValidator } from "./base-tool";

const askUserSchema = z.object({
  question: z.string().describe("The one question the human must answer to unblock you."),
  suggested_responses: z
    .array(
      z.object({
        value: z.string().describe("Stable id returned when this option is chosen."),
        label: z.string().optional().describe("Short label shown in the picker."),
        description: z
          .string()
          .optional()
          .describe("One-line explanation of what this option means."),
      }),
    )
    .min(2)
    .max(4)
    .describe("2–4 concrete, self-contained options."),
  allow_multiple: z.boolean().optional().describe("Allow multiple selections (default: false)."),
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
      "Ask the human one blocking question with 2–4 concrete options. Use the tool, never bury the question in prose. " +
      "Ask only when you are actually blocked: a scope/approach fork with no clearly best option; a destructive action that needs explicit sign-off; a secret or provider choice no tool can fetch. " +
      "Do NOT ask: permission to do work they already requested; confirmation of safe reversible actions; anything already answered; anything a tool can resolve; when TTY is no (headless — decide or fail). One decision per call.",
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
          allowCustom: true,
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
    description:
      "Show an interactive file picker so the human can choose a path. Use when they need to pick among files you cannot uniquely identify. Prefer find/ls when you can locate the file yourself. Headless (TTY no): do not call this — fail or decide.",
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
