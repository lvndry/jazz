import { Effect } from "effect";
import { z } from "zod";
import { RunParkRequested } from "@/core/agent/run/park-signal";
import {
  PresentationServiceTag,
  type FilePickerRequest,
  type SecretInputOutcome,
  type SecretInputRequest,
  type UserInputRequest,
} from "@/core/interfaces/presentation";
import type { Tool, ToolRequirements } from "@/core/interfaces/tool-registry";
import { redactionPlaceholder } from "@/core/secrets/secret-names";
import { MAX_USER_SECRET_NAME_LENGTH, USER_SECRET_NAME_PATTERN } from "@/core/secrets/user-secrets";
import { defineTool, makeZodValidator } from "./base-tool";

export const ASK_USER_SECRET_TOOL_NAME = "ask_user_secret";

/** The tools that stop for a person's answer, withheld from a run nobody can answer. */
export const INTERACTIVE_TOOL_NAMES: readonly string[] = [
  "ask_user_question",
  "ask_file_picker",
  ASK_USER_SECRET_TOOL_NAME,
];

const askUserSchema = z.object({
  question: z.string().describe("The single question blocking you."),
  suggested_responses: z
    .array(
      z.object({
        value: z.string().describe("Id returned when chosen."),
        label: z.string().optional().describe("Short display label."),
        description: z.string().optional().describe("One-line explanation."),
      }),
    )
    .min(2)
    .max(4)
    .describe("Concrete, self-contained options."),
  allow_multiple: z.boolean().optional().default(false).describe("Allow several selections."),
});

type AskUserArgs = z.infer<typeof askUserSchema>;

const filePickerSchema = z.object({
  message: z.string().describe("Prompt shown above the picker."),
  base_path: z
    .string()
    .optional()
    .describe("Start directory. Defaults to the session working directory."),
  extensions: z.array(z.string()).optional().describe("Extensions to show, without the dot."),
  include_directories: z
    .boolean()
    .optional()
    .default(false)
    .describe("Also allow picking directories."),
});

type FilePickerArgs = z.infer<typeof filePickerSchema>;

const askSecretSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe("What the secret is for, shown to the person, e.g. 'Password for invoice.pdf'."),
  name: z
    .string()
    .max(MAX_USER_SECRET_NAME_LENGTH)
    .regex(USER_SECRET_NAME_PATTERN, "Use lowercase words joined by hyphens, e.g. pdf-password.")
    .optional()
    .describe("Short kebab-case label for the placeholder, e.g. pdf-password."),
});

type AskSecretArgs = z.infer<typeof askSecretSchema>;

const SECRET_DECLINED_RESULT =
  "The person chose not to type this secret. Treat that as their decision: carry on with what needs no secret, and say plainly what stays locked without it.";

function secretHeldResult(name: string): string {
  const placeholder = redactionPlaceholder(name);
  return `The person typed the secret. It is held for this run as ${placeholder}: pass ${placeholder} exactly as written as the value of the argument that needs it.`;
}

function secretUnavailableResult(outcome: Extract<SecretInputOutcome, { kind: "unavailable" }>) {
  return outcome.reason === "shared-chat"
    ? "This chat is shared with other people, so the secret was not collected here. Tell the person to message you in a private chat and ask for it there."
    : "Nobody can type a secret in this run. Say which step needs it and carry on with everything that does not.";
}

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
      "Ask the human one blocking decision: an approach with no clear best option, or sign-off on a destructive action. Proceed on your own with requested or reversible work and anything a tool can answer. For a password, token or passphrase, use ask_user_secret.",
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
    name: ASK_USER_SECRET_TOOL_NAME,
    disclosure: "private",
    longRunning: true,
    description:
      "Ask the person to type a password, token or passphrase only they know, such as the password of an encrypted PDF. " +
      "They type it hidden; you get back a placeholder like [redacted:pdf-password]. " +
      "Pass that placeholder as-is to the argument that needs the secret, such as a PDF tool's password or inside a shell command.",
    parameters: askSecretSchema,
    hidden: false,
    riskLevel: "read-only",
    validate: makeZodValidator(askSecretSchema),
    handler: (args: AskSecretArgs, context) =>
      Effect.gen(function* () {
        const store = context.userSecrets;
        if (store === undefined) {
          return {
            success: false,
            result: "This run cannot hold a secret. Say which step needs one and carry on.",
          };
        }
        const presentation = yield* PresentationServiceTag;
        const request: SecretInputRequest = { prompt: args.prompt, name: store.nameFor(args.name) };

        const prior =
          context.toolCallId === undefined
            ? undefined
            : context.resolvedUserSecrets?.get(context.toolCallId);
        if (prior !== undefined) {
          if (prior.kind === "declined") {
            return { success: false, result: SECRET_DECLINED_RESULT };
          }
          store.hold(request.name, prior.value);
          return { success: true, result: secretHeldResult(request.name) };
        }

        if (context.parkWhenUnattended === true && presentation.canPromptForApproval?.() !== true) {
          if (context.toolCallId === undefined) {
            return { success: false, result: "The person cannot be reached from this run." };
          }
          return yield* Effect.fail(
            new RunParkRequested({
              pending: { kind: "secret", request, toolCallId: context.toolCallId },
            }),
          );
        }

        const outcome: SecretInputOutcome =
          presentation.requestSecretInput === undefined
            ? { kind: "unavailable" }
            : yield* presentation.requestSecretInput(request);

        if (outcome.kind === "declined") {
          return { success: false, result: SECRET_DECLINED_RESULT };
        }
        if (outcome.kind === "unavailable") {
          return { success: false, result: secretUnavailableResult(outcome) };
        }
        store.hold(request.name, outcome.value);
        return { success: true, result: secretHeldResult(request.name) };
      }),
  }),
  defineTool({
    name: "ask_file_picker",
    disclosure: "private",
    longRunning: true,
    description:
      "Let the human pick a file interactively when you cannot identify the file yourself. Interactive sessions only.",
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
