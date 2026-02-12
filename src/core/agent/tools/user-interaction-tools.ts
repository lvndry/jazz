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
    .default([])
    .describe(
      "At least 2 suggested responses the user can pick from. Keep suggestions concise and actionable.",
    ),
  allow_custom: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether to allow custom text input in addition to suggestions (default: true)"),
  allow_multiple: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Whether the user can select multiple suggestions (default: false, single selection)",
    ),
});

type AskUserArgs = z.infer<typeof askUserSchema>;

const filePickerSchema = z.object({
  message: z.string().describe("Prompt message explaining what file the user should select"),
  base_path: z
    .string()
    .optional()
    .describe("Starting directory for file search (defaults to current working directory)"),
  extensions: z
    .array(z.string())
    .optional()
    .describe("Filter by file extensions without leading dot (e.g. ['ts', 'tsx', 'js'])"),
  include_directories: z
    .boolean()
    .optional()
    .default(false)
    .describe("Whether to include directories in results (default: false)"),
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
      "Ask the user a question with selectable suggested responses. This is a CLI environment — interactive selection is MUCH better UX than walls of text with questions buried in them. ALWAYS prefer this tool over plain-text questions when you need clarification, confirmation, or the user to choose between options. The user sees a clean interactive prompt where they can pick from suggestions or type a custom response. Ask only ONE question per call; if you have multiple questions, call this tool multiple times sequentially so the user can address each point individually.",
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
    description:
      "Let the user interactively select a file from the filesystem. Shows a fuzzy file picker where the user can type to filter files and navigate through results. Use when you need the user to choose a specific file.",
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
