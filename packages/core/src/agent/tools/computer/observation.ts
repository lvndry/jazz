/**
 * One look at one window: the text the model reads, and the refs it may act through.
 *
 * Refs are minted here, not by the driver. A ref is `c<generation>.<index>`: the generation is
 * this session's count of observations, so a ref names the exact observation it came from.
 * Observing a window again retires every ref from its earlier observations, and acting through
 * a retired ref is an error, never a click on whatever now sits at that position.
 *
 * What a window's tier allows is decided where refs are minted. A view-only window gets none, so
 * there is nothing in it to act on.
 */

import type { AppTier } from "./app-policy";
import type { DriverElement, DriverWindowState, Rectangle, WindowTarget } from "./driver";

/** Longest element label shown, in characters. */
const MAX_LABEL_CHARS = 120;

/** Longest element value shown, in characters. */
const MAX_VALUE_CHARS = 200;

/** Most elements one observation lists; a larger window is narrowed with a query. */
export const MAX_OBSERVED_ELEMENTS = 250;

/** Deepest accessibility level one observation walks. */
export const MAX_OBSERVED_DEPTH = 12;

const REF_PATTERN = /^c(\d+)\.(\d+)$/;

const SECURE_ROLE_PATTERN = /secure/i;

export interface ObservedElement {
  readonly ref: string;
  readonly index: number;
  readonly role: string;
  readonly label: string | null;
  readonly token: string;
  readonly frame: Rectangle | null;
  readonly secure: boolean;
}

export interface ObservedScreenshot {
  readonly path: string;
  readonly width: number;
  readonly height: number;
}

export interface Observation {
  readonly generation: number;
  readonly windowKey: string;
  readonly target: WindowTarget;
  readonly bundleId: string;
  readonly appName: string;
  readonly windowTitle: string;
  readonly tier: AppTier;
  readonly elements: ReadonlyMap<string, ObservedElement>;
  readonly screenshot: ObservedScreenshot | undefined;
  readonly text: string;
}

export function windowKey(target: WindowTarget): string {
  return `${String(target.pid)}:${String(target.windowId)}`;
}

export function makeRef(generation: number, index: number): string {
  return `c${String(generation)}.${String(index)}`;
}

export function parseRef(
  ref: string,
): { readonly generation: number; readonly index: number } | undefined {
  const match = REF_PATTERN.exec(ref.trim());
  return match === null ? undefined : { generation: Number(match[1]), index: Number(match[2]) };
}

function tidy(value: string, limit: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

function isSecure(element: DriverElement): boolean {
  return SECURE_ROLE_PATTERN.test(element.role);
}

function describeElement(element: DriverElement, ref: string | null, secure: boolean): string {
  const indent = "  ".repeat(Math.min(element.depth, MAX_OBSERVED_DEPTH));
  const label =
    element.label === null || element.label.trim() === ""
      ? ""
      : ` "${tidy(element.label, MAX_LABEL_CHARS)}"`;
  const value =
    secure || element.value === null || element.value.trim() === ""
      ? ""
      : ` value="${tidy(element.value, MAX_VALUE_CHARS)}"`;
  const notes = [
    secure ? "secure field" : undefined,
    element.enabled === false ? "disabled" : undefined,
    element.selected === true ? "selected" : undefined,
  ].filter((note): note is string => note !== undefined);
  const suffix = notes.length === 0 ? "" : ` (${notes.join(", ")})`;
  const refText = ref === null ? "" : ` [ref=${ref}]`;
  return `${indent}- ${element.role}${label}${value}${suffix}${refText}`;
}

export interface ObservationInput {
  readonly generation: number;
  readonly state: DriverWindowState;
  readonly bundleId: string;
  readonly tier: AppTier;
}

const TIER_SUMMARY: Readonly<Record<AppTier, string>> = {
  "view-only": "view-only (this window can be read, not acted on)",
  "click-only": "click-only (clicks and scrolling, no typing)",
  full: "full control",
};

export function buildObservation(input: ObservationInput): Observation {
  const { generation, state, bundleId, tier } = input;
  const target = { pid: state.pid, windowId: state.windowId };
  const shown = state.elements.slice(0, MAX_OBSERVED_ELEMENTS);
  const addressable = tier !== "view-only";
  const elements = new Map<string, ObservedElement>();
  const lines: string[] = [];

  for (const element of shown) {
    const secure = isSecure(element);
    const ref = addressable && element.token !== null ? makeRef(generation, element.index) : null;
    if (ref !== null && element.token !== null) {
      elements.set(ref, {
        ref,
        index: element.index,
        role: element.role,
        label: element.label === null ? null : tidy(element.label, MAX_LABEL_CHARS),
        token: element.token,
        frame: element.frame,
        secure,
      });
    }
    lines.push(describeElement(element, ref, secure));
  }

  const screenshot =
    state.screenshotPath !== null &&
    state.screenshotWidth !== null &&
    state.screenshotHeight !== null
      ? { path: state.screenshotPath, width: state.screenshotWidth, height: state.screenshotHeight }
      : undefined;

  const complete = state.elementsComplete && state.elements.length <= MAX_OBSERVED_ELEMENTS;
  const header = [
    `app: ${state.appName} (${bundleId})`,
    `window: "${tidy(state.windowTitle, MAX_LABEL_CHARS)}"`,
    `access: ${TIER_SUMMARY[tier]}`,
    `elements: ${String(shown.length)}${complete ? "" : " (partial: pass a query to narrow the window)"}`,
    ...(screenshot === undefined
      ? []
      : [
          `screenshot: ${screenshot.path} (${String(screenshot.width)}x${String(screenshot.height)} px)`,
        ]),
    ...(state.degraded
      ? [
          `note: this window exposes little accessibility data${state.degradedReason === null ? "" : ` (${state.degradedReason})`}. Observe with screenshot true and click by pixel.`,
        ]
      : []),
  ];

  return {
    generation,
    windowKey: windowKey(target),
    target,
    bundleId,
    appName: state.appName,
    windowTitle: state.windowTitle,
    tier,
    elements,
    screenshot,
    text: `${header.join("\n")}\n\n${lines.join("\n")}`,
  };
}

/** The point at the middle of a frame, in the driver's screen coordinates. */
export function frameCenter(frame: Rectangle): { readonly x: number; readonly y: number } {
  return { x: Math.round(frame.x + frame.width / 2), y: Math.round(frame.y + frame.height / 2) };
}
