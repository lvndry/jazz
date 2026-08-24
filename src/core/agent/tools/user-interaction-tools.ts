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
  message: z.string().describe("Prompt shown above the picker."),
  base_path: z
    .string()
    .optional()
    .describe("Directory to start in. Defaults to the session working directory."),
  extensions: z
    .array(z.string())
    .optional()
    .describe("Only show files with these extensions, without the dot. Example: ['ts', 'js']."),
  include_directories: z
    .boolean()
    .optional()
    .default(false)
    .describe("Also let the user pick directories. Default false."),
});

type FilePickerArgs = z.infer<typeof filePickerSchema>;

/**
 * Tools for user interaction during agent execution.
 * These tools allow the agent to gather clarifications before proceeding.
 */
export const userInteractionTools: Tool<ToolRequirements>[] = [
  defineTool({
    name: "ask_user_question",
    disclosure: "private",
    longRunning: true,
    description:
      "Ask the human one blocking question with 2–4 concrete options. Use this tool; do not bury the question in prose. " +
      "Ask only when you are actually blocked: a scope or approach decision with no clearly best option, a destructive action that needs explicit sign-off, or a secret or provider choice no tool can fetch. " +
      "Do not ask permission to do work they already requested, confirmation of safe reversible actions, anything already answered, or anything a tool can resolve. " +
      "When there is no TTY (headless), do not call this — decide or fail. One decision per call.",
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

        // Every non-interactive presentation answers with an empty string: there
        // is nobody at a TTY to ask. Reporting that as a successful answer is how
        // an agent ends up acting on a decision the human never made — a bridge
        // asked for an appointment date, got "", and set a reminder for 30
        // minutes' time. Say plainly that no answer arrived so the model decides
        // openly, or puts the question in its reply where a human will see it.
        if (response.trim().length === 0) {
          return {
            success: false,
            result:
              "No answer was given — there is no interactive channel here, or the human dismissed the question. " +
              "Do not treat this as an answer or invent one. Either proceed on a stated assumption, or ask in your reply.",
          };
        }

        return {
          success: true,
          result: `User responded: ${response}`,
        };
      }),
  }),
  defineTool({
    name: "ask_file_picker",
    disclosure: "private",
    longRunning: true,
    description:
      "Show an interactive file picker so the human can choose a path. Use this when they need to pick among files you cannot uniquely identify. Prefer find or ls when you can locate the file yourself. When there is no TTY (headless), do not call this — decide or fail.",
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
