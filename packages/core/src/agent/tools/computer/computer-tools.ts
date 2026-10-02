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
import { classifyApp, describeRefusal } from "./app-policy";
import { DRIVER_INSTALL_COMMAND, installDriver } from "./driver-install";
import { NOT_ACKNOWLEDGED_MESSAGE } from "./driver-pin";
import {
  DEFAULT_GRANT_EXPIRY_MS,
  DEFAULT_GRANT_IDLE_TIMEOUT_MS,
  type ComputerGrant,
  readComputerState,
  updateComputerState,
  withGrant,
} from "./grants";
import { firstReachMessage, rejectionMessageFor } from "./messages";
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
  COMPUTER_GRANT_APP_TOOL_NAME,
  COMPUTER_INSTALL_DRIVER_TOOL_NAME,
  COMPUTER_END_TOOL_NAME,
  COMPUTER_FOREGROUND_TOOL_NAME,
  COMPUTER_HANDOFF_TOOL_NAME,
  COMPUTER_INPUT_TOOL_NAME,
  COMPUTER_OBSERVE_TOOL_NAME,
  COMPUTER_WAIT_TOOL_NAME,
  COMPUTER_POINTER_TOOL_NAME,
} from "./tool-names";

/** Most characters one `type` action enters. */
const MAX_TYPED_TEXT_CHARACTERS = 4_000;

/** Most modifier keys one key press holds. */
const MAX_MODIFIERS = 4;

const DEFAULT_SCROLL_AMOUNT = 3;

const NOTIFICATION_TITLE = "Jazz · computer use (experimental)";

const DEFAULT_WAIT_TIMEOUT_MS = 5000;
const MAX_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_POLL_MS = 500;
const MAX_WAIT_POLL_MS = 2000;

const OBSERVE_HINT = "Observe the window to see the result.";

function failure(error: string): ToolExecutionResult {
  return { success: false, result: null, error: withUnblockHint(error) };
}

/**
 * The driver's error text names the state, not the fix. For the two cases that need the operator
 * in a terminal, append the exact unblock command so the model can relay it and the person can run it.
 */
const PERMISSIONS_UNBLOCK_HINT =
  " Unblock: run `cua-driver permissions grant` in your own terminal (System Settings → Privacy & " +
  "Security → Accessibility and Screen & System Audio Recording). If an entry is already allowed " +
  "but stale: `tccutil reset ScreenCapture com.trycua.driver && cua-driver permissions grant`. " +
  "Retry after it completes.";

const NOT_ACKNOWLEDGED_UNBLOCK_HINT =
  " (In the chat, the model can ask you to approve computer_install_driver, and the driver's own " +
  "`cua-driver permissions status` reports the state.)";

function withUnblockHint(message: string): string {
  if (
    /permission|accessibility|screen recording|tcc|capture/i.test(message) &&
    !message.includes("Unblock:")
  ) {
    return `${message}${PERMISSIONS_UNBLOCK_HINT}`;
  }
  if (message.includes(NOT_ACKNOWLEDGED_MESSAGE)) {
    return `${message}${NOT_ACKNOWLEDGED_UNBLOCK_HINT}`;
  }
  return message;
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
      "List the apps this run may control: the ones the operator granted, plus the running apps " +
      "you may still reach with a first-reach consent, and each one's visible windows. Call this " +
      "first, then computer_observe to look at a window.",
    tags: ["computer", "desktop", "apps"],
    parameters: appsParameters,
    validate: makeZodValidator(appsParameters),
    riskLevel: "read-only",
    hidden: false,
    handler: (_args, context) =>
      withComputer(context, (session) => session.apps()).pipe(
        Effect.map((apps) => {
          const granted = apps.filter((app) => app.expiresAt !== Number.MAX_SAFE_INTEGER);
          const consentable = apps.filter((app) => app.expiresAt === Number.MAX_SAFE_INTEGER);
          const lines = [
            ...granted.flatMap((app) => [
              `- ${app.name} (${app.bundleId}): ${app.tier}${app.foreground ? ", may be brought to the front" : ""}, ${app.running ? "running" : "not running"}, granted until ${formatExpiry(app.expiresAt)}`,
              ...app.windows.map(
                (window) => `    window ${String(window.windowId)} "${window.title}"`,
              ),
            ]),
            ...(consentable.length === 0 ? [] : [""]),
            ...(consentable.length === 0
              ? []
              : [
                  "Apps you may still reach (each one asks the person for consent on your first action in it):",
                ]),
            ...consentable.flatMap((app) => [
              `- ${app.name} (${app.bundleId}): ${app.tier}, ${app.running ? "running" : "not running"}`,
              ...app.windows.map(
                (window) => `    window ${String(window.windowId)} "${window.title}"`,
              ),
            ]),
          ];
          return {
            success: true,
            result:
              lines.length === 0
                ? "No app is running that Jazz may use. Open one, then call this again."
                : `Apps you may control:\n${lines.join("\n")}`,
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

const waitParameters = z
  .object({
    timeoutMs: z
      .number()
      .int()
      .min(250)
      .max(MAX_WAIT_TIMEOUT_MS)
      .optional()
      .describe(
        `Milliseconds to wait, ${String(250)} to ${String(MAX_WAIT_TIMEOUT_MS)} (default ${String(DEFAULT_WAIT_TIMEOUT_MS)}).`,
      ),
    pollMs: z
      .number()
      .int()
      .min(100)
      .max(MAX_WAIT_POLL_MS)
      .optional()
      .describe(
        `Milliseconds between window reads, ${String(100)} to ${String(MAX_WAIT_POLL_MS)} (default ${String(DEFAULT_WAIT_POLL_MS)}).`,
      ),
    until: z
      .enum(["settled", "changed"])
      .optional()
      .describe(
        "settled: two identical reads (default). changed: the window differs from the first read.",
      ),
  })
  .strict();

type WaitArgs = z.infer<typeof waitParameters>;

export function createComputerWaitTool(): Tool<AgentConfigService> {
  return defineTool<AgentConfigService, WaitArgs>({
    name: COMPUTER_WAIT_TOOL_NAME,
    disclosure: "private",
    summary:
      "Wait until the last observed window settles or changes, then return a fresh observation (experimental).",
    description:
      "Watch the window you last looked at or acted on. Waits until its outline stops changing " +
      "(settled) or changes from what it last showed (changed), then returns a fresh observation. " +
      "Use it instead of observing again right after an action that makes the window busy, such as " +
      "opening a document or loading a page.",
    tags: ["computer", "desktop", "read", "wait"],
    parameters: waitParameters,
    validate: makeZodValidator(waitParameters),
    riskLevel: "read-only",
    hidden: false,
    handler: (args, context) =>
      Effect.gen(function* () {
        const report = yield* withComputer(context, (session) =>
          session.wait({
            timeoutMs: args.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
            pollMs: args.pollMs ?? DEFAULT_WAIT_POLL_MS,
            until: args.until ?? "settled",
          }),
        );
        const verdict =
          report.outcome === "timeout"
            ? "The window had not settled or changed before the time ran out."
            : `The window ${report.outcome === "settled" ? "settled" : "changed"}.`;
        const observation = report.observation;
        return {
          success: true,
          result: `${verdict}\nobservation: c${String(observation.generation)}\n${observation.text}`,
          untrusted: untrusted(`${COMPUTER_WAIT_TOOL_NAME} ${observation.appName}`),
        } satisfies ToolExecutionResult;
      }).pipe(Effect.catchAll(toFailure)),
    createSummary: (result) => (result.success ? "Waited on a window" : undefined),
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
  windowId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Act on this specific top-level window of the app (window_id from computer_apps). " +
        "Pass it when the driver says the app owns more than one eligible top-level window.",
    ),
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
  captureAfter: z
    .boolean()
    .optional()
    .describe(
      "Also return a fresh observation of the window after the action, so the result and new refs come in one reply.",
    ),
};

type ActionName = "click" | "click_point" | "scroll" | "type" | "key";

interface ActionArgs {
  readonly action: ActionName;
  readonly ref?: string | undefined;
  readonly observation?: string | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly windowId?: number | undefined;
  readonly direction?: "up" | "down" | "left" | "right" | undefined;
  readonly amount?: number | undefined;
  readonly text?: string | undefined;
  readonly key?: string | undefined;
  readonly modifiers?: readonly string[] | undefined;
  readonly captureAfter?: boolean | undefined;
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
  // exactOptionalPropertyTypes: the field must be absent, not undefined.
  const windowTarget = args.windowId === undefined ? {} : { windowId: args.windowId };
  switch (args.action) {
    case "click":
      return { kind: "click", ref: args.ref ?? "", delivery, ...windowTarget };
    case "click_point":
      return {
        kind: "click_point",
        observation: args.observation ?? "",
        x: args.x ?? 0,
        y: args.y ?? 0,
        delivery,
        ...windowTarget,
      };
    case "scroll":
      return {
        kind: "scroll",
        ref: args.ref ?? "",
        direction: args.direction ?? "down",
        amount: args.amount ?? DEFAULT_SCROLL_AMOUNT,
        delivery,
        ...windowTarget,
      };
    case "type": {
      return {
        kind: "type",
        ref: args.ref ?? "",
        text: args.text ?? "",
        delivery,
        ...windowTarget,
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
        ...windowTarget,
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
      const pending = yield* Effect.tryPromise({
        try: () =>
          session.pendingConsent(toActionInput(args, foreground ? "foreground" : "background")),
        catch: toError,
      });
      if (pending !== undefined) {
        return {
          message: firstReachMessage(pending.appName, pending.bundleId),
          alwaysAsk: true,
          rejectionMessage: rejectionMessageFor(pending.appName),
        } as const;
      }
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
  if (report.observation !== undefined) {
    const observation = report.observation;
    return {
      success: report.effect !== "refused",
      result: `${lead}\n${detail.join("\n") || "Done."}\nobservation: c${String(observation.generation)}\n${observation.text}`,
      ...(report.effect === "refused" ? { error: `${report.app} refused the action.` } : {}),
      untrusted: untrusted(source),
    };
  }
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
    const input = toActionInput(args, delivery);
    const report = yield* withComputer(context, async (session) => {
      // The person already approved reaching this app: record the run-scoped consent before the
      // action performs, so a message-cached approval cannot skip the ask.
      const pending = await session.pendingConsent(input);
      if (pending !== undefined) {
        session.approveForRun(pending.bundleId, pending.appName);
      }
      return await session.perform(input, known, args.captureAfter === true);
    });
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

const grantAppParameters = z
  .object({
    bundleId: z.string().min(1).describe("The app's bundle id, from computer_apps."),
    foreground: z
      .boolean()
      .optional()
      .describe(
        "Also allow Jazz to bring the app to the front. Leave false unless the background tools cannot drive the app.",
      ),
  })
  .strict();

type GrantAppArgs = z.infer<typeof grantAppParameters>;

export function createComputerGrantAppTool(): ApprovalToolPair<AgentConfigService> {
  return defineApprovalTool<AgentConfigService, GrantAppArgs>({
    name: COMPUTER_GRANT_APP_TOOL_NAME,
    disclosure: "private",
    summary: "Grant this agent a lasting computer-use permission for one app (experimental).",
    description:
      "Grant a lasting computer-use permission for one app, so you are not asked again for it in later " +
      "conversations. The in-conversation first-reach ask already covers the current run; use this when the " +
      "person wants the access to stick. It names the app, its tier, and whether foreground access is included. " +
      "Granting stays your decision: the agent proposes, you approve.",
    tags: ["computer", "desktop", "grant"],
    parameters: grantAppParameters,
    validate: makeZodValidator(grantAppParameters),
    riskLevel: "low-risk",
    approvalMessage: (args) =>
      Effect.gen(function* () {
        const state = yield* Effect.promise(() => readComputerState());
        const appClass = classifyApp(args.bundleId);
        if (appClass === "refused") {
          throw new Error(`${describeRefusal(args.bundleId)} Granting it here would not help.`);
        }
        const known = state.grants.find((grant) => grant.bundleId === args.bundleId);
        return {
          message:
            `Grant lasting computer-use access to ${known?.name === undefined ? args.bundleId : `${known.name} (${args.bundleId})`}? ` +
            `Tier: ${appClass}. ${
              args.foreground
                ? "Includes bringing the app to the front (it may switch Spaces and take focus)."
                : "Background only; the app is not brought to the front."
            }\nExpires in ${String(DEFAULT_GRANT_EXPIRY_MS / 3_600_000)} hours; idle for more than ` +
            `${String(DEFAULT_GRANT_IDLE_TIMEOUT_MS / 60_000)} minutes pauses it. Remove it with ` +
            "`jazz computer revoke ${args.bundleId}`.",
          alwaysAsk: true,
        } as const;
      }),
    approvalErrorMessage: "Granting an app is your decision; approve it to continue.",
    handler: (args) =>
      Effect.gen(function* () {
        yield* toolKnownSecrets();
        const now = Date.now();
        const state = yield* Effect.promise(() => readComputerState());
        const known = state.grants.find((grant) => grant.bundleId === args.bundleId);
        const grant: ComputerGrant = {
          bundleId: args.bundleId,
          ...(known?.name === undefined ? {} : { name: known.name }),
          grantedAt: now,
          expiresAt: now + DEFAULT_GRANT_EXPIRY_MS,
          idleTimeoutMs: DEFAULT_GRANT_IDLE_TIMEOUT_MS,
          foreground: args.foreground === true,
        };
        yield* Effect.promise(() => updateComputerState((current) => withGrant(current, grant)));
        return {
          success: true,
          result: `Granted ${args.bundleId} ${
            args.foreground === true ? "with foreground access" : "(background)"
          } for ${String(DEFAULT_GRANT_EXPIRY_MS / 3_600_000)} hours. The app now works without asking in this and later runs.`,
        } satisfies ToolExecutionResult;
      }).pipe(Effect.catchAll(toFailure)),
  });
}

const installDriverParameters = z.object({}).strict();

export function createComputerInstallDriverTool(): ApprovalToolPair<AgentConfigService> {
  return defineApprovalTool<AgentConfigService, Record<string, never>>({
    name: COMPUTER_INSTALL_DRIVER_TOOL_NAME,
    disclosure: "private",
    summary: "Install the cua-driver binary on this machine (experimental).",
    description:
      "Install the computer-use driver (cua-driver) on this machine. Use it when a computer tool reports the " +
      "driver is missing. Approval shows the exact command it runs. After installing, the machine still needs a " +
      "one-time acknowledgment: `jazz computer acknowledge` in your own terminal (it pins the installed build " +
      "by digest).",
    tags: ["computer", "desktop", "install", "driver"],
    parameters: installDriverParameters,
    validate: makeZodValidator(installDriverParameters),
    riskLevel: "high-risk",
    approvalMessage: () =>
      Effect.succeed({
        message:
          `Install the computer-use driver (cua-driver) on this machine?\n\nIt runs:\n  ${DRIVER_INSTALL_COMMAND}\n\n` +
          "That downloads a signed release from cua.ai, verifies its SHA-256, installs it under /Applications " +
          "and links it into ~/.local/bin. Telemetry defaults to on (pseudonymous, content-free); disable it " +
          "with `cua-driver telemetry disable`.",
        alwaysAsk: true,
      } as const),
    approvalErrorMessage: "Installing the driver is your decision; approve it to continue.",
    handler: () =>
      Effect.gen(function* () {
        yield* toolKnownSecrets();
        const path = yield* Effect.promise(() => installDriver());
        return {
          success: true,
          result:
            `Installed the driver at ${path}. Run \`jazz computer acknowledge\` in your own terminal once, ` +
            "to pin this exact build by digest, then retry the computer tool.",
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
