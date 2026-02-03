import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";

/**
 * ============================================================================
 * RUNTIME DETECTION UTILITIES
 * ============================================================================
 *
 * This module detects whether Jazz is running from a global installation or
 * from source code (development mode). This distinction is critical because:
 *
 *   - **Production** (npm i -g jazz-ai): User data stored in `~/.jazz`
 *   - **Development** (bun run cli):     User data stored in `./.jazz`
 *
 * This separation prevents development from accidentally overwriting production
 * data (agents, configs, conversation history, skills, etc.).
 *
 * ## Directory Resolution (most commonly used)
 *   - `getUserDataDirectory()` - Returns ~/.jazz (prod) or ./.jazz (dev)
 *   - `getPackageRootDirectory()` - The jazz-ai package installation directory
 *   - `getBuiltinSkillsDirectory()` - Where built-in skills are stored
 *
 * ## Environment Detection
 *   - `isRunningFromGlobalInstall()` - Is Jazz installed globally?
 *   - `isRunningInDevelopmentMode()` - Is Jazz running from source?
 *
 * ## Executable Discovery (rarely needed)
 *   - `findExecutablePathViaShell()` - Find jazz binary via which/where
 *   - `detectPackageManagerFromPath()` - Detect npm/bun/pnpm from path
 *
 * ============================================================================
 */

// ============================================================================
// SECTION 1: DIRECTORY RESOLUTION
// ============================================================================
// These functions resolve important directories for Jazz's operation.
// They use synchronous fs operations since they're called during startup.
// ============================================================================

/**
 * Get the directory where Jazz stores user data (agents, configs, skills, etc.)
 *
 * - Global install (npm i -g jazz-ai): Returns ~/.jazz
 * - Development mode (running from source): Returns {cwd}/.jazz
 *
 * This separation prevents development from overwriting production data.
 *
 * @example
 * ```typescript
 * const dataDir = getUserDataDirectory();
 * // Global: "/Users/alice/.jazz"
 * // Dev:    "/Users/alice/projects/jazz/.jazz"
 * ```
 */
export function getUserDataDirectory(): string {
  if (isRunningFromGlobalInstall()) {
    const homeDir = os.homedir();
    if (homeDir && homeDir.trim().length > 0) {
      return path.join(homeDir, ".jazz");
    }
  }

  return path.resolve(process.cwd(), ".jazz");
}

/**
 * Get the jazz-ai package's root directory (where package.json lives).
 *
 * This is used to locate built-in assets (skills, templates, etc.) that ship
 * with the Jazz package. Works for both global installs and development mode.
 *
 * Detection: Walks up from __dirname looking for package.json with name "jazz-ai"
 *
 * @returns Package root directory, or null if not found
 *
 * @example
 * ```typescript
 * const pkgDir = getPackageRootDirectory();
 * // Global: "/usr/local/lib/node_modules/jazz-ai"
 * // Dev:    "/Users/alice/projects/jazz"
 * ```
 */
export function getPackageRootDirectory(): string | null {
  try {
    let currentDir = path.resolve(__dirname);
    const root = path.parse(currentDir).root;

    while (currentDir !== root) {
      const packageJsonPath = path.join(currentDir, "package.json");
      if (fs.existsSync(packageJsonPath)) {
        try {
          const content = fs.readFileSync(packageJsonPath, "utf-8");
          const pkg = JSON.parse(content) as { name?: string };
          if (pkg.name === "jazz-ai") {
            return currentDir;
          }
        } catch {
          // Can't read/parse package.json, continue searching
        }
      }
      currentDir = path.dirname(currentDir);
    }
  } catch {
    // Can't determine package directory
  }

  return null;
}

/**
 * Get the directory containing built-in skills shipped with Jazz.
 *
 * Built-in skills are located in the `skills/` folder within the Jazz package.
 * These are read-only skills that provide core functionality (skill-creator, etc.)
 *
 * @returns Skills directory path, or null if not found
 *
 * @example
 * ```typescript
 * const skillsDir = getBuiltinSkillsDirectory();
 * // "/usr/local/lib/node_modules/jazz-ai/skills"
 * // or "/Users/alice/projects/jazz/skills"
 * ```
 */
export function getBuiltinSkillsDirectory(): string | null {
  const packageDir = getPackageRootDirectory();
  if (!packageDir) {
    return null;
  }

  const skillsDir = path.join(packageDir, "skills");
  if (fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory()) {
    return skillsDir;
  }

  return null;
}

/**
 * Get the directory containing global user skills.
 *
 * Global skills are user-created skills stored in `~/.jazz/skills/`.
 * These skills are available across all projects and persist between sessions.
 *
 * @returns Global skills directory path
 *
 * @example
 * ```typescript
 * const skillsDir = getGlobalSkillsDirectory();
 * // "/Users/alice/.jazz/skills"
 * ```
 */
export function getGlobalSkillsDirectory(): string {
  const homeDir = os.homedir();
  return path.join(homeDir, ".jazz", "skills");
}

/**
 * Get the directory containing built-in workflows shipped with Jazz.
 *
 * Built-in workflows are located in the `workflows/` folder within the Jazz package.
 * These are example workflows that demonstrate Jazz's automation capabilities.
 *
 * @returns Workflows directory path, or null if not found
 *
 * @example
 * ```typescript
 * const workflowsDir = getBuiltinWorkflowsDirectory();
 * // "/usr/local/lib/node_modules/jazz-ai/workflows"
 * // or "/Users/alice/projects/jazz/workflows"
 * ```
 */
export function getBuiltinWorkflowsDirectory(): string | null {
  const packageDir = getPackageRootDirectory();
  if (!packageDir) {
    return null;
  }

  const workflowsDir = path.join(packageDir, "workflows");
  if (fs.existsSync(workflowsDir) && fs.statSync(workflowsDir).isDirectory()) {
    return workflowsDir;
  }

  return null;
}

/**
 * Get the directory containing global user workflows.
 *
 * Global workflows are user-created workflows stored in `~/.jazz/workflows/`.
 * These workflows are available across all projects and persist between sessions.
 *
 * @returns Global workflows directory path
 *
 * @example
 * ```typescript
 * const workflowsDir = getGlobalWorkflowsDirectory();
 * // "/Users/alice/.jazz/workflows"
 * ```
 */
export function getGlobalWorkflowsDirectory(): string {
  const homeDir = os.homedir();
  return path.join(homeDir, ".jazz", "workflows");
}

// ============================================================================
// SECTION 2: ENVIRONMENT DETECTION
// ============================================================================
// These functions detect whether Jazz is running from a global installation
// or from source code (development mode).
// ============================================================================

/**
 * Check if Jazz is running from a global package manager installation.
 *
 * Used to determine runtime behavior:
 * - Global install → Use ~/.jazz for data, production behavior
 * - Development → Use ./.jazz for data, development behavior
 *
 * Detection logic (in priority order):
 * 1. If running from jazz-ai source directory → false (development)
 * 2. If path matches global PM patterns (bun/npm/pnpm) → true
 * 3. If path is in system global directories → true
 * 4. If path contains node_modules (but not jazz source) → true
 * 5. Default → false (development, safe default)
 *
 * @example
 * ```typescript
 * if (isRunningFromGlobalInstall()) {
 *   console.log("Running from: npm i -g jazz-ai");
 * } else {
 *   console.log("Running from source code");
 * }
 * ```
 */
export function isRunningFromGlobalInstall(): boolean {
  const pathsToCheck = [
    process.argv[1] ? path.resolve(process.argv[1]) : null,
    __dirname
  ].filter((p): p is string => p !== null);

  for (const checkPath of pathsToCheck) {
    try {
      // Running from jazz source = development mode
      if (isWithinJazzSourceDirectory(checkPath)) {
        return false;
      }

      // Matches known global package manager patterns
      if (matchesGlobalPackageManagerPath(checkPath)) {
        return true;
      }

      // Is in system-wide global installation paths
      if (isInSystemGlobalDirectory(checkPath)) {
        return true;
      }

      // Is in node_modules but not jazz source
      if (checkPath.includes("node_modules") && !isWithinJazzSourceDirectory(checkPath)) {
        return true;
      }
    } catch {
      continue;
    }
  }

  // Default to development mode (safe)
  return false;
}

/**
 * Check if Jazz is running in development mode (from source code).
 *
 * This is the inverse of `isRunningFromGlobalInstall()`.
 *
 * @example
 * ```typescript
 * if (isRunningInDevelopmentMode()) {
 *   console.log("Development mode - using local .jazz directory");
 * }
 * ```
 */
export function isRunningInDevelopmentMode(): boolean {
  return !isRunningFromGlobalInstall();
}

// ============================================================================
// SECTION 3: EXECUTABLE DISCOVERY
// ============================================================================
// These functions find the Jazz executable and detect installation method.
// Primarily used for diagnostics and update checking.
// ============================================================================

/**
 * Find the Jazz executable path using shell commands (which/where).
 *
 * This is useful for:
 * - Diagnostics (where is jazz installed?)
 * - Detecting the package manager used for installation
 * - Update commands (knowing which PM to use for updates)
 *
 * Note: This is an Effect-based async function that spawns a subprocess.
 *
 * @returns Effect resolving to executable path or null if not found
 *
 * @example
 * ```typescript
 * const execPath = yield* findExecutablePathViaShell();
 * // "/Users/alice/.bun/bin/jazz" or null
 * ```
 */
export function findExecutablePathViaShell(): Effect.Effect<string | null, never> {
  return Effect.gen(function* () {
    const { spawn } = yield* Effect.promise(() => import("child_process"));
    const isWindows = process.platform === "win32";
    const whichCommand = isWindows ? "where" : "which";

    return yield* Effect.async<string | null, never>((resume) => {
      const child = spawn(whichCommand, ["jazz"], {
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
          const lines = stdout.trim().split("\n");
          const execPath = lines[0]?.trim();
          resume(Effect.succeed(execPath || null));
        } else {
          resume(Effect.succeed(null));
        }
      });

      child.on("error", () => {
        resume(Effect.succeed(null));
      });
    });
  });
}

/**
 * Detect which package manager installed Jazz based on a file path.
 *
 * Analyzes the path structure to determine if it matches known patterns
 * for bun, pnpm, or npm global installations.
 *
 * Note: This is an Effect-based async function (resolves symlinks).
 *
 * @param filePath - Path to analyze (typically from findExecutablePathViaShell)
 * @returns Effect resolving to "bun" | "pnpm" | "npm" | null
 *
 * @example
 * ```typescript
 * const execPath = yield* findExecutablePathViaShell();
 * if (execPath) {
 *   const pm = yield* detectPackageManagerFromPath(execPath);
 *   console.log(`Installed via: ${pm}`); // "bun", "pnpm", "npm", or null
 * }
 * ```
 */
export function detectPackageManagerFromPath(
  filePath: string,
): Effect.Effect<"bun" | "pnpm" | "npm" | null, never> {
  return Effect.gen(function* () {
    const fsModule = yield* Effect.promise(() => import("fs"));

    // Resolve symlinks to get the actual installation path
    const resolvedPath = yield* Effect.gen(function* () {
      const statsResult = yield* Effect.tryPromise({
        try: () => fsModule.promises.lstat(filePath),
        catch: () => new Error("Cannot stat file"),
      }).pipe(Effect.catchAll(() => Effect.succeed(null)));

      if (statsResult?.isSymbolicLink()) {
        const realPath = yield* Effect.tryPromise({
          try: () => fsModule.promises.realpath(filePath),
          catch: () => new Error("Cannot resolve symlink"),
        }).pipe(Effect.catchAll(() => Effect.succeed(filePath)));
        return realPath;
      }

      return filePath;
    });

    const normalized = resolvedPath.toLowerCase().replace(/\\/g, "/");
    return inferPackageManagerFromNormalizedPath(normalized);
  });
}

// ============================================================================
// SECTION 4: INTERNAL HELPERS
// ============================================================================
// Private functions used by the public API above.
// ============================================================================

/**
 * Check if a path is within the jazz-ai source directory.
 * Used to detect development mode.
 */
function isWithinJazzSourceDirectory(filePath: string): boolean {
  try {
    let currentDir = path.resolve(filePath);

    if (!fs.statSync(currentDir).isDirectory()) {
      currentDir = path.dirname(currentDir);
    }

    let searchDir = currentDir;
    const root = path.parse(searchDir).root;

    while (searchDir !== root) {
      const packageJsonPath = path.join(searchDir, "package.json");
      if (fs.existsSync(packageJsonPath)) {
        try {
          const content = fs.readFileSync(packageJsonPath, "utf-8");
          const pkg = JSON.parse(content) as { name?: string };
          if (pkg.name === "jazz-ai") {
            return true;
          }
        } catch {
          // Continue searching
        }
      }
      searchDir = path.dirname(searchDir);
    }
  } catch {
    // Can't check, assume not in source directory
  }

  return false;
}

/**
 * Check if a path matches known global package manager installation patterns.
 */
function matchesGlobalPackageManagerPath(filePath: string): boolean {
  let resolvedPath = filePath;

  try {
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink()) {
      try {
        resolvedPath = fs.realpathSync(filePath);
      } catch {
        // Keep original path
      }
    }
  } catch {
    // Keep original path
  }

  const normalized = resolvedPath.toLowerCase().replace(/\\/g, "/");
  return inferPackageManagerFromNormalizedPath(normalized) !== null;
}

/**
 * Check if a path is in a system-wide global installation directory.
 */
function isInSystemGlobalDirectory(filePath: string): boolean {
  const normalized = filePath.toLowerCase().replace(/\\/g, "/");
  const homeDir = os.homedir();

  const globalPaths = [
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

  return globalPaths.some((globalPath) => normalized.includes(globalPath));
}

/**
 * Infer package manager from a normalized path string.
 *
 * @param normalizedPath - Lowercase path with forward slashes
 * @returns Package manager name or null
 */
function inferPackageManagerFromNormalizedPath(
  normalizedPath: string
): "bun" | "pnpm" | "npm" | null {
  // Bun: ~/.bun/bin/jazz
  if (normalizedPath.includes("/.bun/") || normalizedPath.includes("\\bun\\")) {
    return "bun";
  }

  // pnpm: ~/.local/share/pnpm/..., ~/.pnpm-global/...
  if (
    normalizedPath.includes("/pnpm/") ||
    normalizedPath.includes("\\pnpm\\") ||
    normalizedPath.includes("/.pnpm") ||
    normalizedPath.includes("\\.pnpm")
  ) {
    return "pnpm";
  }

  // npm: Various locations
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

  // Standard Unix bin directories (likely npm)
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

  return null;
}
