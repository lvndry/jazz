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

export type MouseButton = "left" | "right" | "middle";

/** The one window or element a driver action acts in. */
type ActionTarget = { readonly target: WindowTarget; readonly delivery: DeliveryMode };

/**
 * Every primitive computer use can ask a driver to perform. `elementToken` is the opaque handle of
 * an element from a window state; the driver rejects it when the element is out of date.
 */
export type DriverAction =
  | (ActionTarget & {
      readonly kind: "click";
      readonly elementToken: string;
      readonly button?: MouseButton;
    })
  | (ActionTarget & {
      readonly kind: "click_point";
      readonly x: number;
      readonly y: number;
      readonly button?: MouseButton;
    })
  | (ActionTarget & { readonly kind: "double_click"; readonly elementToken: string })
  | (ActionTarget & { readonly kind: "triple_click"; readonly elementToken: string })
  | ((
      | {
          readonly fromElement: string;
          readonly toElement: string;
        }
      | {
          readonly fromPoint: { readonly x: number; readonly y: number };
          readonly toPoint: { readonly x: number; readonly y: number };
        }
    ) &
      ActionTarget & { readonly kind: "drag" })
  | (ActionTarget & {
      readonly kind: "hover";
      readonly elementToken?: string;
      readonly x?: number;
      readonly y?: number;
    })
  | (ActionTarget & {
      readonly kind: "scroll";
      readonly x: number;
      readonly y: number;
      readonly direction: ScrollDirection;
      readonly amount: number;
    })
  | (ActionTarget & {
      readonly kind: "type";
      readonly elementToken: string;
      readonly text: string;
    })
  | (ActionTarget & {
      readonly kind: "set_value";
      readonly elementToken: string;
      readonly text: string;
    })
  | (ActionTarget & {
      readonly kind: "key";
      readonly key: string;
      readonly modifiers: readonly string[];
      readonly repeat?: number;
    })
  | (ActionTarget & {
      readonly kind: "hold_key";
      readonly key: string;
      readonly modifiers: readonly string[];
      readonly durationMs: number;
    });

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

/** Raised when the driver build cannot serve an action kind at all. */
export const CAPABILITY_UNSUPPORTED_CODE = "capability_unsupported";

export interface ComputerDriver {
  /** The driver's own version string, when it reports one. */
  readonly version: string | null;
  /** The operating-system pid of the driver process, for stopping it from outside the run. */
  readonly pid: number | null;
  /**
   * The action kinds this driver build serves. Checked before an action reaches the driver so a
   * missing kind fails with a named error instead of a driver round trip.
   */
  capabilities(): Promise<readonly string[]>;
  listApps(): Promise<readonly DriverApp[]>;
  listWindows(pid: number): Promise<readonly DriverWindow[]>;
  windowState(target: WindowTarget, options: WindowStateOptions): Promise<DriverWindowState>;
  act(action: DriverAction): Promise<DriverActionResult>;
  close(): Promise<void>;
}
