/**
 * The computer tools (experimental): look at, and act in, apps the operator granted.
 *
 * Reading is one tool. Acting is split by how much harm it can do, because the approval tiers
 * attach to a tool, not to a call: pointer actions are `low-risk`, typing and key presses are
 * `high-risk`, and anything that brings an app to the front is its own `high-risk` tool.
 *
 * Everything the model reads from a window is another party's text. Results carry `untrusted`
 * provenance, so the run is marked as having read external content and its later outbound tools
 * stop auto-approving. The tools exist only in a terminal conversation with a person watching;
 * `agent-tool-resolution.ts` removes them from every other run.
 */

import { Effect, Option } from "effect";
import { z } from "zod";
import type { AgentConfigService } from "@/core/interfaces/agent-config";
import { NotificationServiceTag } from "@/core/interfaces/notification";
import type { Tool } from "@/core/interfaces/tool-registry";
import { redactionPlaceholder } from "@/core/secrets/secret-names";
import { heldUserSecrets, userSecretNamesIn } from "@/core/secrets/user-secrets";
import type {
  ToolExecutionContext,
  ToolExecutionResult,
  UntrustedProvenance,
} from "@/core/types/tools";
import { toError } from "@/core/utils/errors";
import {
  type ApprovalToolPair,
  defineApprovalTool,
  defineTool,
  makeZodValidator,
} from "../base-tool";
import { toolKnownSecrets } from "../tool-secrets";
import { openComputerSession } from "./open";
import {
  type ActionInput,
  type ActionReport,
  type ComputerSession,
  type ComputerSessions,
  ComputerStoppedError,
  MAX_SCROLL_AMOUNT,
} from "./session";
import {
  COMPUTER_APPS_TOOL_NAME,
  COMPUTER_END_TOOL_NAME,
  COMPUTER_FOREGROUND_TOOL_NAME,
  COMPUTER_HANDOFF_TOOL_NAME,
  COMPUTER_INPUT_TOOL_NAME,
  COMPUTER_OBSERVE_TOOL_NAME,
  COMPUTER_POINTER_TOOL_NAME,
} from "./tool-names";

/** Most characters one `type` action enters. */
const MAX_TYPED_TEXT_CHARACTERS = 4_000;

/** Most modifier keys one key press holds. */
const MAX_MODIFIERS = 4;

const DEFAULT_SCROLL_AMOUNT = 3;

const NOTIFICATION_TITLE = "Jazz · computer use (experimental)";

const OBSERVE_HINT = "Observe the window to see the result.";

function failure(error: string): ToolExecutionResult {
  return { success: false, result: null, error };
}

function sessionsFor(context: ToolExecutionContext): ComputerSessions | undefined {
  return context.computerSessions;
}

/** Run `operation` on the run's computer session, starting it on first use. */
function withComputer<Value>(
  context: ToolExecutionContext,
  operation: (session: ComputerSession) => Promise<Value>,
): Effect.Effect<Value, Error, AgentConfigService> {
  return Effect.gen(function* () {
    const sessions = sessionsFor(context);
    if (sessions === undefined) {
      return yield* Effect.fail(new Error("The computer tools work only inside an agent run."));
    }
    const notifier = yield* Effect.serviceOption(NotificationServiceTag);
    const announce = (message: string): void => {
      if (Option.isSome(notifier)) {
        void Effect.runPromise(
          notifier.value.notify(message, { title: NOTIFICATION_TITLE, sound: false }),
        ).catch(() => undefined);
      }
    };
    return yield* Effect.tryPromise({
      try: async () => {
        const session = await sessions.obtain(() =>
          openComputerSession({
            agentId: context.agentId,
            conversationId: context.conversationId,
            announce,
          }),
        );
        try {
          return await session.exclusive(() => operation(session));
        } catch (error) {
          if (error instanceof ComputerStoppedError) {
            await sessions.close();
          }
          throw error;
        }
      },
      catch: toError,
    });
  });
}

function toFailure(error: Error): Effect.Effect<ToolExecutionResult> {
  return Effect.succeed(failure(error.message));
}

function untrusted(source: string): UntrustedProvenance {
  return { kind: "external", source };
}

function formatExpiry(expiresAt: number): string {
  return new Date(expiresAt).toLocaleString();
}

const appsParameters = z.object({}).strict();

export function createComputerAppsTool(): Tool<AgentConfigService> {
  return defineTool<AgentConfigService, Record<string, never>>({
    name: COMPUTER_APPS_TOOL_NAME,
    disclosure: "private",
    summary:
      "List the desktop apps you may control on this computer, what each allows, and their windows (experimental).",
    description:
      "List the apps the operator granted for computer use, what each one allows, and its " +
      "visible windows. Call this first, then computer_observe to look at a window.",
    tags: ["computer", "desktop", "apps"],
    parameters: appsParameters,
    validate: makeZodValidator(appsParameters),
    riskLevel: "read-only",
    hidden: false,
    handler: (_args, context) =>
      withComputer(context, (session) => session.apps()).pipe(
        Effect.map((apps) => {
          const lines = apps.flatMap((app) => [
            `- ${app.name} (${app.bundleId}): ${app.tier}${app.foreground ? ", may be brought to the front" : ""}, ${app.running ? "running" : "not running"}, granted until ${formatExpiry(app.expiresAt)}`,
            ...app.windows.map(
              (window) => `    window ${String(window.windowId)} "${window.title}"`,
            ),
          ]);
          return {
            success: true,
            result: `Apps you may control:\n${lines.join("\n")}`,
            untrusted: untrusted(COMPUTER_APPS_TOOL_NAME),
          } satisfies ToolExecutionResult;
        }),
        Effect.catchAll(toFailure),
      ),
    createSummary: (result) => (result.success ? "Listed the apps you may control" : undefined),
  });
}

const observeParameters = z
  .object({
    app: z
      .string()
      .min(1)
      .optional()
      .describe("App name or bundle id. Omit it when only one granted app is running."),
    windowId: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Window id from computer_apps. Omit it for the app's front window."),
    screenshot: z
      .boolean()
      .optional()
      .describe("true also saves a PNG of the window; pass its path to analyze_media."),
    query: z
      .string()
      .min(1)
      .optional()
      .describe("Show only the elements whose text matches. Use it on a large window."),
  })
  .strict();

type ObserveArgs = z.infer<typeof observeParameters>;

export function createComputerObserveTool(): Tool<AgentConfigService> {
  return defineTool<AgentConfigService, ObserveArgs>({
    name: COMPUTER_OBSERVE_TOOL_NAME,
    disclosure: "private",
    summary:
      "Read one window of a granted desktop app as a text outline with refs for its controls (experimental).",
    description:
      "Read one window of a granted app as a text outline of its controls. Each element you may " +
      "act on ends with a ref such as [ref=c3.12]; the outline names its observation, such as " +
      "c3. Observe again after the window changes: a new observation replaces the earlier refs " +
      "for that window. screenshot true also saves a PNG for analyze_media.",
    tags: ["computer", "desktop", "read", "screenshot"],
    parameters: observeParameters,
    validate: makeZodValidator(observeParameters),
    riskLevel: "read-only",
    hidden: false,
    handler: (args, context) =>
      Effect.gen(function* () {
        const known = yield* toolKnownSecrets();
        const observation = yield* withComputer(context, (session) =>
          session.observe(
            {
              app: args.app,
              windowId: args.windowId,
              screenshot: args.screenshot === true,
              query: args.query,
            },
            known,
          ),
        );
        return {
          success: true,
          result: `observation: c${String(observation.generation)}\n${observation.text}`,
          untrusted: untrusted(`${COMPUTER_OBSERVE_TOOL_NAME} ${observation.appName}`),
        } satisfies ToolExecutionResult;
      }).pipe(Effect.catchAll(toFailure)),
    createSummary: (result) => (result.success ? "Looked at a window" : undefined),
  });
}

const baseActionFields = {
  ref: z
    .string()
    .min(1)
    .optional()
    .describe("Ref from the latest computer_observe, such as c3.12."),
  observation: z
    .string()
    .min(1)
    .optional()
    .describe("Observation id from the latest computer_observe, such as c3."),
  x: z.number().int().min(0).optional().describe("Pixel across the observation's screenshot."),
  y: z.number().int().min(0).optional().describe("Pixel down the observation's screenshot."),
  direction: z.enum(["up", "down", "left", "right"]).optional().describe("Scroll direction."),
  amount: z
    .number()
    .int()
    .min(1)
    .max(MAX_SCROLL_AMOUNT)
    .optional()
    .describe(
      `Lines to scroll, 1 to ${String(MAX_SCROLL_AMOUNT)} (default ${String(DEFAULT_SCROLL_AMOUNT)}).`,
    ),
  text: z
    .string()
    .max(MAX_TYPED_TEXT_CHARACTERS)
    .optional()
    .describe(
      "Text to enter into the element. Pass a secret from ask_user_secret as its placeholder.",
    ),
  key: z
    .string()
    .min(1)
    .optional()
    .describe("A named key such as Return, Tab, Escape or an arrow, or a letter with modifiers."),
  modifiers: z
    .array(z.string().min(1))
    .max(MAX_MODIFIERS)
    .optional()
    .describe("Modifier keys held with the key: cmd, ctrl, option, shift."),
};

type ActionName = "click" | "click_point" | "scroll" | "type" | "key";

interface ActionArgs {
  readonly action: ActionName;
  readonly ref?: string | undefined;
  readonly observation?: string | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly direction?: "up" | "down" | "left" | "right" | undefined;
  readonly amount?: number | undefined;
  readonly text?: string | undefined;
  readonly key?: string | undefined;
  readonly modifiers?: readonly string[] | undefined;
}

const REQUIRED_FIELDS: Readonly<Record<ActionName, readonly (keyof ActionArgs)[]>> = {
  click: ["ref"],
  click_point: ["observation", "x", "y"],
  scroll: ["ref", "direction"],
  type: ["ref", "text"],
  key: ["observation", "key"],
};

function requireFields(args: ActionArgs, refinement: z.RefinementCtx): void {
  for (const field of REQUIRED_FIELDS[args.action]) {
    if (args[field] === undefined) {
      refinement.addIssue({
        code: "custom",
        message: `${args.action} needs ${field}`,
        path: [field],
      });
    }
  }
}

function toActionInput(args: ActionArgs, delivery: "background" | "foreground"): ActionInput {
  switch (args.action) {
    case "click":
      return { kind: "click", ref: args.ref ?? "", delivery };
    case "click_point":
      return {
        kind: "click_point",
        observation: args.observation ?? "",
        x: args.x ?? 0,
        y: args.y ?? 0,
        delivery,
      };
    case "scroll":
      return {
        kind: "scroll",
        ref: args.ref ?? "",
        direction: args.direction ?? "down",
        amount: args.amount ?? DEFAULT_SCROLL_AMOUNT,
        delivery,
      };
    case "type": {
      return {
        kind: "type",
        ref: args.ref ?? "",
        text: args.text ?? "",
        delivery,
        secretPlaceholderGiven: heldUserSecrets().some(
          (secret) => secret.value.length > 0 && (args.text ?? "").includes(secret.value),
        ),
      };
    }
    case "key":
      return {
        kind: "key",
        observation: args.observation ?? "",
        key: args.key ?? "",
        modifiers: args.modifiers ?? [],
        delivery,
      };
  }
}

function describeAction(args: ActionArgs, session: ComputerSession): string | undefined {
  const element = args.ref === undefined ? undefined : session.describeRef(args.ref);
  const window =
    args.observation === undefined ? undefined : session.describeObservation(args.observation);
  switch (args.action) {
    case "click":
      return element === undefined ? undefined : `Click ${element}`;
    case "click_point":
      return window === undefined
        ? undefined
        : `Click at ${String(args.x ?? 0)},${String(args.y ?? 0)} in ${window}`;
    case "scroll":
      return element === undefined
        ? undefined
        : `Scroll ${args.direction ?? "down"} ${String(args.amount ?? DEFAULT_SCROLL_AMOUNT)} in ${element}`;
    case "type":
      return element === undefined
        ? undefined
        : `Type ${JSON.stringify(args.text ?? "")} into ${element}`;
    case "key":
      return window === undefined
        ? undefined
        : `Press ${[...(args.modifiers ?? []), args.key ?? ""].join("+")} in ${window}`;
  }
}

const STALE_TARGET_MESSAGE =
  "Nothing matches that ref or observation. Observe the window and use a current ref.";

/**
 * The approval for one computer action: what it does, to which element of which app. A typed
 * secret is named by its placeholder and always put to a person, and a password field accepts
 * nothing else.
 */
function approveAction(args: ActionArgs, context: ToolExecutionContext, foreground: boolean) {
  return Effect.gen(function* () {
    const pending = sessionsFor(context)?.peek();
    if (pending === undefined) {
      return {
        skipApproval: true,
        toolResult: failure("No window has been observed. Use computer_observe first."),
      } as const;
    }
    const session = yield* Effect.tryPromise({ try: () => pending, catch: toError });
    const description = describeAction(args, session);
    if (description === undefined) {
      return { skipApproval: true, toolResult: failure(STALE_TARGET_MESSAGE) } as const;
    }
    const lead = foreground ? "Bring the app to the front, then: " : "";
    const message = `${lead}${description}`;

    const typedSecrets =
      context.userSecrets === undefined || args.text === undefined
        ? []
        : userSecretNamesIn(args.text, context.userSecrets);
    if (args.action === "type" && args.ref !== undefined && session.isSecureField(args.ref)) {
      if (typedSecrets.length === 0) {
        return {
          skipApproval: true,
          toolResult: failure(
            "That is a password field. Collect the password with ask_user_secret and pass its placeholder as the text.",
          ),
        } as const;
      }
    }
    if (typedSecrets.length === 0) {
      return message;
    }
    return {
      message: `${message}\n\nApproving enters the secret you typed in place of ${typedSecrets.map(redactionPlaceholder).join(", ")} into this app. Approve only if you expect this app to receive it.`,
      alwaysAsk: true,
    } as const;
  });
}

function reportResult(report: ActionReport, source: string): ToolExecutionResult {
  const lead = `${report.app}: ${report.effect}`;
  const detail = [report.summary, report.hint].filter((part): part is string => part !== null);
  const note =
    report.effect === "suspected_noop"
      ? "The driver saw no change. Observe the window to check, and try a screenshot and a pixel click if the control is not in the outline."
      : report.effect === "refused"
        ? "The driver refused the action."
        : OBSERVE_HINT;
  return {
    success: report.effect !== "refused",
    result: [lead, ...detail, note].join("\n"),
    ...(report.effect === "refused" ? { error: `${report.app} refused the action.` } : {}),
    untrusted: untrusted(source),
  };
}

function performAction(
  args: ActionArgs,
  delivery: "background" | "foreground",
  source: string,
  context: ToolExecutionContext,
) {
  return Effect.gen(function* () {
    const known = yield* toolKnownSecrets();
    const report = yield* withComputer(context, (session) =>
      session.perform(toActionInput(args, delivery), known),
    );
    return reportResult(report, source);
  }).pipe(Effect.catchAll(toFailure));
}

const pointerParameters = z
  .object({
    action: z.enum(["click", "click_point", "scroll"]).describe("click, click_point or scroll."),
    ...baseActionFields,
  })
  .strict()
  .superRefine(requireFields);

type PointerArgs = z.infer<typeof pointerParameters>;

export function createComputerPointerTools(): ApprovalToolPair<AgentConfigService> {
  return defineApprovalTool<AgentConfigService, PointerArgs>({
    name: COMPUTER_POINTER_TOOL_NAME,
    disclosure: "private",
    summary:
      "Click or scroll in a granted desktop app window without moving your cursor (experimental).",
    description:
      "Click an element by ref, click a pixel of the observation's screenshot, or scroll an " +
      "element's area. Runs in the background and leaves the person's cursor and focus alone. " +
      "Elements come from the latest computer_observe.",
    tags: ["computer", "desktop", "click", "scroll"],
    parameters: pointerParameters,
    validate: makeZodValidator(pointerParameters),
    riskLevel: "low-risk",
    egress: true,
    approvalMessage: (args, context) => approveAction(args, context, false),
    approvalErrorMessage: "Computer actions need your approval.",
    handler: (args, context) =>
      performAction(args, "background", COMPUTER_POINTER_TOOL_NAME, context),
    createSummary: (result) => (result.success ? "Acted in an app" : undefined),
  });
}

const inputParameters = z
  .object({
    action: z.enum(["type", "key"]).describe("type or key."),
    ...baseActionFields,
  })
  .strict()
  .superRefine(requireFields);

type InputArgs = z.infer<typeof inputParameters>;

export function createComputerInputTools(): ApprovalToolPair<AgentConfigService> {
  return defineApprovalTool<AgentConfigService, InputArgs>({
    name: COMPUTER_INPUT_TOOL_NAME,
    disclosure: "private",
    summary:
      "Type into a field or press a key or shortcut in a granted desktop app (experimental).",
    description:
      "Type text into an element by ref, or press a named key or shortcut in an observed window. " +
      "Runs in the background. To sign in, collect the password with ask_user_secret and pass " +
      "its placeholder as text.",
    tags: ["computer", "desktop", "type", "keyboard"],
    parameters: inputParameters,
    validate: makeZodValidator(inputParameters),
    riskLevel: "high-risk",
    egress: true,
    userSecretArguments: ["text"],
    approvalMessage: (args, context) => approveAction(args, context, false),
    approvalErrorMessage: "Computer input needs your approval.",
    handler: (args, context) =>
      performAction(args, "background", COMPUTER_INPUT_TOOL_NAME, context),
    createSummary: (result) => (result.success ? "Typed in an app" : undefined),
  });
}

const foregroundParameters = z
  .object({
    action: z
      .enum(["click", "click_point", "scroll", "type", "key"])
      .describe("click, click_point, scroll, type or key."),
    ...baseActionFields,
  })
  .strict()
  .superRefine(requireFields);

type ForegroundArgs = z.infer<typeof foregroundParameters>;

export function createComputerForegroundTools(): ApprovalToolPair<AgentConfigService> {
  return defineApprovalTool<AgentConfigService, ForegroundArgs>({
    name: COMPUTER_FOREGROUND_TOOL_NAME,
    disclosure: "private",
    summary:
      "Bring a granted desktop app to the front and act in it, for apps the background tools cannot drive (experimental).",
    description:
      "Do the same clicks, scrolls, typing and key presses as the background tools, but bring " +
      "the app to the front first. The app must be granted for foreground use. Use it only " +
      "when the background tools report no change.",
    tags: ["computer", "desktop", "foreground"],
    parameters: foregroundParameters,
    validate: makeZodValidator(foregroundParameters),
    riskLevel: "high-risk",
    egress: true,
    userSecretArguments: ["text"],
    approvalMessage: (args, context) => approveAction(args, context, true),
    approvalErrorMessage: "Bringing an app to the front needs your approval.",
    handler: (args, context) =>
      performAction(args, "foreground", COMPUTER_FOREGROUND_TOOL_NAME, context),
    createSummary: (result) => (result.success ? "Acted in an app in front" : undefined),
  });
}

const handoffParameters = z
  .object({
    reason: z
      .string()
      .min(1)
      .max(300)
      .describe("What the person should do themselves, such as signing in to an app."),
  })
  .strict();

type HandoffArgs = z.infer<typeof handoffParameters>;

export function createComputerHandoffTools(): ApprovalToolPair<AgentConfigService> {
  return defineApprovalTool<AgentConfigService, HandoffArgs>({
    name: COMPUTER_HANDOFF_TOOL_NAME,
    disclosure: "private",
    summary:
      "Pause and ask the person to do a step themselves, such as signing in to an app (experimental).",
    description:
      "Ask the person to do a step on their computer themselves, such as signing in. Computer " +
      "use pauses until they approve, and Jazz reads nothing and acts on nothing while they work.",
    tags: ["computer", "desktop", "login", "handoff"],
    parameters: handoffParameters,
    validate: makeZodValidator(handoffParameters),
    riskLevel: "low-risk",
    approvalMessage: (args) =>
      Effect.succeed({
        message: `Computer use is paused. ${args.reason}\n\nDo it yourself now, then approve to let Jazz continue. Jazz looks at the screen again afterwards.`,
        alwaysAsk: true,
      } as const),
    approvalErrorMessage: "Computer use is paused until you finish the step.",
    handler: (_args, context) =>
      Effect.gen(function* () {
        const known = yield* toolKnownSecrets();
        yield* withComputer(context, (session) => session.handoff(known));
        return {
          success: true,
          result: `The person finished the step. Every earlier observation is cleared. ${OBSERVE_HINT}`,
        } satisfies ToolExecutionResult;
      }).pipe(Effect.catchAll(toFailure)),
  });
}

const endParameters = z.object({}).strict();

export function createComputerEndTool(): Tool<AgentConfigService> {
  return defineTool<AgentConfigService, Record<string, never>>({
    name: COMPUTER_END_TOOL_NAME,
    disclosure: "private",
    summary: "Stop using the computer and release the desktop (experimental).",
    description:
      "Stop computer use: close the driver, delete this run's screenshots and release the " +
      "desktop. Call it when the task on the computer is done. The next computer tool call starts again.",
    tags: ["computer", "desktop"],
    parameters: endParameters,
    validate: makeZodValidator(endParameters),
    riskLevel: "read-only",
    hidden: false,
    handler: (_args, context) =>
      Effect.tryPromise({
        try: async () => {
          await sessionsFor(context)?.release();
          return { success: true, result: "Computer use ended." } satisfies ToolExecutionResult;
        },
        catch: toError,
      }).pipe(Effect.catchAll(toFailure)),
  });
}
