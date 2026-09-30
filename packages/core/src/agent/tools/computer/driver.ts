/**
 * What computer use needs from a desktop driver, independent of which driver provides it.
 *
 * The policy lives in Jazz: which apps, which actions, what the model sees, what needs a
 * person. A driver only lists windows, reads one window's accessibility tree and screenshot, and
 * delivers one input to one window. Nothing here names a driver's wire format; `cua-contract.ts`
 * maps this interface onto one.
 */

export interface DriverApp {
  readonly pid: number;
  readonly name: string;
  readonly bundleId: string | null;
  readonly running: boolean;
  readonly active: boolean;
}

export interface Rectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DriverWindow {
  readonly windowId: number;
  readonly pid: number;
  readonly appName: string;
  readonly title: string;
  readonly onScreen: boolean;
  readonly minimized: boolean;
  readonly bounds: Rectangle;
}

export interface DriverElement {
  readonly index: number;
  readonly role: string;
  readonly depth: number;
  /** The driver's handle for acting on this element; null when the element cannot be addressed. */
  readonly token: string | null;
  readonly label: string | null;
  readonly value: string | null;
  readonly enabled: boolean | null;
  readonly selected: boolean | null;
  readonly frame: Rectangle | null;
}

export interface DriverWindowState {
  readonly pid: number;
  readonly windowId: number;
  readonly appName: string;
  readonly windowTitle: string;
  readonly snapshotId: string | null;
  readonly elements: readonly DriverElement[];
  readonly elementsComplete: boolean;
  readonly degraded: boolean;
  readonly degradedReason: string | null;
  readonly screenshotPath: string | null;
  readonly screenshotWidth: number | null;
  readonly screenshotHeight: number | null;
  readonly windowBounds: Rectangle | null;
}

export interface WindowTarget {
  readonly pid: number;
  readonly windowId: number;
}

export type DeliveryMode = "background" | "foreground";

export type ScrollDirection = "up" | "down" | "left" | "right";

export type DriverAction =
  | {
      readonly kind: "click";
      readonly target: WindowTarget;
      readonly elementToken: string;
      readonly delivery: DeliveryMode;
    }
  | {
      readonly kind: "click_point";
      readonly target: WindowTarget;
      readonly x: number;
      readonly y: number;
      readonly delivery: DeliveryMode;
    }
  | {
      readonly kind: "scroll";
      readonly target: WindowTarget;
      readonly x: number;
      readonly y: number;
      readonly direction: ScrollDirection;
      readonly amount: number;
      readonly delivery: DeliveryMode;
    }
  | {
      readonly kind: "type";
      readonly target: WindowTarget;
      readonly elementToken: string;
      readonly text: string;
      readonly delivery: DeliveryMode;
    }
  | {
      readonly kind: "key";
      readonly target: WindowTarget;
      readonly key: string;
      readonly modifiers: readonly string[];
      readonly delivery: DeliveryMode;
    };

/** How far the driver could confirm that an action did what was asked. */
export type ActionEffect = "confirmed" | "partial" | "unverifiable" | "suspected_noop" | "refused";

export interface DriverActionResult {
  readonly effect: ActionEffect;
  readonly summary: string | null;
  readonly errorCode: string | null;
  readonly hint: string | null;
}

export interface WindowStateOptions {
  /** Where the driver writes the window screenshot, or undefined to skip the screenshot. */
  readonly screenshotPath?: string;
  readonly query?: string;
  readonly maxElements: number;
  readonly maxDepth: number;
}

/** A failure the driver reported, with its code when it gave one. */
export class DriverError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined = undefined,
  ) {
    super(message);
    this.name = "DriverError";
  }
}

/** Raised when the driver reports that the element handle no longer matches the window. */
export const STALE_ELEMENT_CODE = "stale_element_token";

export interface ComputerDriver {
  /** The driver's own version string, when it reports one. */
  readonly version: string | null;
  /** The operating-system pid of the driver process, for stopping it from outside the run. */
  readonly pid: number | null;
  listApps(): Promise<readonly DriverApp[]>;
  listWindows(pid: number): Promise<readonly DriverWindow[]>;
  windowState(target: WindowTarget, options: WindowStateOptions): Promise<DriverWindowState>;
  act(action: DriverAction): Promise<DriverActionResult>;
  close(): Promise<void>;
}
