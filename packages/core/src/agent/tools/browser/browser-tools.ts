/**
 * The browser tools: drive a real page from text.
 *
 * The agent reads a page as an accessibility snapshot whose interactive elements carry refs,
 * and acts on those refs. Reading and navigating are ordinary tools; `browser_act`, which clicks,
 * types and presses keys, is an approval pair because a click can submit a form or buy
 * something, and it takes a list of steps so one approval covers one task. The agent works in
 * named tabs it opened itself. A tab the user already had open stays invisible until the person
 * adopts it through `browser_adopt_tab`.
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
import type { Tool, ToolRiskLevel } from "@/core/interfaces/tool-registry";
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
import { resolveChromiumBrowser } from "../chromium-default";
import { egressPolicyForContext, type EgressPolicy } from "../guarded-fetch";
import { createSystemBrowserLookup, resolveBrowserExecutablePath } from "../web-app";
import { advisePage, renderSnapshot } from "./page-hooks";
import { combineFlags, describeFlags } from "./page-signals";
import {
  BrowserSession,
  NO_TAB_MESSAGE,
  type BrowserSessions,
  type PageAction,
  type PageState,
  type TabSummary,
} from "./session";
import {
  MAX_ADOPTION_HINT_LENGTH,
  STALE_REF_MESSAGE,
  missingRefMessage,
  tabNameProblem,
} from "./tabs";

export const BROWSER_NAVIGATE_TOOL_NAME = "browser_navigate";
export const BROWSER_ACT_TOOL_NAME = "browser_act";
export const BROWSER_TABS_TOOL_NAME = "browser_tabs";
export const BROWSER_ADOPT_TAB_TOOL_NAME = "browser_adopt_tab";

/**
 * Most steps one `browser_act` call runs. A form or a short flow fits in a dozen steps; a longer
 * sequence is several tasks, each worth its own approval and its own look at the page.
 */
export const MAX_ACT_STEPS = 12;

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
  return `tab: ${state.tab}\nurl: ${state.url}\ntitle: ${state.title}`;
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
 * Resolve the browser to launch into a temporary profile. An explicit
 * `PUPPETEER_EXECUTABLE_PATH` wins outright; otherwise the system default web browser
 * (when Chromium-based), then Google Chrome. Returns `null` when nothing is drivable —
 * `describeMissingBrowser` explains what the user can do.
 */
async function resolveLaunchBrowser(
  lookup: ReturnType<typeof createSystemBrowserLookup>,
): Promise<string | null> {
  const explicit = await resolveBrowserExecutablePath(lookup);
  if (explicit !== null) {
    return explicit;
  }
  const candidate = await resolveChromiumBrowser((channel) => lookup.findSystemChrome(channel));
  return candidate?.executablePath ?? null;
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
    const configuredEndpoint = appConfig.network?.browserEndpoint;
    const policy = yield* browserEgressPolicy(context);
    return yield* Effect.tryPromise({
      try: async () => {
        const session = await sessions.obtain(async () => {
          // No endpoint set: a browser the person runs on the local DevTools port wins,
          // and a launched browser is the fallback when nothing is listening there.
          const executablePath =
            configuredEndpoint === undefined
              ? await resolveLaunchBrowser(createSystemBrowserLookup())
              : null;
          return BrowserSession.open({
            executablePath,
            cdpEndpoint: configuredEndpoint,
          });
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

const tabNameSchema = z.string().refine((name) => tabNameProblem(name) === undefined, {
  message: "A tab name is lowercase words joined by hyphens, such as checkout.",
});

const navigateParameters = z
  .object({
    url: z.string().min(1).describe("Absolute http(s) URL to open."),
    tab: tabNameSchema
      .optional()
      .describe(
        "Name of the tab to open the URL in, such as checkout. A name that is not open yet opens a new tab. Omit it to use the active tab.",
      ),
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
      "Open an http(s) URL in a tab of the run's browser and return the page's URL and title. " +
      "Name a tab to keep several pages open side by side, and switch between them with browser_tabs. " +
      `${SNAPSHOT_HINT} The browser starts on the first call and keeps its tabs and cookies until the run ends.`,
    tags: ["browser", "web", "navigate"],
    parameters: navigateParameters,
    validate: makeZodValidator(navigateParameters),
    riskLevel: "low-risk",
    egress: true,
    hidden: false,
    handler: (args, context) =>
      withBrowser(context, (session) => session.navigate(args.url, args.tab)).pipe(
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
      Effect.gen(function* () {
        const { page, signals, session } = yield* withBrowser(context, async (browser) => ({
          page: await browser.snapshot(),
          signals: await browser.pageSignals(),
          session: browser,
        }));
        const advice = yield* advisePage(context, {
          page,
          signals,
          firstWindow: args.startLine === undefined || args.startLine === 1,
        });
        session.recordFlags(page.url, advice.flags);
        const header = describePage(page);
        const refCount = page.snapshot.refs.size;
        return {
          success: true,
          result: `${header}\nrefs: ${String(refCount)}\n\n${renderSnapshot(page.snapshot, advice, args.startLine)}`,
          untrusted: { kind: "external", source: `browser_snapshot ${page.url}` },
        } satisfies ToolExecutionResult;
      }).pipe(Effect.catchAll(toFailure)),
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

const tabsParameters = z
  .object({
    action: z
      .enum(["list", "switch", "close"])
      .describe("list the open tabs, switch to one by name, or close one by name."),
    name: tabNameSchema.optional().describe("Tab name (switch, close)."),
  })
  .strict()
  .superRefine((args, refinement) => {
    if (args.action !== "list" && args.name === undefined) {
      refinement.addIssue({
        code: "custom",
        message: `${args.action} needs name`,
        path: ["name"],
      });
    }
  });

type TabsArgs = z.infer<typeof tabsParameters>;

function describeTabs(tabs: readonly TabSummary[]): string {
  if (tabs.length === 0) {
    return NO_TAB_MESSAGE;
  }
  const lines = tabs.map((tab) => {
    const marker = tab.active ? "*" : " ";
    const adopted = tab.origin === "adopted" ? " (adopted)" : "";
    return `${marker} ${tab.tab}${adopted}  ${tab.url}  ${JSON.stringify(tab.title)}`;
  });
  return `Open tabs (* is active):\n${lines.join("\n")}`;
}

export function createBrowserTabsTool(): Tool<AgentConfigService> {
  return defineTool<AgentConfigService, TabsArgs>({
    name: BROWSER_TABS_TOOL_NAME,
    disclosure: "private",
    summary: "List, switch between, and close the named tabs of the browser.",
    description:
      "Manage the run's browser tabs. list shows each tab's name, address and title; switch makes " +
      "a named tab the one browser_snapshot and browser_act use; close closes a tab. Open a tab by " +
      "giving browser_navigate a new tab name.",
    tags: ["browser", "tabs"],
    parameters: tabsParameters,
    validate: makeZodValidator(tabsParameters),
    riskLevel: "low-risk",
    resolveRiskLevel: (args) => (args["action"] === "list" ? "read-only" : "low-risk"),
    hidden: false,
    handler: (args, context) =>
      withBrowser(context, async (session) => {
        if (args.action === "list") {
          return {
            success: true,
            result: describeTabs(await session.listTabs()),
            untrusted: { kind: "external", source: BROWSER_TABS_TOOL_NAME },
          } satisfies ToolExecutionResult;
        }
        const name = args.name ?? "";
        if (args.action === "switch") {
          return pageResult(await session.switchTab(name), BROWSER_TABS_TOOL_NAME, SNAPSHOT_HINT);
        }
        const closed = await session.closeTab(name);
        const now =
          closed.active === undefined
            ? NO_TAB_MESSAGE
            : `Active tab: ${closed.active}. ${SNAPSHOT_HINT}`;
        return {
          success: true,
          result: `Closed tab ${closed.closed}. ${now}`,
        } satisfies ToolExecutionResult;
      }).pipe(Effect.catchAll(toFailure)),
    createSummary: (result) => (result.success ? "Used the browser tabs" : undefined),
  });
}

const STEP_ACTIONS = ["click", "type", "select", "press"] as const;

type StepAction = (typeof STEP_ACTIONS)[number];

const RISK_RANK = { "read-only": 0, "low-risk": 1, "high-risk": 2 } as const;

type RankedRisk = keyof typeof RISK_RANK;

/**
 * The risk of each kind of step. A click can submit a form or buy something and a keystroke can
 * confirm a dialog, so every step that changes the page is `high-risk`.
 */
export const STEP_RISK: Readonly<Record<StepAction, RankedRisk>> = {
  click: "high-risk",
  type: "high-risk",
  select: "high-risk",
  press: "high-risk",
};

/** The riskiest of `levels`: one approval covers a whole batch, so the worst step sets its level. */
export function highestRisk(levels: readonly RankedRisk[]): RankedRisk {
  return levels.reduce<RankedRisk>(
    (highest, level) => (RISK_RANK[level] > RISK_RANK[highest] ? level : highest),
    "read-only",
  );
}

/** The level `browser_act` is gated at: the highest of any step it can run. */
export const ACT_RISK_LEVEL: ToolRiskLevel = highestRisk(Object.values(STEP_RISK));

const stepSchema = z
  .object({
    action: z.enum(STEP_ACTIONS).describe("click, type, select or press."),
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
  .superRefine((step, refinement) => {
    const missing = (field: string): void => {
      refinement.addIssue({
        code: "custom",
        message: `${step.action} needs ${field}`,
        path: [field],
      });
    };
    if (step.action !== "press" && step.ref === undefined) {
      missing("ref");
    }
    if (step.action === "type" && step.text === undefined) {
      missing("text");
    }
    if (step.action === "select" && step.value === undefined) {
      missing("value");
    }
    if (step.action === "press" && step.key === undefined) {
      missing("key");
    }
  });

type ActStep = z.infer<typeof stepSchema>;

const actParameters = z
  .object({
    actions: z
      .array(stepSchema)
      .min(1)
      .max(MAX_ACT_STEPS)
      .describe(
        `The steps of one task, in order, up to ${String(MAX_ACT_STEPS)}. Each is a click, type, select or press.`,
      ),
  })
  .strict();

type ActArgs = z.infer<typeof actParameters>;

function toPageAction(step: ActStep): PageAction {
  switch (step.action) {
    case "click":
      return { kind: "click", ref: step.ref ?? "" };
    case "type":
      return {
        kind: "type",
        ref: step.ref ?? "",
        text: step.text ?? "",
        submit: step.submit === true,
      };
    case "select":
      return { kind: "select", ref: step.ref ?? "", value: step.value ?? "" };
    case "press":
      return { kind: "press", key: step.key ?? "" };
  }
}

function describeStep(step: ActStep, target: string | undefined): string {
  switch (step.action) {
    case "click":
      return `Click ${target ?? step.ref ?? ""}`;
    case "type":
      return `Type ${JSON.stringify(step.text ?? "")} into ${target ?? step.ref ?? ""}${step.submit === true ? " and press Enter" : ""}`;
    case "select":
      return `Choose ${JSON.stringify(step.value ?? "")} in ${target ?? step.ref ?? ""}`;
    case "press":
      return `Press ${step.key ?? ""}`;
  }
}

/** A step named by its action and ref alone, so a failure never repeats text the page wrote. */
function briefStep(step: ActStep): string {
  return step.action === "press" ? `press ${step.key ?? ""}` : `${step.action} ${step.ref ?? ""}`;
}

function isSecureOrigin(pageUrl: string): boolean {
  try {
    const url = new URL(pageUrl);
    return url.protocol === "https:" || LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/** Whether the text of `step`, after the registry substituted secrets, holds a typed secret. */
function stepEntersSecret(step: ActStep, context: ToolExecutionContext): boolean {
  const text = step.text;
  if (text === undefined || context.userSecrets === undefined) {
    return false;
  }
  return context.userSecrets.knownSecrets().some((secret) => text.includes(secret.value));
}

interface StepsOutcome {
  readonly completed: number;
  readonly failure?: { readonly index: number; readonly message: string };
  readonly state?: PageState;
  readonly blocked: string;
}

/**
 * Run `steps` in order on the active tab and stop at the first failure. A step that types a
 * secret first checks the tab still shows an https page, because an earlier step may have
 * moved it.
 */
async function runSteps(
  session: BrowserSession,
  steps: readonly ActStep[],
  context: ToolExecutionContext,
): Promise<StepsOutcome> {
  let failure: StepsOutcome["failure"];
  let completed = 0;
  for (const [index, step] of steps.entries()) {
    try {
      if (stepEntersSecret(step, context)) {
        const current = await session.state();
        if (!isSecureOrigin(current.url)) {
          throw new Error(
            `${current.url} is not served over https, so a secret you typed is not entered there.`,
          );
        }
      }
      await session.act(toPageAction(step));
      completed += 1;
    } catch (error) {
      failure = { index, message: toError(error).message };
      break;
    }
  }
  const state = await session.state().catch(() => undefined);
  return {
    completed,
    ...(failure === undefined ? {} : { failure }),
    ...(state === undefined ? {} : { state }),
    blocked: session.blockedSummary(),
  };
}

function stepsResult(steps: readonly ActStep[], outcome: StepsOutcome): ToolExecutionResult {
  const total = steps.length;
  const progress = `Completed ${String(outcome.completed)} of ${String(total)} step${total === 1 ? "" : "s"}.`;
  const source = BROWSER_ACT_TOOL_NAME;
  if (outcome.failure === undefined) {
    return outcome.state === undefined
      ? { success: true, result: progress }
      : pageResult(outcome.state, source, `${progress}\n${SNAPSHOT_HINT}`);
  }
  const failed = steps[outcome.failure.index];
  const named = failed === undefined ? "" : ` (${briefStep(failed)})`;
  const error = `Step ${String(outcome.failure.index + 1)} of ${String(total)} failed${named}: ${outcome.failure.message}${outcome.blocked}`;
  return {
    success: false,
    result: outcome.state === undefined ? progress : `${describePage(outcome.state)}\n${progress}`,
    error,
    ...(outcome.state === undefined
      ? {}
      : { untrusted: { kind: "external", source: `${source} ${outcome.state.url}` } }),
  };
}

export function createBrowserActTools(): ApprovalToolPair<AgentConfigService> {
  return defineApprovalTool<AgentConfigService, ActArgs>({
    name: BROWSER_ACT_TOOL_NAME,
    disclosure: "private",
    summary: "Click, type into, select from or press keys on a web page in the browser.",
    description:
      "Act on the active tab's page. Put the steps of one task in actions, in order: each step " +
      "clicks an element, types into a field, chooses an option from a list, or presses a key. " +
      "Elements come from the latest browser_snapshot by ref. The steps run after one approval " +
      "and stop at the first failure, and the result names how many completed. When a step " +
      "changes the page address, take a new browser_snapshot before using refs again. To sign " +
      "in, collect the password with ask_user_secret and pass its placeholder as text.",
    tags: ["browser", "click", "type", "form"],
    parameters: actParameters,
    validate: makeZodValidator(actParameters),
    riskLevel: ACT_RISK_LEVEL,
    egress: true,
    userSecretArguments: ["actions[].text"],
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
        if (!session.hasTab()) {
          return { skipApproval: true, toolResult: failure(NO_TAB_MESSAGE) } as const;
        }
        const lines: string[] = [];
        for (const step of args.actions) {
          const lookup = step.ref === undefined ? undefined : session.resolveRef(step.ref);
          if (lookup?.kind === "stale") {
            return { skipApproval: true, toolResult: failure(STALE_REF_MESSAGE) } as const;
          }
          if (lookup?.kind === "missing") {
            return {
              skipApproval: true,
              toolResult: failure(missingRefMessage(step.ref ?? "")),
            } as const;
          }
          lines.push(describeStep(step, lookup?.label));
        }
        const state = yield* Effect.tryPromise({ try: () => session.state(), catch: toError });
        const signals = yield* Effect.tryPromise({
          try: () => session.pageSignals(),
          catch: toError,
        });
        const flags = combineFlags(signals, session.flagsFor(state.url));
        const notice = describeFlags(flags);
        const base =
          lines.length === 1
            ? `${lines[0] ?? ""}\non ${state.url}`
            : `Run ${String(lines.length)} steps on ${state.url}, stopping at the first that fails:\n${lines
                .map((line, index) => `${String(index + 1)}. ${line}`)
                .join("\n")}`;
        const message = `${base}${notice === undefined ? "" : `\n\n${notice}`}`;

        const typedSecrets =
          context.userSecrets === undefined
            ? []
            : userSecretNamesIn(
                args.actions.map((step) => step.text),
                context.userSecrets,
              );
        if (typedSecrets.length === 0) {
          return flags.length === 0 ? message : ({ message, alwaysAsk: true } as const);
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
      withBrowser(context, (session) => runSteps(session, args.actions, context)).pipe(
        Effect.map((outcome) => stepsResult(args.actions, outcome)),
        Effect.catchAll(toFailure),
      ),
    createSummary: (result) => (result.success ? "Acted on the browser page" : undefined),
  });
}

const adoptParameters = z
  .object({
    match: z
      .string()
      .min(1)
      .max(MAX_ADOPTION_HINT_LENGTH)
      .describe("A word or phrase from the title or address of the tab to share."),
    name: tabNameSchema.describe("The name to give the tab in this run, such as checkout."),
  })
  .strict();

type AdoptArgs = z.infer<typeof adoptParameters>;

function adoptionMessage(
  args: AdoptArgs,
  offers: readonly { readonly title: string; readonly url: string }[],
): string {
  const only = offers.length === 1 ? offers[0] : undefined;
  if (only !== undefined) {
    return (
      `Share your open tab "${only.title}"\n${only.url}\nwith the agent as "${args.name}"?\n\n` +
      "The agent can read this tab's page, which may be signed in as you, and acts on it only " +
      "with your approval of each action. The tab stays open in your browser when the run ends."
    );
  }
  if (offers.length === 0) {
    return `The agent asked to share one of your open tabs matching "${args.match}", but none of them match. Approving shares nothing.`;
  }
  const listed = offers.map((offer) => `- ${offer.title} (${offer.url})`).join("\n");
  return `${String(offers.length)} of your open tabs match "${args.match}", so approving shares nothing. Deny, and ask the agent for a more specific word.\n${listed}`;
}

export function createBrowserAdoptTabTools(): ApprovalToolPair<AgentConfigService> {
  return defineApprovalTool<AgentConfigService, AdoptArgs>({
    name: BROWSER_ADOPT_TAB_TOOL_NAME,
    disclosure: "private",
    summary: "Ask the person to share one tab they already have open in their own browser.",
    description:
      "Ask the person to share one tab that is already open in their own browser, named by a " +
      "word from its title or address, and work in it under a name you choose. Only tabs you " +
      "opened are available until the person approves the exact tab. Once shared, switch to it " +
      "with browser_tabs and read it with browser_snapshot.",
    tags: ["browser", "tabs", "share"],
    parameters: adoptParameters,
    validate: makeZodValidator(adoptParameters),
    riskLevel: "high-risk",
    approvalMessage: (args, context) =>
      withBrowser(context, async (session) => {
        if (!session.canAdopt) {
          return {
            skipApproval: true,
            toolResult: failure(
              "Sharing a tab needs a browser you run: start one with `--remote-debugging-port=9222` or set network.browserEndpoint.",
            ),
          } as const;
        }
        const offers = await session.offerAdoption(args.match, args.name);
        return { message: adoptionMessage(args, offers), alwaysAsk: true } as const;
      }),
    approvalErrorMessage: "Sharing a tab needs your approval.",
    handler: (args, context) =>
      withBrowser(context, (session) => session.adopt(args.match, args.name)).pipe(
        Effect.map((state) => pageResult(state, BROWSER_ADOPT_TAB_TOOL_NAME, SNAPSHOT_HINT)),
        Effect.catchAll(toFailure),
      ),
    createSummary: (result) => (result.success ? "Shared a browser tab" : undefined),
  });
}
