import { Effect } from "effect";
import { z } from "zod";
import { RunParkRequested } from "@/core/agent/run/park-signal";
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
    .describe("2-4 concrete, self-contained options."),
  allow_multiple: z.boolean().optional().default(false).describe("Allow multiple selections."),
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
      "Ask the human one blocking question with 2-4 concrete options. " +
      "Ask only when you are actually blocked: a scope or approach decision with no clearly best option, a destructive action that needs explicit sign-off, or a secret or provider choice no tool can fetch. " +
      "Do not ask permission to do work they already requested, confirmation of safe reversible actions, anything already answered, or anything a tool can resolve. " +
      "Surfaces work anywhere a human is reachable, including chat bridges with no TTY; when nobody is, the tool says so and you must then decide on a stated assumption or ask in your reply. One decision per call.",
    parameters: askUserSchema,
    hidden: false,
    riskLevel: "read-only",
    validate: makeZodValidator(askUserSchema),
    handler: (args: AskUserArgs, context) =>
      Effect.gen(function* () {
        const presentation = yield* PresentationServiceTag;

        const request: UserInputRequest = {
          question: args.question,
          suggestions: args.suggested_responses,
          allowCustom: true,
          allowMultiple: args.allow_multiple === true,
        };

        const prior =
          context.toolCallId === undefined
            ? undefined
            : context.resolvedUserInputs?.get(context.toolCallId);
        if (prior !== undefined) {
          if (prior.kind === "declined") {
            return {
              success: false,
              result:
                "The human saw this question and declined to answer. Treat that as their decision, not as a gap to fill: do not pick an answer for them.",
            };
          }
          return { success: true, result: `User responded: ${prior.response}` };
        }

        if (context.parkWhenUnattended === true && presentation.canPromptForApproval?.() !== true) {
          if (context.toolCallId === undefined) {
            return { success: false, result: "The human cannot be reached from this run." };
          }
          return yield* Effect.fail(
            new RunParkRequested({
              pending: { kind: "question", request, toolCallId: context.toolCallId },
            }),
          );
        }

        const outcome = yield* presentation.requestUserInput(request);

        if (outcome.kind === "declined") {
          return {
            success: false,
            result:
              "The human saw this question and declined to answer. Treat that as their decision, not as a gap to fill: " +
              "do not pick an answer for them and do not ask again. Do only what is unambiguous without it, " +
              "and say plainly what remains blocked and why.",
          };
        }

        if (outcome.kind === "unavailable") {
          return {
            success: false,
            result:
              "Nobody could be asked — no human ever saw this question. Do not report it as unanswered or wait for a reply. " +
              "Decide yourself, state the assumption you are proceeding on, and carry on.",
          };
        }

        return {
          success: true,
          result: `User responded: ${outcome.response}`,
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
    handler: (args: FilePickerArgs, context) =>
      Effect.gen(function* () {
        const presentation = yield* PresentationServiceTag;

        const request: FilePickerRequest = {
          message: args.message,
          basePath: args.base_path,
          extensions: args.extensions,
          includeDirectories: args.include_directories === true,
        };

        const prior =
          context.toolCallId === undefined
            ? undefined
            : context.resolvedFilePickers?.get(context.toolCallId);
        if (prior !== undefined) {
          return {
            success: true,
            result:
              prior.kind === "selected"
                ? `User selected: ${prior.path}`
                : "User cancelled file selection",
          };
        }

        if (context.parkWhenUnattended === true && presentation.canPromptForApproval?.() !== true) {
          if (context.toolCallId === undefined) {
            return { success: false, result: "The human cannot be reached from this run." };
          }
          return yield* Effect.fail(
            new RunParkRequested({
              pending: { kind: "file-picker", request, toolCallId: context.toolCallId },
            }),
          );
        }

        const selectedPath = yield* presentation.requestFilePicker(request);

        return {
          success: true,
          result: selectedPath ? `User selected: ${selectedPath}` : "User cancelled file selection",
        };
      }),
  }),
];
