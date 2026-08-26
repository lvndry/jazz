import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { resolveTerminalNotifierBinary } from "./terminal-notifier-path";

const originalPlatform = process.platform;
const originalArch = process.arch;
const originalEnv = { ...process.env };

let tempDirectory: string | null = null;

function createTempDirectory(): string {
  tempDirectory = join(tmpdir(), `jazz-notifier-test-${Date.now()}`);
  mkdirSync(tempDirectory, { recursive: true });
  return tempDirectory;
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  Object.defineProperty(process, "arch", { value: originalArch });
  process.env = { ...originalEnv };

  if (tempDirectory) {
    rmSync(tempDirectory, { recursive: true, force: true });
    tempDirectory = null;
  }
});

describe("resolveTerminalNotifierBinary", () => {
  test("returns null on non-macOS platforms", () => {
    Object.defineProperty(process, "platform", { value: "linux" });

    expect(resolveTerminalNotifierBinary()).toBeNull();
  });

  test("prefers JAZZ_TERMINAL_NOTIFIER when set", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    Object.defineProperty(process, "arch", { value: "arm64" });

    const directory = createTempDirectory();
    const binaryPath = join(directory, "terminal-notifier");
    writeFileSync(binaryPath, "");

    process.env["JAZZ_TERMINAL_NOTIFIER"] = binaryPath;
    delete process.env["TERMINAL_NOTIFIER"];

    expect(resolveTerminalNotifierBinary()).toBe(binaryPath);
  });

  test("uses Jazz bundled native binary on Apple Silicon", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    Object.defineProperty(process, "arch", { value: "arm64" });

    delete process.env["JAZZ_TERMINAL_NOTIFIER"];
    delete process.env["TERMINAL_NOTIFIER"];

    const bundledPath = join(
      process.cwd(),
      "vendor/terminal-notifier/arm64/terminal-notifier.app/Contents/MacOS/terminal-notifier",
    );

    if (existsSync(bundledPath)) {
      expect(resolveTerminalNotifierBinary()).toBe(bundledPath);
    }
  });

  test("uses Jazz bundled native binary on Intel Macs", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    Object.defineProperty(process, "arch", { value: "x64" });

    delete process.env["JAZZ_TERMINAL_NOTIFIER"];
    delete process.env["TERMINAL_NOTIFIER"];

    const bundledPath = join(
      process.cwd(),
      "vendor/terminal-notifier/x64/terminal-notifier.app/Contents/MacOS/terminal-notifier",
    );

    if (existsSync(bundledPath)) {
      expect(resolveTerminalNotifierBinary()).toBe(bundledPath);
    }
  });
});
