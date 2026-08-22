import { describe, expect, test } from "bun:test";
import { getPresentationConfig } from "./app-layer";

describe("getPresentationConfig", () => {
  const terminalEnvironment = { TERM: "xterm-256color" };
  const terminalOutput = { isTTY: true, columns: 100, rows: 24 };
  const terminalInput = { isTTY: true };

  test("capable TTY uses the interactive presentation", () => {
    const config = getPresentationConfig(terminalEnvironment, terminalOutput, terminalInput);
    expect(config.isQuiet).toBe(false);
    expect(config.usePlainTerminal).toBe(false);
    expect(config.useCLIPresentation).toBe(false);
    expect(config.useFullscreen).toBe(true);
  });

  test("JAZZ_NO_TUI=1 keeps the legacy interactive interface", () => {
    const config = getPresentationConfig(
      { ...terminalEnvironment, JAZZ_NO_TUI: "1" },
      terminalOutput,
      terminalInput,
    );
    expect(config.isQuiet).toBe(false);
    expect(config.usePlainTerminal).toBe(false);
    expect(config.useCLIPresentation).toBe(false);
    expect(config.useFullscreen).toBe(false);
  });

  test("JAZZ_OUTPUT_MODE=quiet forces plain terminal and quiet presentation", () => {
    const config = getPresentationConfig(
      { ...terminalEnvironment, JAZZ_OUTPUT_MODE: "quiet" },
      terminalOutput,
      terminalInput,
    );
    expect(config.isQuiet).toBe(true);
    expect(config.usePlainTerminal).toBe(true);
    expect(config.useCLIPresentation).toBe(false);
    expect(config.useFullscreen).toBe(false);
  });

  test("non-TTY uses plain terminal and CLI presentation", () => {
    const config = getPresentationConfig(terminalEnvironment, { isTTY: false }, terminalInput);
    expect(config.isQuiet).toBe(false);
    expect(config.usePlainTerminal).toBe(true);
    expect(config.useCLIPresentation).toBe(true);
    expect(config.useFullscreen).toBe(false);
  });

  test("terminal below the fullscreen geometry uses plain output", () => {
    const short = getPresentationConfig(
      terminalEnvironment,
      { ...terminalOutput, rows: 11 },
      terminalInput,
    );
    const narrow = getPresentationConfig(
      terminalEnvironment,
      { ...terminalOutput, columns: 59 },
      terminalInput,
    );
    expect(short.usePlainTerminal).toBe(true);
    expect(short.useCLIPresentation).toBe(true);
    expect(short.useFullscreen).toBe(false);
    expect(narrow.usePlainTerminal).toBe(true);
    expect(narrow.useCLIPresentation).toBe(true);
    expect(narrow.useFullscreen).toBe(false);
  });

  test("CI, dumb terminals, and screen readers use plain output", () => {
    const environments = [
      { ...terminalEnvironment, CI: "1" },
      { TERM: "dumb" },
      { ...terminalEnvironment, INK_SCREEN_READER: "1" },
      { ...terminalEnvironment, JAZZ_A11Y: "1" },
    ];
    for (const environment of environments) {
      const config = getPresentationConfig(environment, terminalOutput, terminalInput);
      expect(config.usePlainTerminal).toBe(true);
      expect(config.useCLIPresentation).toBe(true);
      expect(config.useFullscreen).toBe(false);
    }
  });

  test("explicit fullscreen opt-out keeps the legacy interactive interface", () => {
    const environments = [
      { ...terminalEnvironment, JAZZ_FULLSCREEN: "0" },
      { ...terminalEnvironment, JAZZ_FULLSCREEN: "false" },
    ];
    for (const environment of environments) {
      const config = getPresentationConfig(environment, terminalOutput, terminalInput);
      expect(config.usePlainTerminal).toBe(false);
      expect(config.useCLIPresentation).toBe(false);
      expect(config.useFullscreen).toBe(false);
    }
  });

  test("raw output uses append-only CLI presentation", () => {
    const config = getPresentationConfig(
      { ...terminalEnvironment, JAZZ_OUTPUT_MODE: "raw" },
      terminalOutput,
      terminalInput,
    );
    expect(config.usePlainTerminal).toBe(true);
    expect(config.useCLIPresentation).toBe(true);
    expect(config.useFullscreen).toBe(false);
  });

  test("non-TTY stdin uses plain output even when stdout is a TTY", () => {
    const config = getPresentationConfig(terminalEnvironment, terminalOutput, { isTTY: false });
    expect(config.usePlainTerminal).toBe(true);
    expect(config.useCLIPresentation).toBe(true);
    expect(config.useFullscreen).toBe(false);
  });
});
