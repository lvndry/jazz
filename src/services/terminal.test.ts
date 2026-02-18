import { describe, expect, test } from "bun:test";
import { INK_RENDER_OPTIONS } from "./terminal";

describe("INK_RENDER_OPTIONS", () => {
  /**
   * Regression: incrementalRendering breaks Ink's interactive components.
   *
   * When enabled, Ink's Yoga layout engine miscomputes available widths,
   * causing:
   *   - Select/wizard prompts to break (arrow keys emit newlines instead
   *     of navigating)
   *   - Multi-line ANSI content (diffs) to be aggressively truncated or
   *     completely invisible
   *
   * See: https://github.com/anomalyco/jazz/issues/XXX
   */
  test("must NOT enable incrementalRendering", () => {
    expect(INK_RENDER_OPTIONS).not.toHaveProperty("incrementalRendering");
  });

  test("must disable patchConsole to prevent flickering", () => {
    expect(INK_RENDER_OPTIONS.patchConsole).toBe(false);
  });

  test("must disable exitOnCtrlC so app handles SIGINT", () => {
    expect(INK_RENDER_OPTIONS.exitOnCtrlC).toBe(false);
  });
});
