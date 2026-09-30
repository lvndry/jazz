/**
 * The browser tools: drive a real page from text.
 *
 * The agent reads a page as an accessibility snapshot whose interactive elements carry refs,
 * and acts on those refs. Reading and navigating are ordinary tools; `browser_act`, which clicks,
 * types and presses keys, is an approval pair because a click can submit a form or buy
 * something.
 *
 * Everything a page shows the model is another party's text. Results carry `untrusted`
 * provenance, so the run is marked as having read external content and its later outbound tools
 * stop auto-approving.
 */

import { mkdir } from "node:fs/promises";
import { Effect } from "effect";
import shortuuid from "short-uuid";
import { z } from "zod";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import type { Tool } from "@/core/interfaces/tool-registry";
import { redactionPlaceholder } from "@/core/secrets/secret-names";
import { userSecretNamesIn } from "@/core/secrets/user-secrets";
import type { GeneratedArtifact } from "@/core/types/artifact";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types/tools";
import { toError } from "@/core/utils/errors";
import { getUserDataDirectory } from "@/core/utils/paths";
import { stateDirectoryMode } from "@/core/utils/private-mode";
import { storageSafeSegment } from "@/core/utils/storage-id";
import {
  type ApprovalToolPair,
  defineApprovalTool,
  defineTool,
  makeZodValidator,
} from "../base-tool";
import { egressPolicyForContext, type EgressPolicy } from "../guarded-fetch";
import { createSystemBrowserLookup, resolveBrowserExecutablePath } from "../web-app";
import { BrowserSession, type BrowserSessions, type PageAction, type PageState } from "./session";
import { snapshotWindow } from "./snapshot";

export const BROWSER_NAVIGATE_TOOL_NAME = "browser_navigate";
export const BROWSER_ACT_TOOL_NAME = "browser_act";

/** Most characters one `type` action enters. */
const MAX_TYPED_TEXT_CHARACTERS = 4_000;

/** Hosts where a typed secret may travel over plain http: the machine's own. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

const SCREENSHOT_EXTENSION = "png";

const SNAPSHOT_HINT = "Take a browser_snapshot to read the page.";

function failure(error: string): ToolExecutionResult {
  return { success: false, result: null, error };
}

function describePage(state: PageState): string {
  return `url: ${state.url}\ntitle: ${state.title}`;
}

function pageResult(state: PageState, source: string, extra?: string): ToolExecutionResult {
  return {
    success: true,
    result: `${describePage(state)}${extra === undefined ? "" : `\n${extra}`}`,
    untrusted: { kind: "external", source: `${source} ${state.url}` },
  };
}

function browserSessionsFor(context: ToolExecutionContext): BrowserSessions | undefined {
  return context.browserSessions;
}

/**
 * The egress policy for one browser call: the private hosts approved for it, plus
 * `network.httpApproval` when the operator set a URL list.
 */
function browserEgressPolicy(
  context: ToolExecutionContext,
): Effect.Effect<EgressPolicy, never, AgentConfigService> {
  return Effect.gen(function* () {
    const base = yield* egressPolicyForContext(context);
    const appConfig = yield* (yield* AgentConfigServiceTag).appConfig;
    const grants = context.httpApproval ?? appConfig.network?.httpApproval;
    return grants === undefined || grants === "allow" ? base : { ...base, httpApproval: grants };
  });
}

/** Run `operation` on the run's browser, launching it on first use. */
function withBrowser<Value>(
  context: ToolExecutionContext,
  operation: (session: BrowserSession) => Promise<Value>,
): Effect.Effect<Value, Error, AgentConfigService> {
  return Effect.gen(function* () {
    const sessions = browserSessionsFor(context);
    if (sessions === undefined) {
      return yield* Effect.fail(new Error("The browser tools work only inside an agent run."));
    }
    const appConfig = yield* (yield* AgentConfigServiceTag).appConfig;
    const cdpEndpoint = appConfig.network?.browserEndpoint;
    const policy = yield* browserEgressPolicy(context);
    return yield* Effect.tryPromise({
      try: async () => {
        const session = await sessions.obtain(async () => {
          const executablePath =
            cdpEndpoint === undefined
              ? await resolveBrowserExecutablePath(createSystemBrowserLookup())
              : null;
          return BrowserSession.open({ executablePath, cdpEndpoint });
        });
        return session.exclusive(policy, () => operation(session));
      },
      catch: toError,
    });
  });
}

function toFailure(error: Error): Effect.Effect<ToolExecutionResult> {
  return Effect.succeed(failure(error.message));
}

const navigateParameters = z
  .object({
    url: z.string().min(1).describe("Absolute http(s) URL to open."),
  })
  .strict();

type NavigateArgs = z.infer<typeof navigateParameters>;

export function createBrowserNavigateTool(): Tool<AgentConfigService> {
  return defineTool<AgentConfigService, NavigateArgs>({
    name: BROWSER_NAVIGATE_TOOL_NAME,
    disclosure: "private",
    summary:
      "Open a web page in a real browser: browse sites, log in, fill forms, use pages that need JavaScript.",
    description:
      "Open an http(s) URL in the run's browser and return the page's URL and title. " +
      `${SNAPSHOT_HINT} The browser starts on the first call and keeps its pages and cookies until the run ends.`,
    tags: ["browser", "web", "navigate"],
    parameters: navigateParameters,
    validate: makeZodValidator(navigateParameters),
    riskLevel: "low-risk",
    egress: true,
    hidden: false,
    handler: (args, context) =>
      withBrowser(context, (session) => session.navigate(args.url)).pipe(
        Effect.map((state) => pageResult(state, BROWSER_NAVIGATE_TOOL_NAME)),
        Effect.catchAll(toFailure),
      ),
    createSummary: (result) => (result.success ? "Opened a page in the browser" : undefined),
  });
}

const backParameters = z.object({}).strict();

export function createBrowserBackTool(): Tool<AgentConfigService> {
  return defineTool<AgentConfigService, Record<string, never>>({
    name: "browser_back",
    disclosure: "private",
    summary: "Go back to the previous page in the browser.",
    description: `Go back one page in the browser's history. ${SNAPSHOT_HINT}`,
    tags: ["browser", "navigate"],
    parameters: backParameters,
    validate: makeZodValidator(backParameters),
    riskLevel: "low-risk",
    hidden: false,
    handler: (_args, context) =>
      withBrowser(context, (session) => session.back()).pipe(
        Effect.map((state) => pageResult(state, "browser_back")),
        Effect.catchAll(toFailure),
      ),
  });
}

const snapshotParameters = z
  .object({
    startLine: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Line to continue from, when the previous snapshot ended with a continuation note.",
      ),
  })
  .strict();

type SnapshotArgs = z.infer<typeof snapshotParameters>;

export function createBrowserSnapshotTool(): Tool<AgentConfigService> {
  return defineTool<AgentConfigService, SnapshotArgs>({
    name: "browser_snapshot",
    disclosure: "private",
    summary: "Read the current web page as a text outline with refs for links, buttons and fields.",
    description:
      "Read the current page as a text outline of its headings, text and controls. Each link, " +
      "button, field and other interactive element ends with a ref such as [ref=e3] that " +
      "browser_act takes. A long page continues across calls: pass the startLine its last line " +
      "names. Take a new snapshot after the page changes.",
    tags: ["browser", "read"],
    parameters: snapshotParameters,
    validate: makeZodValidator(snapshotParameters),
    riskLevel: "read-only",
    hidden: false,
    handler: (args, context) =>
      withBrowser(context, (session) => session.snapshot()).pipe(
        Effect.map((page) => {
          const header = describePage(page);
          const refCount = page.snapshot.refs.size;
          const shown = snapshotWindow(page.snapshot, args.startLine);
          return {
            success: true,
            result: `${header}\nrefs: ${String(refCount)}\n\n${shown.text}`,
            untrusted: { kind: "external", source: `browser_snapshot ${page.url}` },
          } satisfies ToolExecutionResult;
        }),
        Effect.catchAll(toFailure),
      ),
    createSummary: (result) => (result.success ? "Read the browser page" : undefined),
  });
}

const screenshotParameters = z
  .object({
    fullPage: z
      .boolean()
      .optional()
      .describe("true captures the whole scrollable page; omit it for the visible viewport."),
  })
  .strict();

type ScreenshotArgs = z.infer<typeof screenshotParameters>;

export function createBrowserScreenshotTool(): Tool<AgentConfigService> {
  return defineTool<AgentConfigService, ScreenshotArgs>({
    name: "browser_screenshot",
    disclosure: "private",
    summary: "Save a screenshot of the current web page as an image file.",
    description:
      "Save a PNG of the current page and return its path. Pass the path to analyze_media to " +
      "read what it shows.",
    tags: ["browser", "screenshot", "image"],
    parameters: screenshotParameters,
    validate: makeZodValidator(screenshotParameters),
    riskLevel: "low-risk",
    hidden: false,
    handler: (args, context) =>
      Effect.gen(function* () {
        const directory = `${getUserDataDirectory()}/browser/${storageSafeSegment(
          context.conversationId ?? context.agentId,
        )}`;
        yield* Effect.tryPromise({
          try: () => mkdir(directory, { recursive: true, mode: stateDirectoryMode() }),
          catch: toError,
        });
        const imagePath = `${directory}/${shortuuid.generate()}.${SCREENSHOT_EXTENSION}`;
        const state = yield* withBrowser(context, (session) =>
          session.screenshot(imagePath, args.fullPage === true),
        );
        const artifact: GeneratedArtifact = {
          kind: "image",
          path: imagePath,
          mediaType: "image/png",
          title: state.title === "" ? "Browser screenshot" : state.title,
          tool: "browser_screenshot",
          source: "rendered",
        };
        return {
          success: true,
          result: `${describePage(state)}\nimage: ${imagePath}`,
          artifacts: [artifact],
          untrusted: { kind: "external", source: `browser_screenshot ${state.url}` },
        } satisfies ToolExecutionResult;
      }).pipe(Effect.catchAll(toFailure)),
    createSummary: (result) => (result.success ? "Saved a browser screenshot" : undefined),
  });
}

const closeParameters = z.object({}).strict();

export function createBrowserCloseTool(): Tool<AgentConfigService> {
  return defineTool<AgentConfigService, Record<string, never>>({
    name: "browser_close",
    disclosure: "private",
    summary: "Close the browser and discard its cookies and logins.",
    description:
      "Close the browser and discard its cookies and session. The next browser tool call opens a fresh one.",
    tags: ["browser"],
    parameters: closeParameters,
    validate: makeZodValidator(closeParameters),
    riskLevel: "read-only",
    hidden: false,
    handler: (_args, context) =>
      Effect.tryPromise({
        try: async () => {
          await browserSessionsFor(context)?.release();
          return { success: true, result: "The browser is closed." } satisfies ToolExecutionResult;
        },
        catch: toError,
      }).pipe(Effect.catchAll(toFailure)),
  });
}

const actParameters = z
  .object({
    action: z.enum(["click", "type", "select", "press"]).describe("click, type, select or press."),
    ref: z
      .string()
      .min(1)
      .optional()
      .describe("Ref from the latest browser_snapshot, such as e3 (click, type, select)."),
    text: z
      .string()
      .max(MAX_TYPED_TEXT_CHARACTERS)
      .optional()
      .describe(
        "Text to enter, replacing the field's contents (type). Pass a secret from ask_user_secret as its placeholder.",
      ),
    submit: z.boolean().optional().describe("true presses Enter after typing (type)."),
    value: z
      .string()
      .min(1)
      .optional()
      .describe("Option value or visible label to choose (select)."),
    key: z
      .string()
      .min(1)
      .optional()
      .describe("Key to press, such as Enter, Tab, Escape or PageDown (press)."),
  })
  .strict()
  .superRefine((args, refinement) => {
    const missing = (field: string): void => {
      refinement.addIssue({
        code: "custom",
        message: `${args.action} needs ${field}`,
        path: [field],
      });
    };
    if (args.action !== "press" && args.ref === undefined) {
      missing("ref");
    }
    if (args.action === "type" && args.text === undefined) {
      missing("text");
    }
    if (args.action === "select" && args.value === undefined) {
      missing("value");
    }
    if (args.action === "press" && args.key === undefined) {
      missing("key");
    }
  });

type ActArgs = z.infer<typeof actParameters>;

function toPageAction(args: ActArgs): PageAction {
  switch (args.action) {
    case "click":
      return { kind: "click", ref: args.ref ?? "" };
    case "type":
      return {
        kind: "type",
        ref: args.ref ?? "",
        text: args.text ?? "",
        submit: args.submit === true,
      };
    case "select":
      return { kind: "select", ref: args.ref ?? "", value: args.value ?? "" };
    case "press":
      return { kind: "press", key: args.key ?? "" };
  }
}

function describeAction(args: ActArgs, target: string | undefined): string {
  switch (args.action) {
    case "click":
      return `Click ${target ?? args.ref ?? ""}`;
    case "type":
      return `Type ${JSON.stringify(args.text ?? "")} into ${target ?? args.ref ?? ""}${args.submit === true ? " and press Enter" : ""}`;
    case "select":
      return `Choose ${JSON.stringify(args.value ?? "")} in ${target ?? args.ref ?? ""}`;
    case "press":
      return `Press ${args.key ?? ""}`;
  }
}

function isSecureOrigin(pageUrl: string): boolean {
  try {
    const url = new URL(pageUrl);
    return url.protocol === "https:" || LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function createBrowserActTools(): ApprovalToolPair<AgentConfigService> {
  return defineApprovalTool<AgentConfigService, ActArgs>({
    name: BROWSER_ACT_TOOL_NAME,
    disclosure: "private",
    summary: "Click, type into, select from or press keys on a web page in the browser.",
    description:
      "Act on the current page: click an element, type into a field, choose an option from a " +
      "list, or press a key. Elements come from the latest browser_snapshot by ref. The action " +
      "runs after approval and returns the new URL and title. To sign in, collect the password " +
      "with ask_user_secret and pass its placeholder as text.",
    tags: ["browser", "click", "type", "form"],
    parameters: actParameters,
    validate: makeZodValidator(actParameters),
    riskLevel: "high-risk",
    egress: true,
    userSecretArguments: ["text"],
    approvalMessage: (args, context) =>
      Effect.gen(function* () {
        const pending = browserSessionsFor(context)?.peek();
        if (pending === undefined) {
          return {
            skipApproval: true,
            toolResult: failure("No page is open. Use browser_navigate first."),
          } as const;
        }
        const session = yield* Effect.tryPromise({ try: () => pending, catch: toError });
        const target = args.ref === undefined ? undefined : session.describeRef(args.ref);
        if (args.ref !== undefined && target === undefined) {
          return {
            skipApproval: true,
            toolResult: failure(
              `No element has ref ${args.ref}. Take a browser_snapshot and use a ref from it.`,
            ),
          } as const;
        }
        const state = yield* Effect.tryPromise({ try: () => session.state(), catch: toError });
        const message = `${describeAction(args, target)}\non ${state.url}`;

        const typedSecrets =
          context.userSecrets === undefined || args.text === undefined
            ? []
            : userSecretNamesIn(args.text, context.userSecrets);
        if (typedSecrets.length === 0) {
          return message;
        }
        if (!isSecureOrigin(state.url)) {
          return {
            skipApproval: true,
            toolResult: failure(
              `${state.url} is not served over https, so a secret you typed is not entered there.`,
            ),
          } as const;
        }
        const placeholders = typedSecrets.map(redactionPlaceholder).join(", ");
        return {
          message: `${message}\n\nApproving enters the secret you typed in place of ${placeholders} on this site. Approve only if you expect this site to receive it.`,
          alwaysAsk: true,
        } as const;
      }),
    approvalErrorMessage: "Browser actions need your approval.",
    handler: (args, context) =>
      withBrowser(context, (session) => session.act(toPageAction(args))).pipe(
        Effect.map((state) => pageResult(state, BROWSER_ACT_TOOL_NAME, SNAPSHOT_HINT)),
        Effect.catchAll(toFailure),
      ),
    createSummary: (result) => (result.success ? "Acted on the browser page" : undefined),
  });
}
