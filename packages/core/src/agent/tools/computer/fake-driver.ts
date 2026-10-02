/**
 * An in-memory desktop driver for tests: a few apps, their windows, and their elements, with a
 * record of every action it was asked to perform. It never touches a real desktop.
 */

import {
  type ComputerDriver,
  type DriverAction,
  type DriverActionResult,
  type DriverApp,
  DriverError,
  type DriverElement,
  type DriverWindow,
  type DriverWindowState,
  type WindowStateOptions,
  type WindowTarget,
} from "./driver";

export interface FakeElement {
  readonly role: string;
  readonly label?: string;
  readonly value?: string;
  readonly token?: string | null;
  readonly frame?: { x: number; y: number; width: number; height: number };
}

export interface FakeApp {
  readonly pid: number;
  readonly name: string;
  readonly bundleId: string | null;
  readonly windows: readonly {
    readonly windowId: number;
    readonly title: string;
    readonly elements: readonly FakeElement[];
  }[];
  readonly running?: boolean;
}

export class FakeDriver implements ComputerDriver {
  readonly version = "fake-1";
  readonly pid = null;
  readonly actions: DriverAction[] = [];
  readonly stateRequests: { target: WindowTarget; options: WindowStateOptions }[] = [];
  closes = 0;
  nextActionResult: DriverActionResult = {
    effect: "confirmed",
    summary: "done",
    errorCode: null,
    hint: null,
  };
  failNextActionWith: DriverError | undefined;
  beforeAct: (() => Promise<void>) | undefined;
  screenshotWidth = 800;
  screenshotHeight = 600;

  constructor(
    public apps: readonly FakeApp[],
    readonly capabilitiesList: readonly string[] = [
      "double_click",
      "triple_click",
      "drag",
      "hover",
      "set_value",
    ],
  ) {}

  private settle<Value>(operation: () => Value): Promise<Value> {
    try {
      return Promise.resolve(operation());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  listApps(): Promise<readonly DriverApp[]> {
    return this.settle(() =>
      this.apps.map((app) => ({
        pid: app.pid,
        name: app.name,
        bundleId: app.bundleId,
        running: app.running ?? true,
        active: false,
      })),
    );
  }

  private find(pid: number): FakeApp {
    const app = this.apps.find((candidate) => candidate.pid === pid);
    if (app === undefined) {
      throw new DriverError(`No app has pid ${String(pid)}.`);
    }
    return app;
  }

  listWindows(pid: number): Promise<readonly DriverWindow[]> {
    return this.settle(() => {
      const app = this.find(pid);
      return app.windows.map((window) => ({
        windowId: window.windowId,
        pid,
        appName: app.name,
        title: window.title,
        onScreen: true,
        minimized: false,
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      }));
    });
  }

  windowState(target: WindowTarget, options: WindowStateOptions): Promise<DriverWindowState> {
    this.stateRequests.push({ target, options });
    return this.settle(() => {
      const app = this.find(target.pid);
      const window = app.windows.find((candidate) => candidate.windowId === target.windowId);
      if (window === undefined) {
        throw new DriverError(`No window ${String(target.windowId)}.`);
      }
      const elements: DriverElement[] = window.elements.map((element, index) => ({
        index,
        role: element.role,
        depth: 0,
        token: element.token === undefined ? `token-${String(index)}` : element.token,
        label: element.label ?? null,
        value: element.value ?? null,
        enabled: true,
        selected: false,
        frame: element.frame ?? { x: 10 * index, y: 10, width: 80, height: 20 },
      }));
      return {
        pid: target.pid,
        windowId: target.windowId,
        appName: app.name,
        windowTitle: window.title,
        snapshotId: "snapshot-1",
        elements,
        elementsComplete: true,
        degraded: false,
        degradedReason: null,
        screenshotPath: options.screenshotPath ?? null,
        screenshotWidth: options.screenshotPath === undefined ? null : this.screenshotWidth,
        screenshotHeight: options.screenshotPath === undefined ? null : this.screenshotHeight,
        windowBounds: { x: 0, y: 0, width: 800, height: 600 },
      };
    });
  }

  capabilities(): Promise<readonly string[]> {
    return Promise.resolve(this.capabilitiesList);
  }

  async act(action: DriverAction): Promise<DriverActionResult> {
    this.actions.push(action);
    await this.beforeAct?.();
    if (this.failNextActionWith !== undefined) {
      const error = this.failNextActionWith;
      this.failNextActionWith = undefined;
      throw error;
    }
    return this.nextActionResult;
  }

  close(): Promise<void> {
    this.closes += 1;
    return Promise.resolve();
  }
}

/** A mail-like app with a text field and a button, for tests that act on it. */
export function mailApp(overrides: Partial<FakeApp> = {}): FakeApp {
  return {
    pid: 101,
    name: "Mail",
    bundleId: "com.apple.mail",
    windows: [
      {
        windowId: 1,
        title: "Inbox",
        elements: [
          { role: "AXButton", label: "Send" },
          { role: "AXTextField", label: "Subject" },
          { role: "AXSecureTextField", label: "Password", value: "hunter2" },
        ],
      },
    ],
    ...overrides,
  };
}
