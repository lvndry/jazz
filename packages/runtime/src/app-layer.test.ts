import { InteractiveTerminalRequiredError } from "@jazz/core/types/errors";
import { describe, expect, test } from "bun:test";
import { exitCodeForFailure, getPresentationConfig } from "./app-layer";

describe("getPresentationConfig", () => {
  const terminalEnvironment = { TERM: "xterm-256color" };
  const terminalOutput = { isTTY: true, columns: 100, rows: 24 };
  const terminalInput = { isTTY: true };

  test("a session on a capable TTY uses the alternate screen", () => {
    const config = getPresentationConfig(terminalEnvironment, terminalOutput, terminalInput, true);
    expect(config.isQuiet).toBe(false);
    expect(config.usePlainTerminal).toBe(false);
    expect(config.useCLIPresentation).toBe(false);
    expect(config.useFullscreen).toBe(true);
  });

  test("print-and-exit keeps Ink on the main screen so output stays in scrollback", () => {
    const config = getPresentationConfig(terminalEnvironment, terminalOutput, terminalInput);
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
    );
    expect(config.isQuiet).toBe(false);
    expect(config.usePlainTerminal).toBe(true);
    expect(config.useCLIPresentation).toBe(true);
    expect(config.useFullscreen).toBe(false);
  });

  test("a terminal below the compact floor keeps the classic interactive interface", () => {
    const short = getPresentationConfig(
      terminalEnvironment,
      { ...terminalOutput, rows: 9 },
      terminalInput,
      true,
    );
    const narrow = getPresentationConfig(
      terminalEnvironment,
      { ...terminalOutput, columns: 31 },
      terminalInput,
      true,
    );
    for (const config of [short, narrow]) {
      expect(config.usePlainTerminal).toBe(false);
      expect(config.useCLIPresentation).toBe(false);
      expect(config.useFullscreen).toBe(false);
    }
  });

  test("a compact terminal still gets the fullscreen conversation", () => {
    const config = getPresentationConfig(
      terminalEnvironment,
      { ...terminalOutput, columns: 32, rows: 10 },
      terminalInput,
      true,
    );
    expect(config.usePlainTerminal).toBe(false);
    expect(config.useCLIPresentation).toBe(false);
    expect(config.useFullscreen).toBe(true);
  });

  test("CI, dumb terminals, and screen readers keep the classic interactive interface", () => {
    const environments = [
      { ...terminalEnvironment, CI: "1" },
      { TERM: "dumb" },
      { ...terminalEnvironment, INK_SCREEN_READER: "1" },
      { ...terminalEnvironment, JAZZ_A11Y: "1" },
    ];
    for (const environment of environments) {
      const config = getPresentationConfig(environment, terminalOutput, terminalInput, true);
      expect(config.usePlainTerminal).toBe(false);
      expect(config.useCLIPresentation).toBe(false);
      expect(config.useFullscreen).toBe(false);
    }
  });

  test("explicit fullscreen opt-out keeps the legacy interactive interface", () => {
    const environments = [
      { ...terminalEnvironment, JAZZ_FULLSCREEN: "0" },
      { ...terminalEnvironment, JAZZ_FULLSCREEN: "false" },
    ];
    for (const environment of environments) {
      const config = getPresentationConfig(environment, terminalOutput, terminalInput, true);
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
    const config = getPresentationConfig(
      terminalEnvironment,
      terminalOutput,
      { isTTY: false },
      true,
    );
    expect(config.usePlainTerminal).toBe(true);
    expect(config.useCLIPresentation).toBe(true);
    expect(config.useFullscreen).toBe(false);
  });

  test("a fullscreen opt-out without a terminal still uses plain output", () => {
    const config = getPresentationConfig(
      { ...terminalEnvironment, JAZZ_FULLSCREEN: "0" },
      { isTTY: false },
      terminalInput,
      true,
    );
    expect(config.usePlainTerminal).toBe(true);
    expect(config.useCLIPresentation).toBe(true);
    expect(config.useFullscreen).toBe(false);
  });
});

describe("exitCodeForFailure", () => {
  test("an interactive command without a terminal exits 2", () => {
    const error = new InteractiveTerminalRequiredError({
      command: "jazz agent create",
      message: "it asks questions.",
      suggestion: "Run it in a terminal.",
    });
    expect(exitCodeForFailure(error)).toBe(2);
  });

  test("any other failure exits 1", () => {
    expect(exitCodeForFailure(new Error("boom"))).toBe(1);
  });

  test("Ctrl+C during a prompt leaves the exit code alone", () => {
    const cancellation = new Error("aborted");
    cancellation.name = "ExitPromptError";
    expect(exitCodeForFailure(cancellation)).toBeUndefined();
  });
});
