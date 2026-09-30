import { describe, expect, test } from "bun:test";
import {
  actionCall,
  CUA_TOOL_NAMES,
  listWindowsCall,
  parseActionResult,
  parseApps,
  parseWindows,
  parseWindowState,
  structuredPayload,
  windowStateCall,
} from "./cua-contract";
import { DriverError, STALE_ELEMENT_CODE } from "./driver";

const target = { pid: 42, windowId: 7 };

describe("driver calls", () => {
  test("asks for a window's tree and, only when wanted, a screenshot written to our path", () => {
    const withoutShot = windowStateCall(target, { maxElements: 10, maxDepth: 4 });
    expect(withoutShot.name).toBe(CUA_TOOL_NAMES.windowState);
    expect(withoutShot.arguments).toMatchObject({
      pid: 42,
      window_id: 7,
      include_accessibility_tree: true,
      include_screenshot: false,
      max_elements: 10,
      max_depth: 4,
    });
    expect("screenshot_out_file" in withoutShot.arguments).toBe(false);

    const withShot = windowStateCall(target, {
      screenshotPath: "/tmp/a.png",
      query: "send",
      maxElements: 10,
      maxDepth: 4,
    });
    expect(withShot.arguments).toMatchObject({
      include_screenshot: true,
      screenshot_out_file: "/tmp/a.png",
      query: "send",
    });
  });

  test("lists only on-screen windows of one app", () => {
    expect(listWindowsCall(9).arguments).toEqual({ pid: 9, on_screen_only: true });
  });

  test("clicks an element through its token, addressed to one exact window", () => {
    expect(
      actionCall({ kind: "click", target, elementToken: "tok", delivery: "background" }),
    ).toEqual({
      name: "click",
      arguments: {
        target: { kind: "window", pid: 42, window_id: 7 },
        element_token: "tok",
        delivery_mode: "background",
      },
    });
  });

  test("clicks a point with coordinates and no element token", () => {
    const call = actionCall({ kind: "click_point", target, x: 3, y: 4, delivery: "foreground" });
    expect(call.arguments).toMatchObject({ x: 3, y: 4, delivery_mode: "foreground" });
    expect("element_token" in call.arguments).toBe(false);
  });

  test("types into an element by pid, window and token", () => {
    expect(
      actionCall({ kind: "type", target, elementToken: "tok", text: "hi", delivery: "background" }),
    ).toEqual({
      name: "type_text",
      arguments: {
        pid: 42,
        window_id: 7,
        element_token: "tok",
        text: "hi",
        delivery_mode: "background",
      },
    });
  });

  test("presses a key with its modifiers", () => {
    expect(
      actionCall({ kind: "key", target, key: "s", modifiers: ["cmd"], delivery: "background" }),
    ).toEqual({
      name: "press_key",
      arguments: { pid: 42, key: "s", modifiers: ["cmd"], delivery_mode: "background" },
    });
  });
});

describe("driver replies", () => {
  test("reads apps, skipping entries without a pid or name", () => {
    const apps = parseApps({
      apps: [
        { pid: 1, name: "Mail", bundle_id: "com.apple.mail", running: true, active: true },
        { name: "No pid" },
        { pid: 2 },
        { pid: 3, name: "NoBundle", running: false, active: false },
      ],
    });
    expect(apps.map((app) => [app.pid, app.bundleId, app.running])).toEqual([
      [1, "com.apple.mail", true],
      [3, null, false],
    ]);
  });

  test("reads windows with their bounds", () => {
    const windows = parseWindows({
      windows: [
        {
          window_id: 7,
          pid: 1,
          app_name: "Mail",
          title: "Inbox",
          bounds: { x: 1, y: 2, width: 3, height: 4 },
          is_on_screen: true,
          z_index: 0,
        },
        { window_id: 8, pid: 1 },
      ],
    });
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ windowId: 7, title: "Inbox", onScreen: true });
  });

  test("reads a window state with its elements and screenshot", () => {
    const state = parseWindowState({
      pid: 1,
      window_id: 7,
      app_name: "Mail",
      window_title: "Inbox",
      snapshot_id: "s",
      elements: [
        {
          element_index: 0,
          role: "AXButton",
          depth: 1,
          element_token: "t",
          label: "Send",
          frame: { x: 1, y: 2, w: 3, h: 4 },
        },
        { element_index: 1, role: "AXStaticText", depth: 1 },
        { role: "AXBroken" },
      ],
      elements_complete: true,
      screenshot_file_path: "/tmp/x.png",
      screenshot_width: 800,
      screenshot_height: 600,
    });
    expect(state.elements).toHaveLength(2);
    expect(state.elements[0]).toMatchObject({
      token: "t",
      label: "Send",
      frame: { x: 1, y: 2, width: 3, height: 4 },
    });
    expect(state.elements[1]?.token).toBeNull();
    expect(state.screenshotPath).toBe("/tmp/x.png");
  });

  test("refuses a window state that names no window", () => {
    expect(() => parseWindowState({ elements: [] })).toThrow(DriverError);
  });

  test("reads an action result, treating an unknown effect as unverifiable", () => {
    expect(
      parseActionResult({ effect: "confirmed", summary: "ok", error: { code: "c", hint: "h" } }),
    ).toEqual({ effect: "confirmed", summary: "ok", errorCode: "c", hint: "h" });
    expect(parseActionResult({ effect: "mystery" }).effect).toBe("unverifiable");
  });
});

describe("structuredPayload", () => {
  test("prefers structured content", () => {
    expect(structuredPayload({ structuredContent: { a: 1 }, content: [] })).toEqual({ a: 1 });
  });

  test("falls back to JSON in the first text block", () => {
    expect(structuredPayload({ content: [{ type: "text", text: '{"b":2}' }] })).toEqual({ b: 2 });
  });

  test("turns a tool error into a driver error that carries the stale-element code", () => {
    try {
      structuredPayload({
        isError: true,
        content: [{ type: "text", text: `${STALE_ELEMENT_CODE}: re-snapshot the window` }],
      });
      throw new Error("expected a failure");
    } catch (error) {
      expect(error).toBeInstanceOf(DriverError);
      expect((error as DriverError).code).toBe(STALE_ELEMENT_CODE);
    }
  });

  test("rejects a reply that is not JSON", () => {
    expect(() => structuredPayload({ content: [{ type: "text", text: "nope" }] })).toThrow(
      "other than JSON",
    );
  });
});
