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
  blockedKeyReason,
  blockedTextReason,
  classifyApp,
  describeRefusal,
  tierAllows,
} from "./app-policy";
import { clearSessionInfo, clearStopRequest, stopRequestedSince } from "./control";
import {
  type ActionEffect,
  type ComputerDriver,
  type DeliveryMode,
  type DriverApp,
  type DriverWindow,
  type ScrollDirection,
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
  | { readonly kind: "click"; readonly ref: string; readonly delivery: DeliveryMode }
  | {
      readonly kind: "click_point";
      readonly observation: string;
      readonly x: number;
      readonly y: number;
      readonly delivery: DeliveryMode;
    }
  | {
      readonly kind: "scroll";
      readonly ref: string;
      readonly direction: ScrollDirection;
      readonly amount: number;
      readonly delivery: DeliveryMode;
    }
  | {
      readonly kind: "type";
      readonly ref: string;
      readonly text: string;
      readonly delivery: DeliveryMode;
      readonly secretPlaceholderGiven: boolean;
    }
  | {
      readonly kind: "key";
      readonly observation: string;
      readonly key: string;
      readonly modifiers: readonly string[];
      readonly delivery: DeliveryMode;
    };

export interface ActionReport {
  readonly app: string;
  readonly effect: ActionEffect;
  readonly summary: string | null;
  readonly hint: string | null;
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
      return "click";
    case "scroll":
      return "scroll";
    case "type":
      return "type";
    case "key":
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

  /** The granted apps with their running state and windows. */
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
    this.lastActionAt = this.now();
    return report;
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
    const state = await this.settings.driver.windowState(target, {
      ...(screenshotPath === undefined ? {} : { screenshotPath }),
      ...(input.query === undefined ? {} : { query: input.query }),
      maxElements: MAX_OBSERVED_ELEMENTS,
      maxDepth: MAX_OBSERVED_DEPTH,
    });

    this.generation += 1;
    const observation = buildObservation({
      generation: this.generation,
      state,
      bundleId,
      tier: appClass,
    });
    const previous = this.latestByWindow.get(observation.windowKey);
    if (previous !== undefined) {
      this.retire(previous);
    }
    this.latestByWindow.set(observation.windowKey, observation);
    this.byGeneration.set(observation.generation, observation);
    await this.retainCapture(observation.screenshot?.path);
    this.lastActionAt = this.now();
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

  describeObservation(observationId: string): string | undefined {
    try {
      const observation = this.observationById(observationId);
      return `${observation.appName} — "${observation.windowTitle}"`;
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

  private async authorize(
    observation: Observation,
    kind: ActionKind,
    delivery: DeliveryMode,
    grants: readonly ComputerGrant[],
  ): Promise<ComputerGrant> {
    const grant = grants.find((candidate) => candidate.bundleId === observation.bundleId);
    if (grant === undefined) {
      throw new Error(`Access to ${observation.appName} is no longer granted.`);
    }
    const appClass = classifyApp(observation.bundleId);
    if (appClass === "refused") {
      throw new Error(describeRefusal(observation.bundleId));
    }
    if (!tierAllows(appClass, kind)) {
      throw new Error(
        `${observation.appName} is ${appClass}: computer use cannot ${kind === "key" ? "press keys in" : kind} it.`,
      );
    }
    if (delivery === "foreground" && !grant.foreground) {
      throw new Error(
        `${observation.appName} is granted for background use only. Grant it with --foreground to let Jazz bring it to the front.`,
      );
    }
    const running = await this.settings.driver.listApps();
    const live = running.find(
      (app) =>
        app.pid === observation.target.pid && app.running && app.bundleId === observation.bundleId,
    );
    if (live === undefined || this.settings.ancestorPids.has(live.pid)) {
      throw new Error(`That window no longer belongs to ${observation.appName}. Observe again.`);
    }
    return grant;
  }

  /** Perform one action through the checks, record it, and report what the driver confirmed. */
  async perform(action: ActionInput, known: readonly KnownSecret[]): Promise<ActionReport> {
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
      const result = await this.settings.driver.act(driverAction);
      this.lastActionAt = this.now();
      await record(result.effect === "refused" ? "refused" : "ok", result.effect);
      return {
        app: observation.appName,
        effect: result.effect,
        summary: result.summary,
        hint: result.hint ?? result.errorCode,
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

  private locate(action: ActionInput): {
    readonly observation: Observation;
    readonly element: ObservedElement | undefined;
  } {
    switch (action.kind) {
      case "click":
      case "type":
      case "scroll":
        return this.resolveRef(action.ref);
      case "click_point":
      case "key":
        return { observation: this.observationById(action.observation), element: undefined };
    }
  }

  private refuseForbidden(action: ActionInput, element: ObservedElement | undefined): void {
    if (action.kind === "type") {
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
    if (action.kind === "key") {
      const reason = blockedKeyReason([...action.modifiers, action.key]);
      if (reason !== undefined) {
        throw new Error(reason);
      }
      if (typesCharacter(action.key, action.modifiers)) {
        throw new Error(
          "Use computer_input type to enter text. Key presses are for named keys and shortcuts.",
        );
      }
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
    const target = observation.target;
    switch (action.kind) {
      case "click":
        return {
          kind: "click",
          target,
          elementToken: requireElement(element).token,
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
        return { kind: "click_point", target, x: action.x, y: action.y, delivery: action.delivery };
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
