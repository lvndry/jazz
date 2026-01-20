import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";

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
function detectPackageManagerFromPath(normalizedPath: string): "bun" | "pnpm" | "npm" | null {
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
 * Check if a given path is within the jazz project directory
 * by looking for package.json with name "jazz-ai" in parent directories
 */
function isInJazzProjectDirectory(filePath: string): boolean {
  try {
    let currentDir = path.resolve(filePath);
    // If it's a file, get its directory
    if (!fs.statSync(currentDir).isDirectory()) {
      currentDir = path.dirname(currentDir);
    }

    // Walk up the directory tree looking for package.json
    let searchDir = currentDir;
    const root = path.parse(searchDir).root;

    while (searchDir !== root) {
      const packageJsonPath = path.join(searchDir, "package.json");
      if (fs.existsSync(packageJsonPath)) {
        try {
          const packageJsonContent = fs.readFileSync(packageJsonPath, "utf-8");
          const packageJson = JSON.parse(packageJsonContent) as { name?: string };
          if (packageJson.name === "jazz-ai") {
            return true;
          }
        } catch {
          // If we can't read/parse package.json, continue searching
        }
      }
      searchDir = path.dirname(searchDir);
    }
  } catch {
    // If we can't check, assume it's not in the project directory
  }

  return false;
}

/**
 * Check if a path is in a system-wide or user-level global installation location
 * This complements isGlobalInstallationPath() by catching system-wide paths
 * that might not match package manager patterns
 */
function isInSystemGlobalPath(filePath: string): boolean {
  const normalizedPath = filePath.toLowerCase().replace(/\\/g, "/");
  const homeDir = os.homedir();

  // System-wide installation paths (normalize after joining)
  const systemPaths = [
    "/usr/local/lib/node_modules",
    "/usr/lib/node_modules",
    path.join(homeDir, ".npm-global"),
    path.join(homeDir, ".npm-packages"),
    path.join(homeDir, ".local/share/pnpm"),
    path.join(homeDir, ".pnpm-global"),
    path.join(homeDir, ".bun/bin"),
    path.join(homeDir, ".yarn/bin"),
    path.join(homeDir, ".config/yarn/global"),
  ].map((p) => p.toLowerCase().replace(/\\/g, "/"));

  return systemPaths.some((globalPath) => normalizedPath.includes(globalPath));
}

/**
 * Detect if the CLI is running from a global npm/pnpm/bun/yarn installation
 *
 * This is useful for determining whether to use user-specific directories
 * (like ~/.jazz) or local development directories (like {cwd}/.jazz)
 *
 * Detection logic (in order):
 * 1. If executable/script is within jazz project directory → development mode
 * 2. If executable/script matches global installation patterns → global install
 * 3. If executable/script is in system-wide global paths → global install
 * 4. If executable/script is in node_modules (but not jazz project) → global install
 * 5. Otherwise → development mode (safe default)
 *
 * @returns true if running from a global package installation, false if in local development
 *
 * @example
 * ```typescript
 * if (isInstalledGlobally()) {
 *   // Use ~/.jazz for production
 * } else {
 *   // Use {cwd}/.jazz for development
 * }
 * ```
 */
export function isInstalledGlobally(): boolean {
  // Check both the executable path and script directory
  const pathsToCheck = [process.argv[1] ? path.resolve(process.argv[1]) : null, __dirname].filter(
    (p): p is string => p !== null,
  );

  for (const checkPath of pathsToCheck) {
    try {
      // If in jazz project directory, definitely development mode
      if (isInJazzProjectDirectory(checkPath)) {
        return false;
      }

      // Check if it matches known global installation patterns
      if (isGlobalInstallationPath(checkPath)) {
        return true;
      }

      // Check if it's in system-wide global paths
      if (isInSystemGlobalPath(checkPath)) {
        return true;
      }

      // Check if it's in node_modules (but not in jazz project)
      // This catches global installations in node_modules
      if (checkPath.includes("node_modules") && !isInJazzProjectDirectory(checkPath)) {
        return true;
      }
    } catch {
      // If we can't check a path, continue to next one
      continue;
    }
  }

  // Default to development mode if we can't determine
  return false;
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
 * Uses the user's home directory (~/.jazz) when installed globally,
 * and the current working directory ({cwd}/.jazz) during local development
 * to prevent development from overwriting production agents
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
