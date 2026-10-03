/**
 * The wire format of the `cua-driver` MCP server, and nothing else.
 *
 * Every tool name, argument name and reply field the adapter relies on is in this file, so a
 * change in the driver touches one place. What each part rests on:
 *
 * - Confirmed by the driver's published contract manifest (`libs/cua-driver/contract/manifest.json`,
 *   contract 0.8.0): the tool names, the arguments of `list_apps`, `list_windows`,
 *   `get_window_state` (including `screenshot_out_file`, `query`, `max_elements`, `max_depth`) and
 *   `click` (a `target` of `{kind: "window", pid, window_id}`, a `delivery_mode`, and either an
 *   `element_token` or `x` and `y`), plus the reply fields of those four and the action result
 *   (`effect`, `summary`, `error.code`, `error.hint`).
 * - Documented only in the driver's macOS skill notes, absent from the manifest's portable
 *   subset: `type_text` taking `pid`, `window_id`, `element_token` and `text`; `press_key` taking
 *   `pid`, `key` and `modifiers`; `scroll` accepting `delivery_mode`; the `stale_element_token`
 *   error code.
 * - Assumed, and to be checked against a real driver: that `x` and `y` of a point click are in
 *   the pixel space of the window screenshot, that `scroll` takes `x` and `y` in screen
 *   coordinates, and that an MCP tool error carries its text in `content`.
 */

import { isRecord } from "@/core/utils/is-record";
import {
  type ActionEffect,
  type DriverAction,
  type DriverActionResult,
  type DriverApp,
  DriverError,
  type DriverElement,
  type DriverWindow,
  type DriverWindowState,
  type Rectangle,
  STALE_ELEMENT_CODE,
  type WindowStateOptions,
  type WindowTarget,
} from "./driver";

export const CUA_TOOL_NAMES = {
  listApps: "list_apps",
  listWindows: "list_windows",
  windowState: "get_window_state",
  click: "click",
  doubleClick: "double_click",
  tripleClick: "triple_click",
  drag: "drag",
  move: "move",
  typeText: "type_text",
  setValue: "set_value",
  pressKey: "press_key",
  scroll: "scroll",
} as const;

/** The tools a driver must advertise for computer use to work. */
/**
 * The tools every driver build must offer: the observation machinery and the minimal action
 * vocabulary. Extended kinds are advertised separately through {@link actionCapabilities}; a
 * driver that lacks them still starts and simply reports a smaller capability set.
 */
export const REQUIRED_CUA_TOOLS: readonly string[] = [
  CUA_TOOL_NAMES.listApps,
  CUA_TOOL_NAMES.listWindows,
  CUA_TOOL_NAMES.windowState,
  CUA_TOOL_NAMES.click,
  CUA_TOOL_NAMES.typeText,
  CUA_TOOL_NAMES.pressKey,
  CUA_TOOL_NAMES.scroll,
];

/**
 * One extended action kind and the driver tools that back it. `click` and its `button` argument
 * are required machinery, not an advertised capability.
 */
export const EXTENDED_ACTION_CAPABILITIES = [
  { kind: "double_click", tools: [CUA_TOOL_NAMES.doubleClick] },
  { kind: "triple_click", tools: [CUA_TOOL_NAMES.tripleClick] },
  { kind: "drag", tools: [CUA_TOOL_NAMES.drag] },
  { kind: "hover", tools: [CUA_TOOL_NAMES.move] },
  { kind: "set_value", tools: [CUA_TOOL_NAMES.setValue] },
] as const;

/** The extended action kinds a driver offers, derived from the tools it advertises. */
export function actionCapabilities(offered: readonly string[]): readonly string[] {
  const offeredSet = new Set(offered);
  return EXTENDED_ACTION_CAPABILITIES.filter((capability) =>
    capability.tools.every((tool) => offeredSet.has(tool)),
  ).map((capability) => capability.kind);
}

/** Time the driver may spend walking one window's accessibility tree, in milliseconds. */
export const ACCESSIBILITY_WALK_TIMEOUT_MS = 3_000;

export interface CuaToolCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

function windowTarget(target: WindowTarget): Record<string, unknown> {
  return { kind: "window", pid: target.pid, window_id: target.windowId };
}

export function listAppsCall(): CuaToolCall {
  return { name: CUA_TOOL_NAMES.listApps, arguments: {} };
}

export function listWindowsCall(pid: number): CuaToolCall {
  return { name: CUA_TOOL_NAMES.listWindows, arguments: { pid, on_screen_only: true } };
}

export function windowStateCall(target: WindowTarget, options: WindowStateOptions): CuaToolCall {
  return {
    name: CUA_TOOL_NAMES.windowState,
    arguments: {
      pid: target.pid,
      window_id: target.windowId,
      include_accessibility_tree: true,
      include_screenshot: options.screenshotPath !== undefined,
      ...(options.screenshotPath === undefined
        ? {}
        : { screenshot_out_file: options.screenshotPath }),
      ...(options.query === undefined ? {} : { query: options.query }),
      max_elements: options.maxElements,
      max_depth: options.maxDepth,
      timeout_ms: ACCESSIBILITY_WALK_TIMEOUT_MS,
    },
  };
}

export function actionCall(action: DriverAction): CuaToolCall {
  switch (action.kind) {
    case "click":
      return {
        name: CUA_TOOL_NAMES.click,
        arguments: {
          target: windowTarget(action.target),
          element_token: action.elementToken,
          ...(action.button === undefined ? {} : { button: action.button }),
          delivery_mode: action.delivery,
        },
      };
    case "click_point":
      return {
        name: CUA_TOOL_NAMES.click,
        arguments: {
          target: windowTarget(action.target),
          x: action.x,
          y: action.y,
          ...(action.button === undefined ? {} : { button: action.button }),
          delivery_mode: action.delivery,
        },
      };
    case "double_click":
      return {
        name: CUA_TOOL_NAMES.doubleClick,
        arguments: {
          target: windowTarget(action.target),
          element_token: action.elementToken,
          delivery_mode: action.delivery,
        },
      };
    case "triple_click":
      return {
        name: CUA_TOOL_NAMES.tripleClick,
        arguments: {
          target: windowTarget(action.target),
          element_token: action.elementToken,
          delivery_mode: action.delivery,
        },
      };
    case "drag": {
      const args: Record<string, unknown> = { target: windowTarget(action.target) };
      if ("fromElement" in action) {
        args["from_element_token"] = action.fromElement;
        args["to_element_token"] = action.toElement;
      } else {
        args["from_x"] = action.fromPoint.x;
        args["from_y"] = action.fromPoint.y;
        args["to_x"] = action.toPoint.x;
        args["to_y"] = action.toPoint.y;
      }
      args["delivery_mode"] = action.delivery;
      return { name: CUA_TOOL_NAMES.drag, arguments: args };
    }
    case "hover":
      return {
        name: CUA_TOOL_NAMES.move,
        arguments: {
          target: windowTarget(action.target),
          ...(action.elementToken !== undefined ? { element_token: action.elementToken } : {}),
          ...(action.elementToken === undefined ? { x: action.x, y: action.y } : {}),
          delivery_mode: action.delivery,
        },
      };
    case "scroll":
      return {
        name: CUA_TOOL_NAMES.scroll,
        arguments: {
          target: windowTarget(action.target),
          x: action.x,
          y: action.y,
          direction: action.direction,
          amount: action.amount,
          by: "line",
          delivery_mode: action.delivery,
        },
      };
    case "type":
      return {
        name: CUA_TOOL_NAMES.typeText,
        arguments: {
          pid: action.target.pid,
          window_id: action.target.windowId,
          element_token: action.elementToken,
          text: action.text,
          delivery_mode: action.delivery,
        },
      };
    case "set_value":
      return {
        name: CUA_TOOL_NAMES.setValue,
        arguments: {
          pid: action.target.pid,
          window_id: action.target.windowId,
          element_token: action.elementToken,
          text: action.text,
          delivery_mode: action.delivery,
        },
      };
    case "key":
      return {
        name: CUA_TOOL_NAMES.pressKey,
        arguments: {
          pid: action.target.pid,
          key: action.key,
          modifiers: action.modifiers,
          ...(action.repeat === undefined ? {} : { count: action.repeat }),
          delivery_mode: action.delivery,
        },
      };
    case "hold_key":
      return {
        name: CUA_TOOL_NAMES.pressKey,
        arguments: {
          pid: action.target.pid,
          key: action.key,
          modifiers: action.modifiers,
          duration_ms: action.durationMs,
          delivery_mode: action.delivery,
        },
      };
  }
}

function text(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function integer(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function flag(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key];
  return typeof value === "boolean" ? value : null;
}

function rectangle(value: unknown, widthKey: "width" | "w"): Rectangle | null {
  if (!isRecord(value)) {
    return null;
  }
  const heightKey = widthKey === "w" ? "h" : "height";
  const left = value["x"];
  const top = value["y"];
  const width = value[widthKey];
  const height = value[heightKey];
  return typeof left === "number" &&
    typeof top === "number" &&
    typeof width === "number" &&
    typeof height === "number"
    ? { x: left, y: top, width, height }
    : null;
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** The text of an MCP result's text content blocks, joined. */
function contentText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result["content"])) {
    return "";
  }
  return result["content"]
    .filter(isRecord)
    .flatMap((block) =>
      block["type"] === "text" && typeof block["text"] === "string" ? [block["text"]] : [],
    )
    .join("\n");
}

/**
 * The structured payload of a successful MCP tool result. A driver reply arrives as structured
 * content, or as JSON in the first text block.
 */
export function structuredPayload(result: unknown): Record<string, unknown> {
  if (isRecord(result) && result["isError"] === true) {
    throw driverFailure(contentText(result));
  }
  if (isRecord(result) && isRecord(result["structuredContent"])) {
    return result["structuredContent"];
  }
  const body = contentText(result);
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    throw new DriverError(
      `The driver answered with something other than JSON: ${body.slice(0, 200)}`,
    );
  }
  throw new DriverError("The driver answered with an unexpected shape.");
}

function driverFailure(message: string): DriverError {
  const trimmed = message.trim();
  const code = trimmed.includes(STALE_ELEMENT_CODE) ? STALE_ELEMENT_CODE : undefined;
  return new DriverError(trimmed.length > 0 ? trimmed : "The driver reported an error.", code);
}

export function parseApps(payload: Record<string, unknown>): readonly DriverApp[] {
  return records(payload["apps"]).flatMap((entry) => {
    const pid = integer(entry, "pid");
    const name = text(entry, "name");
    return pid === null || name === null
      ? []
      : [
          {
            pid,
            name,
            bundleId: text(entry, "bundle_id"),
            running: flag(entry, "running") ?? false,
            active: flag(entry, "active") ?? false,
          },
        ];
  });
}

export function parseWindows(payload: Record<string, unknown>): readonly DriverWindow[] {
  return records(payload["windows"]).flatMap((entry) => {
    const windowId = integer(entry, "window_id");
    const pid = integer(entry, "pid");
    const bounds = rectangle(entry["bounds"], "width");
    return windowId === null || pid === null || bounds === null
      ? []
      : [
          {
            windowId,
            pid,
            appName: text(entry, "app_name") ?? "",
            title: text(entry, "title") ?? "",
            onScreen: flag(entry, "is_on_screen") ?? false,
            minimized: flag(entry, "minimized") ?? false,
            bounds,
          },
        ];
  });
}

function parseElements(value: unknown): readonly DriverElement[] {
  return records(value).flatMap((entry) => {
    const index = integer(entry, "element_index");
    const role = text(entry, "role");
    const depth = integer(entry, "depth");
    return index === null || role === null || depth === null
      ? []
      : [
          {
            index,
            role,
            depth,
            token: text(entry, "element_token"),
            label: text(entry, "label"),
            value: text(entry, "value"),
            enabled: flag(entry, "enabled"),
            selected: flag(entry, "selected"),
            frame: rectangle(entry["frame"], "w"),
          },
        ];
  });
}

export function parseWindowState(payload: Record<string, unknown>): DriverWindowState {
  const pid = integer(payload, "pid");
  const windowId = integer(payload, "window_id");
  if (pid === null || windowId === null) {
    throw new DriverError("The driver's window state named no window.");
  }
  return {
    pid,
    windowId,
    appName: text(payload, "app_name") ?? "",
    windowTitle: text(payload, "window_title") ?? "",
    snapshotId: text(payload, "snapshot_id"),
    elements: parseElements(payload["elements"]),
    elementsComplete: flag(payload, "elements_complete") ?? false,
    degraded: flag(payload, "degraded") ?? false,
    degradedReason: text(payload, "degraded_reason"),
    screenshotPath: text(payload, "screenshot_file_path"),
    screenshotWidth: integer(payload, "screenshot_width"),
    screenshotHeight: integer(payload, "screenshot_height"),
    windowBounds: rectangle(payload["window_bounds"], "width"),
  };
}

const ACTION_EFFECTS: ReadonlySet<string> = new Set([
  "confirmed",
  "partial",
  "unverifiable",
  "suspected_noop",
  "refused",
]);

export function parseActionResult(payload: Record<string, unknown>): DriverActionResult {
  const effect = text(payload, "effect");
  const error = isRecord(payload["error"]) ? payload["error"] : undefined;
  return {
    effect:
      effect !== null && ACTION_EFFECTS.has(effect) ? (effect as ActionEffect) : "unverifiable",
    summary: text(payload, "summary"),
    errorCode: error === undefined ? null : text(error, "code"),
    hint: error === undefined ? null : text(error, "hint"),
  };
}
