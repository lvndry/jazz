import { describe, expect, test } from "bun:test";
import type { DriverElement, DriverWindowState } from "./driver";
import {
  buildObservation,
  frameCenter,
  makeRef,
  MAX_OBSERVED_ELEMENTS,
  parseRef,
} from "./observation";

function element(index: number, overrides: Partial<DriverElement> = {}): DriverElement {
  return {
    index,
    role: "AXButton",
    depth: 0,
    token: `tok-${String(index)}`,
    label: `Button ${String(index)}`,
    value: null,
    enabled: true,
    selected: false,
    frame: { x: 0, y: 0, width: 10, height: 10 },
    ...overrides,
  };
}

function state(
  elements: readonly DriverElement[],
  overrides: Partial<DriverWindowState> = {},
): DriverWindowState {
  return {
    pid: 1,
    windowId: 7,
    appName: "Mail",
    windowTitle: "Inbox",
    snapshotId: "s",
    elements,
    elementsComplete: true,
    degraded: false,
    degradedReason: null,
    screenshotPath: null,
    screenshotWidth: null,
    screenshotHeight: null,
    windowBounds: null,
    ...overrides,
  };
}

describe("refs", () => {
  test("name the observation they came from", () => {
    expect(makeRef(3, 12)).toBe("c3.12");
    expect(parseRef("c3.12")).toEqual({ generation: 3, index: 12 });
    expect(parseRef(" c3.12 ")).toEqual({ generation: 3, index: 12 });
  });

  test("reject anything that is not a ref", () => {
    for (const text of ["3.12", "c3", "c3.x", "e3", "c3.12.4", ""]) {
      expect(parseRef(text)).toBeUndefined();
    }
  });
});

describe("buildObservation", () => {
  test("mints a ref for every addressable element of a full-control window", () => {
    const observation = buildObservation({
      generation: 2,
      state: state([element(0), element(1, { token: null })]),
      bundleId: "com.apple.mail",
      tier: "full",
    });
    expect([...observation.elements.keys()]).toEqual(["c2.0"]);
    expect(observation.text).toContain('AXButton "Button 0" [ref=c2.0]');
    expect(observation.text).not.toContain("[ref=c2.1]");
    expect(observation.text).toContain("access: full control");
  });

  test("mints no ref at all for a view-only window, so there is nothing in it to act on", () => {
    const observation = buildObservation({
      generation: 1,
      state: state([element(0), element(1)]),
      bundleId: "com.apple.Safari",
      tier: "view-only",
    });
    expect(observation.elements.size).toBe(0);
    expect(observation.text).not.toContain("[ref=");
    expect(observation.text).toContain("view-only");
  });

  test("never shows the value of a secure text field", () => {
    const observation = buildObservation({
      generation: 1,
      state: state([
        element(0, { role: "AXSecureTextField", label: "Password", value: "hunter2" }),
        element(1, { role: "AXTextField", label: "Subject", value: "Hello" }),
      ]),
      bundleId: "com.apple.mail",
      tier: "full",
    });
    expect(observation.text).not.toContain("hunter2");
    expect(observation.text).toContain("secure field");
    expect(observation.text).toContain('value="Hello"');
    expect(observation.elements.get("c1.0")?.secure).toBe(true);
  });

  test("collapses whitespace and shortens long labels", () => {
    const observation = buildObservation({
      generation: 1,
      state: state([element(0, { label: `a\n\nb ${"x".repeat(500)}` })]),
      bundleId: "com.apple.mail",
      tier: "full",
    });
    const line = observation.text.split("\n").find((candidate) => candidate.includes("AXButton"));
    expect(line).toBeDefined();
    expect(line).not.toContain("\n");
    expect((line ?? "").length).toBeLessThan(200);
    expect(line).toContain("…");
  });

  test("lists at most the cap and says the window is partial", () => {
    const elements = Array.from({ length: MAX_OBSERVED_ELEMENTS + 20 }, (_, index) =>
      element(index),
    );
    const observation = buildObservation({
      generation: 1,
      state: state(elements),
      bundleId: "com.apple.mail",
      tier: "full",
    });
    expect(observation.elements.size).toBe(MAX_OBSERVED_ELEMENTS);
    expect(observation.text).toContain("partial");
  });

  test("reports the screenshot path and size, and a degraded window's limits", () => {
    const observation = buildObservation({
      generation: 1,
      state: state([], {
        screenshotPath: "/tmp/w.png",
        screenshotWidth: 800,
        screenshotHeight: 600,
        degraded: true,
        degradedReason: "canvas",
      }),
      bundleId: "com.apple.mail",
      tier: "full",
    });
    expect(observation.screenshot).toEqual({ path: "/tmp/w.png", width: 800, height: 600 });
    expect(observation.text).toContain("screenshot: /tmp/w.png (800x600 px)");
    expect(observation.text).toContain("little accessibility data (canvas)");
  });
});

describe("frameCenter", () => {
  test("is the middle of the frame", () => {
    expect(frameCenter({ x: 10, y: 20, width: 40, height: 10 })).toEqual({ x: 30, y: 25 });
  });
});
