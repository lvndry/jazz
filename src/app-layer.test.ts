import { describe, expect, test } from "bun:test";
import { getPresentationConfig } from "./app-layer";

describe("getPresentationConfig", () => {
  test("default TTY uses Ink terminal and Ink presentation", () => {
    const c = getPresentationConfig({}, { isTTY: true, rows: 24 });
    expect(c.isQuiet).toBe(false);
    expect(c.usePlainTerminal).toBe(false);
    expect(c.useCLIPresentation).toBe(false);
  });

  test("JAZZ_NO_TUI=1 forces plain terminal and CLI presentation", () => {
    const c = getPresentationConfig({ JAZZ_NO_TUI: "1" }, { isTTY: true, rows: 24 });
    expect(c.isQuiet).toBe(false);
    expect(c.usePlainTerminal).toBe(true);
    expect(c.useCLIPresentation).toBe(true);
  });

  test("JAZZ_OUTPUT_MODE=quiet forces plain terminal and quiet presentation", () => {
    const c = getPresentationConfig({ JAZZ_OUTPUT_MODE: "quiet" }, { isTTY: true, rows: 24 });
    expect(c.isQuiet).toBe(true);
    expect(c.usePlainTerminal).toBe(true);
    expect(c.useCLIPresentation).toBe(false);
  });

  test("non-TTY uses CLI presentation (terminal layer handles Plain internally)", () => {
    const c = getPresentationConfig({}, { isTTY: false });
    expect(c.isQuiet).toBe(false);
    expect(c.useCLIPresentation).toBe(true);
    // usePlainTerminal is for explicit override; createTerminalServiceLayer returns Plain when !isTTY
    expect(c.usePlainTerminal).toBe(false);
  });

  test("small terminal (rows < 10) with TTY forces plain and CLI", () => {
    const c = getPresentationConfig({}, { isTTY: true, rows: 8 });
    expect(c.isQuiet).toBe(false);
    expect(c.usePlainTerminal).toBe(true);
    expect(c.useCLIPresentation).toBe(true);
  });

  test("rows 10 or more with TTY uses Ink", () => {
    const c = getPresentationConfig({}, { isTTY: true, rows: 10 });
    expect(c.usePlainTerminal).toBe(false);
    expect(c.useCLIPresentation).toBe(false);
  });

  test("rows undefined falls back to 24 for small-terminal check", () => {
    const c = getPresentationConfig({}, { isTTY: true });
    expect(c.usePlainTerminal).toBe(false);
  });
});
