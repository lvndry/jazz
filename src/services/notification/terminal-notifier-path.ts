import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getPackageRootDirectory } from "@/core/utils/runtime-detection";

const HOMEBREW_PATHS = [
  "/opt/homebrew/bin/terminal-notifier",
  "/usr/local/bin/terminal-notifier",
] as const;

function bundledJazzTerminalNotifierBinary(): string | null {
  const packageRoot = getPackageRootDirectory();
  if (!packageRoot) {
    return null;
  }

  const architectureDirectory = process.arch === "arm64" ? "arm64" : "x64";
  const binaryPath = join(
    packageRoot,
    "vendor/terminal-notifier",
    architectureDirectory,
    "terminal-notifier.app/Contents/MacOS/terminal-notifier",
  );

  if (existsSync(binaryPath)) {
    return binaryPath;
  }

  return null;
}

function findTerminalNotifierOnPath(): string | null {
  try {
    const result = execFileSync("which", ["terminal-notifier"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (result.length > 0 && existsSync(result)) {
      return result;
    }
  } catch {
    // not on PATH
  }

  return null;
}

/**
 * Resolve a native terminal-notifier binary for macOS notifications.
 *
 * Jazz ships architecture-matched binaries so users do not need Homebrew or Rosetta.
 */
export function resolveTerminalNotifierBinary(): string | null {
  if (process.platform !== "darwin") {
    return null;
  }

  const envOverride = process.env["JAZZ_TERMINAL_NOTIFIER"] ?? process.env["TERMINAL_NOTIFIER"];
  if (envOverride && existsSync(envOverride)) {
    return envOverride;
  }

  const bundledBinary = bundledJazzTerminalNotifierBinary();
  if (bundledBinary) {
    return bundledBinary;
  }

  const pathBinary = findTerminalNotifierOnPath();
  if (pathBinary) {
    return pathBinary;
  }

  for (const homebrewPath of HOMEBREW_PATHS) {
    if (existsSync(homebrewPath)) {
      return homebrewPath;
    }
  }

  return null;
}
