import { afterEach, describe, expect, test } from "bun:test";
import { getTerminalBundleId } from "./terminal-bundle-id";

const originalPlatform = process.platform;
const originalEnv = { ...process.env };

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  process.env = { ...originalEnv };
});

describe("getTerminalBundleId", () => {
  test("returns undefined on non-macOS platforms", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env["TERM_PROGRAM"] = "WarpTerminal";

    expect(getTerminalBundleId()).toBeUndefined();
  });

  test("detects Warp", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    process.env["TERM_PROGRAM"] = "WarpTerminal";

    expect(getTerminalBundleId()).toBe("dev.warp.Warp-Stable");
  });

  test("detects iTerm2", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    process.env["TERM_PROGRAM"] = "iTerm.app";

    expect(getTerminalBundleId()).toBe("com.googlecode.iterm2");
  });

  test("detects Terminal.app", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    process.env["TERM_PROGRAM"] = "Apple_Terminal";

    expect(getTerminalBundleId()).toBe("com.apple.Terminal");
  });

  test("detects VS Code integrated terminal", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    process.env["TERM_PROGRAM"] = "vscode";

    expect(getTerminalBundleId()).toBe("com.microsoft.VSCode");
  });

  test("detects Kitty via KITTY_WINDOW_ID", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    delete process.env["TERM_PROGRAM"];
    process.env["KITTY_WINDOW_ID"] = "1";

    expect(getTerminalBundleId()).toBe("net.kovidgoyal.kitty");
  });

  test("detects Alacritty via TERM", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    delete process.env["TERM_PROGRAM"];
    delete process.env["KITTY_WINDOW_ID"];
    process.env["TERM"] = "alacritty";

    expect(getTerminalBundleId()).toBe("org.alacritty");
  });

  test("returns undefined for unknown terminals", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    delete process.env["TERM_PROGRAM"];
    delete process.env["KITTY_WINDOW_ID"];
    process.env["TERM"] = "xterm-256color";

    expect(getTerminalBundleId()).toBeUndefined();
  });
});
