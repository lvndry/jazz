import { describe, expect, test } from "bun:test";
import { getPresentationConfig } from "./app-layer";

describe("getPresentationConfig", () => {
  const terminalEnvironment = { TERM: "xterm-256color" };
  const terminalOutput = { isTTY: true, columns: 100, rows: 24 };
  const terminalInput = { isTTY: true };
  const bunRuntime = { isBun: true };
  const nodeRuntime = { isBun: false };

  test("a session on a capable TTY uses the alternate screen", () => {
    const config = getPresentationConfig(
      terminalEnvironment,
      terminalOutput,
      terminalInput,
      true,
      bunRuntime,
    );
    expect(config.isQuiet).toBe(false);
    expect(config.usePlainTerminal).toBe(false);
    expect(config.useCLIPresentation).toBe(false);
    expect(config.useFullscreen).toBe(true);
  });

  test("print-and-exit keeps Ink on the main screen so output stays in scrollback", () => {
    const config = getPresentationConfig(
      terminalEnvironment,
      terminalOutput,
      terminalInput,
      false,
      bunRuntime,
    );
    expect(config.isQuiet).toBe(false);
    expect(config.usePlainTerminal).toBe(false);
    expect(config.useCLIPresentation).toBe(false);
    expect(config.useFullscreen).toBe(false);
  });

  // `jazz run` and `jazz workflow --json` set JAZZ_NO_TUI to keep stdout clean
  // for their payload, so this has to stay a *plain* terminal even on a capable
  // TTY — an interactive interface here would render over the JSON.
  test("JAZZ_NO_TUI=1 forces plain terminal and CLI presentation", () => {
    const config = getPresentationConfig(
      { ...terminalEnvironment, JAZZ_NO_TUI: "1" },
      terminalOutput,
      terminalInput,
      true,
      bunRuntime,
    );
    expect(config.isQuiet).toBe(false);
    expect(config.usePlainTerminal).toBe(true);
    expect(config.useCLIPresentation).toBe(true);
    expect(config.useFullscreen).toBe(false);
  });

  test("JAZZ_OUTPUT_MODE=quiet forces plain terminal and quiet presentation", () => {
    const config = getPresentationConfig(
      { ...terminalEnvironment, JAZZ_OUTPUT_MODE: "quiet" },
      terminalOutput,
      terminalInput,
      false,
      bunRuntime,
    );
    expect(config.isQuiet).toBe(true);
    expect(config.usePlainTerminal).toBe(true);
    expect(config.useCLIPresentation).toBe(false);
    expect(config.useFullscreen).toBe(false);
  });

  test("non-TTY uses plain terminal and CLI presentation", () => {
    const config = getPresentationConfig(
      terminalEnvironment,
      { isTTY: false },
      terminalInput,
      true,
      bunRuntime,
    );
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
      true,
      bunRuntime,
    );
    const narrow = getPresentationConfig(
      terminalEnvironment,
      { ...terminalOutput, columns: 59 },
      terminalInput,
      true,
      bunRuntime,
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
      const config = getPresentationConfig(
        environment,
        terminalOutput,
        terminalInput,
        true,
        bunRuntime,
      );
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
      const config = getPresentationConfig(
        environment,
        terminalOutput,
        terminalInput,
        true,
        bunRuntime,
      );
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
      false,
      bunRuntime,
    );
    expect(config.usePlainTerminal).toBe(true);
    expect(config.useCLIPresentation).toBe(true);
    expect(config.useFullscreen).toBe(false);
  });

  test("non-TTY stdin uses plain output even when stdout is a TTY", () => {
    const config = getPresentationConfig(
      terminalEnvironment,
      terminalOutput,
      { isTTY: false },
      true,
      bunRuntime,
    );
    expect(config.usePlainTerminal).toBe(true);
    expect(config.useCLIPresentation).toBe(true);
    expect(config.useFullscreen).toBe(false);
  });

  test("node-based installs do not request fullscreen", () => {
    const config = getPresentationConfig(
      terminalEnvironment,
      terminalOutput,
      terminalInput,
      true,
      nodeRuntime,
    );
    expect(config.useFullscreen).toBe(false);
    expect(config.usePlainTerminal).toBe(false);
    expect(config.useCLIPresentation).toBe(false);
  });
});
