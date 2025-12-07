import { Effect } from "effect";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Runtime detection utilities for determining execution context
 */

/**
 * Check if a normalized path indicates a global package manager installation
 * This is the core detection logic shared between sync and async functions
 *
 * @param normalizedPath - A normalized path (lowercase, forward slashes)
 * @returns The package manager name ("bun", "pnpm", "npm") or null if not detected
 */
export function detectPackageManagerFromPath(
  normalizedPath: string,
): "bun" | "pnpm" | "npm" | null {
  // Check for bun installation paths
  // Bun typically installs to: ~/.bun/bin/jazz or similar
  if (normalizedPath.includes("/.bun/") || normalizedPath.includes("\\bun\\")) {
    return "bun";
  }

  // Check for pnpm installation paths
  // pnpm typically installs to: ~/.local/share/pnpm/global/5/node_modules/.bin/jazz
  // or ~/.pnpm-global/ or similar
  if (
    normalizedPath.includes("/pnpm/") ||
    normalizedPath.includes("\\pnpm\\") ||
    normalizedPath.includes("/.pnpm") ||
    normalizedPath.includes("\\.pnpm")
  ) {
    return "pnpm";
  }

  // Check for npm installation paths
  // npm typically installs to:
  // - /usr/local/bin/jazz (standard Unix location)
  // - ~/.npm-global/bin/jazz (custom npm global)
  // - node_modules/.bin/jazz in global node_modules
  // - Windows: AppData\Roaming\npm\jazz.cmd
  if (
    normalizedPath.includes("/npm/") ||
    normalizedPath.includes("\\npm\\") ||
    normalizedPath.includes("/.npm") ||
    normalizedPath.includes("\\.npm") ||
    normalizedPath.includes("/node_modules/.bin/") ||
    normalizedPath.includes("\\node_modules\\.bin\\") ||
    normalizedPath.includes("appdata/roaming/npm") ||
    normalizedPath.includes("appdata\\roaming\\npm")
  ) {
    return "npm";
  }

  // Check if it's in a standard bin directory (likely npm)
  // Common locations: /usr/local/bin, /usr/bin, ~/.local/bin
  // But exclude bun and pnpm specific directories
  if (
    (normalizedPath.includes("/usr/local/bin/") ||
      normalizedPath.includes("/usr/bin/") ||
      normalizedPath.includes("/.local/bin/")) &&
    !normalizedPath.includes("/.bun/") &&
    !normalizedPath.includes("/pnpm/") &&
    !normalizedPath.includes("/.pnpm")
  ) {
    return "npm";
  }

  // Cannot determine from path - return null
  return null;
}

/**
 * Find where the jazz command is installed
 * Returns the full path to the jazz executable, or null if not found
 *
 * @returns Effect that resolves to the executable path or null
 *
 * @example
 * ```typescript
 * const path = yield* findJazzInstallationPath();
 * // path could be "/Users/user/.bun/bin/jazz" or null
 * ```
 */
export function findJazzInstallationPath(): Effect.Effect<string | null, never> {
  return Effect.gen(function* () {
    const { spawn } = yield* Effect.promise(() => import("child_process"));
    const isWindows = process.platform === "win32";
    const checkCommand = isWindows ? "where" : "which";

    return yield* Effect.async<string | null, never>((resume) => {
      const child = spawn(checkCommand, ["jazz"], {
        stdio: ["ignore", "pipe", "ignore"],
        shell: true,
      });

      let stdout = "";

      if (child.stdout) {
        child.stdout.on("data", (data: Buffer) => {
          stdout += data.toString();
        });
      }

      child.on("close", (code) => {
        if (code === 0 && stdout.trim()) {
          // Found the path (take first line in case of multiple matches)
          const lines = stdout.trim().split("\n");
          const path = lines[0]?.trim();

          if (path) {
            resume(Effect.succeed(path));
          } else {
            resume(Effect.succeed(null));
          }
        } else {
          // Command not found
          resume(Effect.succeed(null));
        }
      });

      child.on("error", () => {
        // Command not found
        resume(Effect.succeed(null));
      });
    });
  });
}

/**
 * Detect which package manager was used to install Jazz based on installation path
 * Returns the package manager name or null if cannot be determined
 *
 * @param installPath - The full path to the installed executable
 * @returns Effect that resolves to the package manager name ("bun", "pnpm", "npm") or null
 *
 * @example
 * ```typescript
 * const pm = yield* detectInstalledPackageManager("/usr/local/bin/jazz");
 * // pm could be "npm", "pnpm", "bun", or null
 * ```
 */
export function detectInstalledPackageManager(
  installPath: string,
): Effect.Effect<string | null, never> {
  return Effect.gen(function* () {
    const fs = yield* Effect.promise(() => import("fs"));

    // Try to resolve symlinks to get the actual path
    const resolvedPath = yield* Effect.gen(function* () {
      const statsResult = yield* Effect.tryPromise({
        try: () => fs.promises.lstat(installPath),
        catch: () => new Error("Cannot stat file"),
      }).pipe(Effect.catchAll(() => Effect.succeed(null)));

      if (statsResult && statsResult.isSymbolicLink()) {
        const realPathResult = yield* Effect.tryPromise({
          try: () => fs.promises.realpath(installPath),
          catch: () => new Error("Cannot resolve symlink"),
        }).pipe(Effect.catchAll(() => Effect.succeed(installPath)));
        return realPathResult;
      }

      return installPath;
    });

    const normalizedPath = resolvedPath.toLowerCase().replace(/\\/g, "/");

    return detectPackageManagerFromPath(normalizedPath);
  });
}

/**
 * Check if a path indicates a global package manager installation
 * Uses the same detection logic as detectInstalledPackageManager
 */
function isGlobalInstallationPath(installPath: string): boolean {
  let resolvedPath = installPath;

  // Try to resolve symlinks to get the actual path
  try {
    const stats = fs.lstatSync(installPath);
    if (stats.isSymbolicLink()) {
      try {
        resolvedPath = fs.realpathSync(installPath);
      } catch {
        // If we can't resolve the symlink, use the original path
        resolvedPath = installPath;
      }
    }
  } catch {
    // If we can't stat the file, use the original path
    resolvedPath = installPath;
  }

  const normalizedPath = resolvedPath.toLowerCase().replace(/\\/g, "/");

  // Use the shared detection logic
  return detectPackageManagerFromPath(normalizedPath) !== null;
}

/**
 * Detect if the CLI is running from a global npm/pnpm/bun/yarn installation
 *
 * This is useful for determining whether to use user-specific directories
 * (like ~/.jazz/logs) or local development directories (like ./logs)
 *
 * First tries to check the actual executable path (process.argv[1]), then
 * falls back to checking the script directory (__dirname).
 *
 * @returns true if running from a global package installation, false otherwise
 *
 * @example
 * ```typescript
 * if (isInstalledGlobally()) {
 *   // Use ~/.jazz/logs for production
 * } else {
 *   // Use ./logs for development
 * }
 * ```
 */
export function isInstalledGlobally(): boolean {
  // First, try to check the actual executable path (process.argv[1])
  // This is the path to the script being executed, which could be a symlink
  // to the actual executable (e.g., /Users/user/.bun/bin/jazz)
  if (process.argv[1]) {
    try {
      if (isGlobalInstallationPath(process.argv[1])) {
        return true;
      }
    } catch {
      // If we can't check the executable path, fall through to __dirname check
    }
  }

  // Fallback: Check the directory where the current script is located
  const scriptPath = __dirname;

  // Common global installation paths for different package managers
  const globalPaths = [
    // npm global paths
    "/usr/local/lib/node_modules",
    "/usr/lib/node_modules",
    path.join(os.homedir(), ".npm-global"),
    path.join(os.homedir(), ".npm-packages"),
    // pnpm global paths
    path.join(os.homedir(), ".local/share/pnpm"),
    path.join(os.homedir(), ".pnpm-global"),
    // bun global paths
    path.join(os.homedir(), ".bun/bin"),
    // yarn global paths
    path.join(os.homedir(), ".yarn/bin"),
    path.join(os.homedir(), ".config/yarn/global"),
  ];

  // Check if script path contains any global installation directory
  // Also check for 'node_modules' in path but not in current working directory
  // (indicates installed package vs local development)
  const isInGlobalPath = globalPaths.some((globalPath) => scriptPath.includes(globalPath));
  const isInNodeModules =
    scriptPath.includes("node_modules") && !scriptPath.startsWith(process.cwd());

  return isInGlobalPath || isInNodeModules;
}

/**
 * Check if running in development mode
 *
 * @returns true if running in local development, false if in production/global install
 */
export function isDevelopmentMode(): boolean {
  return !isInstalledGlobally();
}

/**
 * Resolve the default directory where Jazz should persist user data
 * Falls back to the current working directory when not installed globally
 */
export function getDefaultDataDirectory(): string {
  if (isInstalledGlobally()) {
    const homeDir = os.homedir();
    if (homeDir && homeDir.trim().length > 0) {
      return path.join(homeDir, ".jazz");
    }
  }

  return path.resolve(process.cwd(), ".jazz");
}
