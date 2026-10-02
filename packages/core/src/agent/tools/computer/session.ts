/**
 * One run's hold on the desktop.
 *
 * A session owns the driver process, the machine-wide lock, and the observations whose refs the
 * model may act through. Every action passes the same checks, in this order, and stops at the
 * first that fails: a stop was not requested, the run has not been idle too long, the app is
 * still granted, the app's class still permits this kind of action, the window still belongs to
 * that app, and the action itself is not one computer use never takes.
 *
 * Grants are read again for every action, so a revoke or an expiry takes effect on the next one.
 */

import { mkdir, rm } from "node:fs/promises";
import * as path from "node:path";
import shortuuid from "short-uuid";
import type { KnownSecret } from "@/core/secrets/redaction";
import { stateDirectoryMode } from "@/core/utils/private-mode";
import { RunScopedResource } from "../run-scoped-resource";
import {
  type ActionKind,
  type AppTier,
  blockedKeyReason,
  blockedTextReason,
  classifyApp,
  describeRefusal,
  tierAllows,
} from "./app-policy";
import { clearSessionInfo, clearStopRequest, stopRequestedSince } from "./control";
import {
  CAPABILITY_UNSUPPORTED_CODE,
  type ActionEffect,
  type ComputerDriver,
  type DeliveryMode,
  type DriverApp,
  type DriverWindowState,
  type DriverWindow,
  type MouseButton,
  type ScrollDirection,
  type WindowTarget,
  STALE_ELEMENT_CODE,
  DriverError,
} from "./driver";
import {
  activeGrants,
  type ComputerGrant,
  type ComputerState,
  readComputerState,
  shortestIdleTimeoutMs,
} from "./grants";
import { appendLedgerEntry, ledgerLabel, type LedgerEntry, type LedgerOutcome } from "./ledger";
import {
  buildObservation,
  frameCenter,
  MAX_OBSERVED_DEPTH,
  MAX_OBSERVED_ELEMENTS,
  type ObservedElement,
  type Observation,
  parseRef,
} from "./observation";

/** Screenshots kept for the run; older ones are deleted as new ones arrive. */
const MAX_RETAINED_CAPTURES = 5;

/** Most lines one scroll moves. */
export const MAX_SCROLL_AMOUNT = 20;
const MAX_HOLD_MS = 30_000;
const MAX_KEY_REPEAT = 100;

const OBSERVATION_ID_PATTERN = /^c(\d+)$/;

const MODIFIER_NAMES: ReadonlySet<string> = new Set([
  "cmd",
  "command",
  "meta",
  "super",
  "ctrl",
  "control",
  "alt",
  "option",
  "opt",
]);

export class ComputerStoppedError extends Error {
  constructor(options?: ErrorOptions) {
    super("You stopped computer use. It stays stopped for the rest of this run.", options);
    this.name = "ComputerStoppedError";
  }
}

export interface GrantedApp {
  readonly bundleId: string;
  readonly name: string;
  readonly tier: string;
  readonly expiresAt: number;
  readonly foreground: boolean;
  readonly running: boolean;
  readonly windows: readonly DriverWindow[];
}

export interface ObserveInput {
  readonly app?: string | undefined;
  readonly windowId?: number | undefined;
  readonly screenshot: boolean;
  readonly query?: string | undefined;
}

export type ActionInput =
  | {
      readonly kind: "click";
      readonly ref: string;
      readonly button?: MouseButton;
      readonly delivery: DeliveryMode;
      /** Act on this specific top-level window of the app (see the multi-window error text). */
      readonly windowId?: number;
    }
  | {
      readonly kind: "click_point";
      readonly observation: string;
      readonly x: number;
      readonly y: number;
      readonly button?: MouseButton;
      readonly delivery: DeliveryMode;
      /** Act on this specific top-level window of the app (see the multi-window error text). */
      readonly windowId?: number;
    }
  | {
      readonly kind: "double_click";
      readonly ref: string;
      readonly delivery: DeliveryMode;
      /** Act on this specific top-level window of the app (see the multi-window error text). */
      readonly windowId?: number;
    }
  | {
      readonly kind: "triple_click";
      readonly ref: string;
      readonly delivery: DeliveryMode;
      /** Act on this specific top-level window of the app (see the multi-window error text). */
      readonly windowId?: number;
    }
  | {
      readonly kind: "drag";
      readonly fromRef: string;
      readonly toRef: string;
      readonly delivery: DeliveryMode;
      /** Act on this specific top-level window of the app (see the multi-window error text). */
      readonly windowId?: number;
    }
  | {
      readonly kind: "drag_points";
      readonly observation: string;
      readonly fromX: number;
      readonly fromY: number;
      readonly toX: number;
      readonly toY: number;
      readonly delivery: DeliveryMode;
      /** Act on this specific top-level window of the app (see the multi-window error text). */
      readonly windowId?: number;
    }
  | {
      readonly kind: "hover";
      readonly ref: string;
      readonly delivery: DeliveryMode;
      /** Act on this specific top-level window of the app (see the multi-window error text). */
      readonly windowId?: number;
    }
  | {
      readonly kind: "hover_point";
      readonly observation: string;
      readonly x: number;
      readonly y: number;
      readonly delivery: DeliveryMode;
      /** Act on this specific top-level window of the app (see the multi-window error text). */
      readonly windowId?: number;
    }
  | {
      readonly kind: "scroll";
      readonly ref: string;
      readonly direction: ScrollDirection;
      readonly amount: number;
      readonly delivery: DeliveryMode;
      /** Act on this specific top-level window of the app (see the multi-window error text). */
      readonly windowId?: number;
    }
  | {
      readonly kind: "type";
      readonly ref: string;
      readonly text: string;
      readonly delivery: DeliveryMode;
      /** Act on this specific top-level window of the app (see the multi-window error text). */
      readonly windowId?: number;
      readonly secretPlaceholderGiven: boolean;
    }
  | {
      readonly kind: "set_value";
      readonly ref: string;
      readonly text: string;
      readonly delivery: DeliveryMode;
      /** Act on this specific top-level window of the app (see the multi-window error text). */
      readonly windowId?: number;
      readonly secretPlaceholderGiven: boolean;
    }
  | {
      readonly kind: "key";
      readonly observation: string;
      readonly key: string;
      readonly modifiers: readonly string[];
      readonly repeat?: number;
      readonly delivery: DeliveryMode;
      /** Act on this specific top-level window of the app (see the multi-window error text). */
      readonly windowId?: number;
    }
  | {
      readonly kind: "hold_key";
      readonly observation: string;
      readonly key: string;
      readonly modifiers: readonly string[];
      readonly durationMs: number;
      readonly delivery: DeliveryMode;
      /** Act on this specific top-level window of the app (see the multi-window error text). */
      readonly windowId?: number;
    };

export interface ActionReport {
  readonly app: string;
  readonly effect: ActionEffect;
  readonly summary: string | null;
  readonly hint: string | null;
  /** A fresh look at the action's window, when the caller asked for it (captureAfter). */
  readonly observation?: Observation | undefined;
}

export interface WaitOptions {
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly until: "settled" | "changed";
}

export interface WaitReport {
  readonly outcome: "settled" | "changed" | "timeout";
  readonly observation: Observation;
}

/** The window this session last looked at or acted on, the one computer_wait watches. */
interface LastTarget {
  readonly target: WindowTarget;
  readonly bundleId: string;
  readonly appName: string;
  readonly appClass: AppTier;
}

export interface ComputerSessionSettings {
  readonly driver: ComputerDriver;
  readonly releaseLock: () => Promise<void>;
  readonly agentId: string;
  readonly conversationId: string | undefined;
  readonly capturesDirectory: string;
  readonly announce: (message: string) => void;
  readonly ancestorPids: ReadonlySet<number>;
  readonly now?: () => number;
  readonly readState?: () => Promise<ComputerState>;
}

function kindOf(action: ActionInput): ActionKind {
  switch (action.kind) {
    case "click":
    case "click_point":
    case "double_click":
    case "triple_click":
    case "drag":
    case "drag_points":
    case "hover":
    case "hover_point":
      return "click";
    case "scroll":
      return "scroll";
    case "type":
    case "set_value":
      return "type";
    case "key":
    case "hold_key":
      return "key";
  }
}

function isModifierName(name: string): boolean {
  return MODIFIER_NAMES.has(name.trim().toLowerCase());
}

/** Whether a key press would type a character, which only the typing tool may do. */
function typesCharacter(key: string, modifiers: readonly string[]): boolean {
  return key.length === 1 && !modifiers.some(isModifierName);
}

/**
 * An action reaches an app this run has neither a grant for nor a first-reach approval. The tools
 * turn it into a consent ask; performing the action without that ask being answered is a
 * programming error, not something the person or the model should read.
 */
export class FirstReachConsentRequired extends Error {
  constructor(
    readonly appName: string,
    readonly bundleId: string,
  ) {
    super(
      `This run has not been given access to ${appName} yet. Ask the person for the first-reach ` +
        "consent before acting in this app.",
    );
  }
}

export class ComputerSession {
  readonly startedAt: number;
  private generation = 0;
  private readonly latestByWindow = new Map<string, Observation>();
  private readonly byGeneration = new Map<number, Observation>();
  private readonly retired = new Map<number, string>();
  private readonly captures: string[] = [];
  private lastActionAt: number;
  private lapsedReason: string | undefined;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  /** Apps approved by the person the first time this run reached them, bundleId to name. */
  private readonly approvedThisRun = new Map<string, string>();
  private supportedKinds: readonly string[] | undefined;
  private lastTarget: LastTarget | undefined;

  constructor(private readonly settings: ComputerSessionSettings) {
    this.startedAt = this.now();
    this.lastActionAt = this.startedAt;
  }

  /** Whether this run may reach the app: an active grant, or a first-reach approval in this run. */
  isConsented(bundleId: string, grants: readonly ComputerGrant[]): boolean {
    return (
      grants.some((grant) => grant.bundleId === bundleId) || this.approvedThisRun.has(bundleId)
    );
  }

  /** Record a first-reach approval; it lasts until the run ends and is never written to disk. */
  approveForRun(bundleId: string, appName: string): void {
    this.approvedThisRun.set(bundleId, appName);
  }
  private now(): number {
    return (this.settings.now ?? Date.now)();
  }

  private state(): Promise<ComputerState> {
    return (this.settings.readState ?? readComputerState)();
  }

  /** Run `operation` after every earlier one on this session has finished. */
  exclusive<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async assertActive(): Promise<readonly ComputerGrant[]> {
    if (this.lapsedReason !== undefined) {
      throw new Error(this.lapsedReason);
    }
    if (await stopRequestedSince(this.startedAt)) {
      throw new ComputerStoppedError();
    }
    const state = await this.state();
    const grants = activeGrants(state, this.now());
    // No grants is not an error: the agent asks for each app on its first reach. The idle
    // limit is enforced only while granted apps bound it.
    if (grants.length > 0) {
      const idleLimit = shortestIdleTimeoutMs(grants);
      if (idleLimit !== undefined && this.now() - this.lastActionAt > idleLimit) {
        this.lapsedReason = `Computer use ended after ${String(Math.round(idleLimit / 60_000))} minutes without an action. Ask the operator to start a new run.`;
        throw new Error(this.lapsedReason);
      }
    }
    return grants;
  }

  private async ledger(
    entry: Omit<LedgerEntry, "timestamp" | "agentId" | "conversationId">,
  ): Promise<void> {
    await appendLedgerEntry({
      timestamp: new Date(this.now()).toISOString(),
      agentId: this.settings.agentId,
      ...(this.settings.conversationId === undefined
        ? {}
        : { conversationId: this.settings.conversationId }),
      ...entry,
    }).catch(() => undefined);
  }

  /**
   * The apps this run may reach: the granted ones with their expiry, plus the running apps that
   * still need the first-reach consent, so a run with no grants can name what it may ask about.
   */
  async apps(): Promise<readonly GrantedApp[]> {
    const grants = await this.assertActive();
    const running = await this.settings.driver.listApps();
    const report: GrantedApp[] = [];
    for (const grant of grants) {
      const appClass = classifyApp(grant.bundleId);
      if (appClass === "refused") {
        continue;
      }
      const live = running.find((app) => app.running && app.bundleId === grant.bundleId);
      const windows =
        live === undefined || this.settings.ancestorPids.has(live.pid)
          ? []
          : (await this.settings.driver.listWindows(live.pid)).filter(
              (window) => window.onScreen && !window.minimized,
            );
      report.push({
        bundleId: grant.bundleId,
        name: live?.name ?? grant.name ?? grant.bundleId,
        tier: appClass,
        expiresAt: grant.expiresAt,
        foreground: grant.foreground,
        running: live !== undefined,
        windows,
      });
    }
    for (const live of running) {
      if (
        !live.running ||
        live.bundleId === null ||
        classifyApp(live.bundleId) === "refused" ||
        this.settings.ancestorPids.has(live.pid) ||
        report.some((listed) => listed.bundleId === live.bundleId)
      ) {
        continue;
      }
      report.push({
        bundleId: live.bundleId,
        name: live.name,
        tier: classifyApp(live.bundleId),
        expiresAt: Number.MAX_SAFE_INTEGER,
        foreground: false,
        running: true,
        windows: (await this.settings.driver.listWindows(live.pid)).filter(
          (window) => window.onScreen && !window.minimized,
        ),
      });
    }
    this.lastActionAt = this.now();
    return report;
  }

  /**
   * The app this action would reach when the run holds no consent for it — no active grant and no
   * first-reach approval yet. Refused apps and foreground-on-ungranted fail here; everything else
   * returns the app the tools must put to the person before acting.
   */
  async pendingConsent(
    action: ActionInput,
  ): Promise<{ readonly appName: string; readonly bundleId: string } | undefined> {
    const grants = await this.assertActive();
    const { observation } = this.locate(action);
    if (this.isConsented(observation.bundleId, grants)) {
      return undefined;
    }
    const appClass = classifyApp(observation.bundleId);
    if (appClass === "refused") {
      throw new Error(describeRefusal(observation.bundleId));
    }
    if (action.delivery === "foreground") {
      throw new Error(
        `${observation.appName} is not granted, so it cannot be brought to the front. Grant it with --foreground, or act on it in the background.`,
      );
    }
    return { appName: observation.appName, bundleId: observation.bundleId };
  }
  private chooseApp(running: readonly DriverApp[], wanted: string | undefined): DriverApp {
    const reachable = running.filter(
      (app) =>
        app.running &&
        app.bundleId !== null &&
        classifyApp(app.bundleId) !== "refused" &&
        !this.settings.ancestorPids.has(app.pid),
    );
    if (reachable.length === 0) {
      throw new Error("No app is running that Jazz may use. Open one, then observe it.");
    }
    if (wanted === undefined) {
      if (reachable.length === 1 && reachable[0] !== undefined) {
        return reachable[0];
      }
      throw new Error(`Name the app to observe: ${reachable.map((app) => app.name).join(", ")}.`);
    }
    const needle = wanted.trim().toLowerCase();
    const match = reachable.find(
      (app) => app.bundleId?.toLowerCase() === needle || app.name.toLowerCase() === needle,
    );
    if (match === undefined) {
      throw new Error(
        `${wanted} is not a running app. Running: ${reachable.map((app) => app.name).join(", ")}.`,
      );
    }
    return match;
  }

  /** Look at one window of a running app and register its refs. */
  async observe(input: ObserveInput, known: readonly KnownSecret[]): Promise<Observation> {
    await this.assertActive();
    const running = await this.settings.driver.listApps();
    const app = this.chooseApp(running, input.app);
    const bundleId = app.bundleId ?? "";
    const appClass = classifyApp(bundleId);
    if (appClass === "refused") {
      throw new Error(describeRefusal(bundleId));
    }
    const windows = (await this.settings.driver.listWindows(app.pid)).filter(
      (window) => window.onScreen && !window.minimized,
    );
    const window =
      input.windowId === undefined
        ? windows[0]
        : windows.find((candidate) => candidate.windowId === input.windowId);
    if (window === undefined) {
      throw new Error(
        input.windowId === undefined
          ? `${app.name} has no visible window to observe.`
          : `${app.name} has no visible window ${String(input.windowId)}. Use computer_apps to list its windows.`,
      );
    }

    const screenshotPath = input.screenshot
      ? path.join(this.settings.capturesDirectory, `${shortuuid.generate()}.png`)
      : undefined;
    if (screenshotPath !== undefined) {
      await mkdir(this.settings.capturesDirectory, { recursive: true, mode: stateDirectoryMode() });
    }
    const target = { pid: window.pid, windowId: window.windowId };
    this.lastTarget = { target, bundleId, appName: app.name, appClass };
    const observation = await this.nextObservation(target, {
      ...(screenshotPath === undefined ? {} : { screenshotPath }),
      ...(input.query === undefined ? {} : { query: input.query }),
    });
    await this.ledger({
      bundleId,
      app: app.name,
      action: "observe",
      target: ledgerLabel(observation.windowTitle, known),
      outcome: "ok",
    });
    return observation;
  }

  private async retainCapture(capturePath: string | undefined): Promise<void> {
    if (capturePath === undefined) {
      return;
    }
    this.captures.push(capturePath);
    while (this.captures.length > MAX_RETAINED_CAPTURES) {
      const oldest = this.captures.shift();
      if (oldest !== undefined) {
        await rm(oldest, { force: true });
      }
    }
  }

  /** Drop an observation's refs while remembering whose they were, so a late use is explained. */
  private retire(observation: Observation): void {
    this.byGeneration.delete(observation.generation);
    this.retired.set(observation.generation, observation.appName);
  }

  private observationById(observationId: string): Observation {
    const match = OBSERVATION_ID_PATTERN.exec(observationId.trim());
    const observation = match === null ? undefined : this.byGeneration.get(Number(match[1]));
    if (
      observation === undefined ||
      this.latestByWindow.get(observation.windowKey) !== observation
    ) {
      throw new Error(
        `Observation ${observationId} is not current. Observe the window again and use the new one.`,
      );
    }
    return observation;
  }

  private resolveRef(ref: string): {
    readonly observation: Observation;
    readonly element: ObservedElement;
  } {
    const parsed = parseRef(ref);
    const observation = parsed === undefined ? undefined : this.byGeneration.get(parsed.generation);
    if (parsed === undefined || observation === undefined) {
      const earlier = parsed === undefined ? undefined : this.retired.get(parsed.generation);
      throw new Error(
        earlier === undefined
          ? `No element has ref ${ref}. Observe the window and use a ref from it.`
          : `Ref ${ref} is from an earlier look at ${earlier}. Observe the window again and use a new ref.`,
      );
    }
    const element = observation.elements.get(ref);
    if (element === undefined) {
      throw new Error(
        observation.tier === "view-only"
          ? `${observation.appName} is view-only, so none of its elements can be acted on.`
          : `No element has ref ${ref}. Observe the window and use a ref from it.`,
      );
    }
    return { observation, element };
  }

  /** A person-readable name for an element, for an approval message. */
  describeRef(ref: string): string | undefined {
    try {
      const { observation, element } = this.resolveRef(ref);
      const label = element.label === null ? "" : ` "${element.label}"`;
      return `${element.role}${label} in ${observation.appName}`;
    } catch {
      return undefined;
    }
  }

  /** Whether the element a ref names is a secure text field. */
  isSecureField(ref: string): boolean {
    try {
      return this.resolveRef(ref).element.secure;
    } catch {
      return false;
    }
  }

  describeObservation(observationId: string): string | undefined {
    try {
      const observation = this.observationById(observationId);
      return `${observation.appName} — "${observation.windowTitle}"`;
    } catch {
      return undefined;
    }
  }

  private async authorize(
    observation: Observation,
    kind: ActionKind,
    delivery: DeliveryMode,
    grants: readonly ComputerGrant[],
  ): Promise<void> {
    const grant = grants.find((candidate) => candidate.bundleId === observation.bundleId);
    const appClass = classifyApp(observation.bundleId);
    if (appClass === "refused") {
      throw new Error(describeRefusal(observation.bundleId));
    }
    if (!tierAllows(appClass, kind)) {
      throw new Error(
        `${observation.appName} is ${appClass}: computer use cannot ${kind === "key" ? "press keys in" : kind} it.`,
      );
    }
    // Foreground needs a --foreground grant, and a first-reach consent never grants it: this
    // check runs before the consent check so the message the model gets is the useful one.
    if (delivery === "foreground" && grant?.foreground !== true) {
      throw new Error(
        grant === undefined
          ? `${observation.appName} is not granted, so it cannot be brought to the front. Grant it with --foreground, or act on it in the background.`
          : `${observation.appName} is granted for background use only. Grant it with --foreground to let Jazz bring it to the front.`,
      );
    }
    if (!this.isConsented(observation.bundleId, grants)) {
      throw new FirstReachConsentRequired(observation.appName, observation.bundleId);
    }
    const running = await this.settings.driver.listApps();
    const live = running.find(
      (app) =>
        app.pid === observation.target.pid && app.running && app.bundleId === observation.bundleId,
    );
    if (live === undefined || this.settings.ancestorPids.has(live.pid)) {
      throw new Error(`That window no longer belongs to ${observation.appName}. Observe again.`);
    }
  }

  /** Perform one action through the checks, record it, and report what the driver confirmed. */
  async perform(
    action: ActionInput,
    known: readonly KnownSecret[],
    captureAfter?: boolean,
  ): Promise<ActionReport> {
    const grants = await this.assertActive();
    const kind = kindOf(action);
    const { observation, element } = this.locate(action);
    const label =
      element?.label !== undefined && element.label !== null
        ? ledgerLabel(element.label, known)
        : action.kind === "click_point"
          ? `${String(action.x)},${String(action.y)}`
          : observation.windowTitle === ""
            ? undefined
            : ledgerLabel(observation.windowTitle, known);
    const record = (outcome: LedgerOutcome, detail?: string): Promise<void> =>
      this.ledger({
        bundleId: observation.bundleId,
        app: observation.appName,
        action: action.kind,
        ...(label === undefined ? {} : { target: label }),
        delivery: action.delivery,
        outcome,
        ...(detail === undefined ? {} : { detail }),
      });

    try {
      await this.authorize(observation, kind, action.delivery, grants);
      this.refuseForbidden(action, element);
      const driverAction = this.toDriverAction(action, observation, element);
      await this.ensureCapability(driverAction.kind);
      const result = await this.settings.driver.act(driverAction);
      this.lastActionAt = this.now();
      await record(result.effect === "refused" ? "refused" : "ok", result.effect);
      this.lastTarget = {
        target: observation.target,
        bundleId: observation.bundleId,
        appName: observation.appName,
        appClass: observation.tier,
      };
      const next =
        captureAfter === true ? await this.nextObservation(observation.target) : undefined;
      return {
        app: observation.appName,
        effect: result.effect,
        summary: result.summary,
        hint: result.hint ?? result.errorCode,
        ...(next === undefined ? {} : { observation: next }),
      };
    } catch (error) {
      const stopped =
        error instanceof ComputerStoppedError || (await stopRequestedSince(this.startedAt));
      await record(stopped ? "stopped" : "failed");
      if (stopped) {
        throw new ComputerStoppedError({ cause: error });
      }
      if (error instanceof DriverError && error.code === STALE_ELEMENT_CODE) {
        throw new Error(
          "That element is out of date. Observe the window again and use a new ref.",
          {
            cause: error,
          },
        );
      }
      throw error;
    }
  }

  /**
   * Wait on the last observed or acted window until its element outline settles (two
   * identical reads) or changes from the first read, or the time runs out. Runs inside the
   * session's exclusive queue via the tools, refreshes lastActionAt on every poll so the
   * idle limit cannot lapse mid-wait, and returns a fresh observation so the wait replaces
   * an observe round trip. Screenshot bytes are not part of the comparison: cursors and
   * animations make byte equality flaky.
   */
  async wait(options: WaitOptions): Promise<WaitReport> {
    const last = this.lastTarget;
    if (last === undefined) {
      throw new Error("Observe a window first.");
    }
    await this.assertActive();
    this.lastActionAt = this.now();
    // The deadline is real wall-clock time: the polls sleep in real time, and the injected
    // clock serves the idle limit, not the timer.
    const deadline = Date.now() + options.timeoutMs;
    let previous: string | undefined;
    let baseline: string | undefined;
    let state: DriverWindowState | undefined;
    for (;;) {
      if (await stopRequestedSince(this.startedAt)) {
        throw new ComputerStoppedError();
      }
      state = await this.windowStillThere(last);
      const outline = state.elements
        .slice(0, MAX_OBSERVED_ELEMENTS)
        .map((element) => `${String(element.index)} ${element.role} ${element.label ?? ""}`)
        .join("\n");
      this.lastActionAt = this.now();
      if (baseline === undefined) {
        baseline = outline;
      }
      const reached =
        options.until === "settled"
          ? previous !== undefined && outline === previous
          : outline !== baseline;
      previous = outline;
      if (reached) {
        return {
          outcome: options.until,
          observation: await this.nextObservationFrom(state),
        };
      }
      if (Date.now() + options.pollMs > deadline) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, options.pollMs));
    }
    const finalState = state ?? (await this.windowStillThere(last));
    return { outcome: "timeout", observation: await this.nextObservationFrom(finalState) };
  }

  /**
   * Read a window the wait is on. A window that closed or moved to another app while the
   * wait ran fails with the same error acting on it would.
   */
  private async windowStillThere(last: LastTarget): Promise<DriverWindowState> {
    const running = await this.settings.driver.listApps();
    const live = running.find(
      (app) => app.pid === last.target.pid && app.running && app.bundleId === last.bundleId,
    );
    if (live === undefined || this.settings.ancestorPids.has(live.pid)) {
      throw new Error(`That window no longer belongs to ${last.appName}. Observe again.`);
    }
    try {
      return await this.settings.driver.windowState(last.target, {
        maxElements: MAX_OBSERVED_ELEMENTS,
        maxDepth: MAX_OBSERVED_DEPTH,
      });
    } catch (error) {
      throw new Error(`That window no longer belongs to ${last.appName}. Observe again.`, {
        cause: error,
      });
    }
  }

  /**
   * Re-read one window's state and register it as the latest observation for that window:
   * a new generation, the previous observation's refs retired, the maps and the idle clock
   * refreshed. observe and captureAfter share this path, so their refs behave identically.
   */
  private async nextObservation(
    target: WindowTarget,
    options: { screenshotPath?: string; query?: string } = {},
  ): Promise<Observation> {
    const state = await this.settings.driver.windowState(target, {
      ...(options.screenshotPath === undefined ? {} : { screenshotPath: options.screenshotPath }),
      ...(options.query === undefined ? {} : { query: options.query }),
      maxElements: MAX_OBSERVED_ELEMENTS,
      maxDepth: MAX_OBSERVED_DEPTH,
    });
    return this.nextObservationFrom(state);
  }

  private async nextObservationFrom(state: DriverWindowState): Promise<Observation> {
    const last = this.lastTarget;
    if (last === undefined) {
      throw new Error("Observe a window first.");
    }
    this.generation += 1;
    const observation = buildObservation({
      generation: this.generation,
      state,
      bundleId: last.bundleId,
      tier: last.appClass,
    });
    const previous = this.latestByWindow.get(observation.windowKey);
    if (previous !== undefined) {
      this.retire(previous);
    }
    this.latestByWindow.set(observation.windowKey, observation);
    this.byGeneration.set(observation.generation, observation);
    await this.retainCapture(observation.screenshot?.path);
    this.lastActionAt = this.now();
    return observation;
  }

  private locate(action: ActionInput): {
    readonly observation: Observation;
    readonly element: ObservedElement | undefined;
  } {
    switch (action.kind) {
      case "click":
      case "type":
      case "scroll":
      case "set_value":
        return this.resolveRef(action.ref);
      case "double_click":
      case "triple_click":
      case "hover":
        return this.resolveRef(action.ref);
      case "drag":
        return this.resolveRef(action.fromRef);
      case "click_point":
      case "drag_points":
      case "hover_point":
      case "key":
      case "hold_key":
        return { observation: this.observationById(action.observation), element: undefined };
    }
  }

  private refuseForbidden(action: ActionInput, element: ObservedElement | undefined): void {
    if (action.kind === "type" || action.kind === "set_value") {
      const reason = blockedTextReason(action.text);
      if (reason !== undefined) {
        throw new Error(reason);
      }
      if (element?.secure === true && !action.secretPlaceholderGiven) {
        throw new Error(
          "That is a password field. Collect the password with ask_user_secret and pass its placeholder as the text.",
        );
      }
    }
    if (action.kind === "key" || action.kind === "hold_key") {
      const reason = blockedKeyReason([...action.modifiers, action.key]);
      if (reason !== undefined) {
        throw new Error(reason);
      }
      if (action.kind === "key" && typesCharacter(action.key, action.modifiers)) {
        throw new Error(
          "Use computer_input type to enter text. Key presses are for named keys and shortcuts.",
        );
      }
    }
    if (action.kind === "hold_key" && (action.durationMs < 1 || action.durationMs > MAX_HOLD_MS)) {
      throw new Error(`Hold duration must be between 1 and ${String(MAX_HOLD_MS)} milliseconds.`);
    }
    if (
      action.kind === "key" &&
      action.repeat !== undefined &&
      (action.repeat < 1 || action.repeat > MAX_KEY_REPEAT)
    ) {
      throw new Error(`Repeat must be between 1 and ${String(MAX_KEY_REPEAT)}.`);
    }
    if (action.kind === "scroll" && (action.amount < 1 || action.amount > MAX_SCROLL_AMOUNT)) {
      throw new Error(`Scroll amount must be between 1 and ${String(MAX_SCROLL_AMOUNT)}.`);
    }
  }

  private toDriverAction(
    action: ActionInput,
    observation: Observation,
    element: ObservedElement | undefined,
  ): Parameters<ComputerDriver["act"]>[0] {
    // An explicit windowId on the action beats the observation's window: it is how the model
    // resolves an app that owns several top-level windows.
    const target =
      action.windowId === undefined
        ? observation.target
        : { pid: observation.target.pid, windowId: action.windowId };
    switch (action.kind) {
      case "click":
        return {
          kind: "click",
          target,
          elementToken: requireElement(element).token,
          ...(action.button === undefined ? {} : { button: action.button }),
          delivery: action.delivery,
        };
      case "double_click":
        return {
          kind: "double_click",
          target,
          elementToken: requireElement(element).token,
          delivery: action.delivery,
        };
      case "triple_click":
        return {
          kind: "triple_click",
          target,
          elementToken: requireElement(element).token,
          delivery: action.delivery,
        };
      case "drag":
        return {
          kind: "drag",
          target,
          fromElement: requireElement(element).token,
          toElement: this.resolveRef(action.toRef).element.token,
          delivery: action.delivery,
        };
      case "hover":
        return {
          kind: "hover",
          target,
          elementToken: requireElement(element).token,
          delivery: action.delivery,
        };
      case "drag_points": {
        const screenshot = observation.screenshot;
        if (screenshot === undefined) {
          throw new Error("Observe the window with screenshot true before dragging by pixel.");
        }
        for (const [name, x, y] of [
          ["from", action.fromX, action.fromY],
          ["to", action.toX, action.toY],
        ] as const) {
          if (x < 0 || y < 0 || x >= screenshot.width || y >= screenshot.height) {
            throw new Error(
              `The ${name} point is outside the screenshot (${String(screenshot.width)}x${String(screenshot.height)} px).`,
            );
          }
        }
        return {
          kind: "drag",
          target,
          fromPoint: { x: action.fromX, y: action.fromY },
          toPoint: { x: action.toX, y: action.toY },
          delivery: action.delivery,
        };
      }
      case "hover_point":
        return {
          kind: "hover",
          target,
          x: action.x,
          y: action.y,
          delivery: action.delivery,
        };
      case "set_value":
        return {
          kind: "set_value",
          target,
          elementToken: requireElement(element).token,
          text: action.text,
          delivery: action.delivery,
        };
      case "type":
        return {
          kind: "type",
          target,
          elementToken: requireElement(element).token,
          text: action.text,
          delivery: action.delivery,
        };
      case "key":
        return {
          kind: "key",
          target,
          key: action.key,
          modifiers: action.modifiers,
          ...(action.repeat === undefined ? {} : { repeat: action.repeat }),
          delivery: action.delivery,
        };
      case "hold_key":
        return {
          kind: "hold_key",
          target,
          key: action.key,
          modifiers: action.modifiers,
          durationMs: action.durationMs,
          delivery: action.delivery,
        };
      case "click_point": {
        const screenshot = observation.screenshot;
        if (screenshot === undefined) {
          throw new Error("Observe the window with screenshot true before clicking by pixel.");
        }
        if (
          action.x < 0 ||
          action.y < 0 ||
          action.x >= screenshot.width ||
          action.y >= screenshot.height
        ) {
          throw new Error(
            `That point is outside the screenshot (${String(screenshot.width)}x${String(screenshot.height)} px).`,
          );
        }
        return {
          kind: "click_point",
          target,
          x: action.x,
          y: action.y,
          ...(action.button === undefined ? {} : { button: action.button }),
          delivery: action.delivery,
        };
      }
      case "scroll": {
        const point =
          element?.frame === null || element?.frame === undefined
            ? undefined
            : frameCenter(element.frame);
        if (point === undefined) {
          throw new Error(
            "Scroll needs a ref whose element has a position. Pass the ref of the area to scroll.",
          );
        }
        return {
          kind: "scroll",
          target,
          x: point.x,
          y: point.y,
          direction: action.direction,
          amount: action.amount,
          delivery: action.delivery,
        };
      }
    }
  }

  /**
   * Confirm this driver build serves the action kind before spending the round trip; a missing
   * kind is a named failure the tool layer turns into a one-line message.
   */
  private async ensureCapability(kind: string): Promise<void> {
    if (
      kind === "click" ||
      kind === "click_point" ||
      kind === "scroll" ||
      kind === "type" ||
      kind === "key"
    ) {
      return;
    }
    if (this.supportedKinds === undefined) {
      this.supportedKinds = await this.settings.driver.capabilities();
    }
    if (!this.supportedKinds.includes(kind)) {
      throw new DriverError(
        `This driver build (${this.settings.driver.version ?? "unknown"}) cannot ${kind}. Upgrade the driver to use it.`,
        CAPABILITY_UNSUPPORTED_CODE,
      );
    }
  }

  /** Forget every observation, for after a person did something the model cannot see. */
  async handoff(known: readonly KnownSecret[]): Promise<void> {
    const apps = [...this.latestByWindow.values()];
    this.generation += 1;
    for (const observation of apps) {
      this.retire(observation);
    }
    this.latestByWindow.clear();
    this.lastActionAt = this.now();
    await this.ledger({
      bundleId: apps[0]?.bundleId ?? "none",
      app: apps[0] === undefined ? "none" : ledgerLabel(apps[0].appName, known),
      action: "handoff",
      outcome: "ok",
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await this.settings.driver.close();
    } finally {
      await rm(this.settings.capturesDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      );
      await clearSessionInfo().catch(() => undefined);
      await clearStopRequest().catch(() => undefined);
      await this.settings.releaseLock().catch(() => undefined);
      this.settings.announce("Jazz finished using your computer.");
    }
  }
}

function requireElement(element: ObservedElement | undefined): ObservedElement {
  if (element === undefined) {
    throw new Error("That action needs a ref from an observation.");
  }
  return element;
}

/** The run's computer session: started on first use, closed once when the run ends. */
export class ComputerSessions extends RunScopedResource<ComputerSession> {
  constructor() {
    super("Computer use for this run has ended.");
  }
}
