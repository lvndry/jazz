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
 *   - `detectPackageManagerFromPath()` - Detect npm/bun/pnpm/yarn from path
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
 */
export function getGlobalSkillsDirectory(): string {
  const homeDir = os.homedir();
  return path.join(homeDir, ".jazz", "skills");
}

/**
 * Get the directory containing shared agent skills.
 *
 * Agent skills are stored in `~/.agents/skills/` and are shared across
 * different agent tools. These skills persist between sessions.
 *
 * @returns Agents skills directory path
 *
 */
export function getAgentsSkillsDirectory(): string {
  const homeDir = os.homedir();
  return path.join(homeDir, ".agents", "skills");
}

/**
 * Get the directory containing built-in workflows shipped with Jazz.
 *
 * Built-in workflows are located in the `workflows/` folder within the Jazz package.
 * These are example workflows that demonstrate Jazz's automation capabilities.
 *
 * @returns Workflows directory path, or null if not found
 *
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
 * @returns Global workflows directory path``
 *
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
 */
export function isRunningFromGlobalInstall(): boolean {
  const pathsToCheck = [process.argv[1] ? path.resolve(process.argv[1]) : null, __dirname].filter(
    (p): p is string => p !== null,
  );

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
 * for bun, pnpm, yarn, or npm global installations.
 *
 * Note: This is an Effect-based async function (resolves symlinks).
 *
 * @param filePath - Path to analyze (typically from findExecutablePathViaShell)
 * @returns Effect resolving to "bun" | "pnpm" | "yarn" | "npm" | null
 *
 */
export function detectPackageManagerFromPath(
  filePath: string,
): Effect.Effect<"bun" | "pnpm" | "npm" | "yarn" | null, never> {
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

/**
 * Get a robust Jazz invocation for system schedulers (launchd/cron).
 *
 * This prefers returning an absolute path to the `jazz` executable (so it does not
 * depend on PATH at runtime). If we can't resolve a path, we fall back to a
 * package-manager runner (bunx/pnpm dlx/yarn dlx/npx).
 *
 * @returns Effect resolving to argv-style invocation, e.g. `["/usr/local/bin/jazz"]`
 *          or `["npx", "--yes", "jazz-ai"]`
 */
export function getJazzSchedulerInvocation(): Effect.Effect<readonly string[], never> {
  return Effect.gen(function* () {
    const fromShell = yield* findExecutablePathViaShell();
    if (fromShell) {
      return [fromShell];
    }

    const fromEnv = resolveJazzExecutablePathFromEnv();
    if (fromEnv) {
      return [fromEnv];
    }

    const fromCommon = resolveJazzExecutablePathFromCommonLocations();
    if (fromCommon) {
      return [fromCommon];
    }

    // Fall back to a runner. Preference is based on availability.
    const hasBunx = yield* commandExistsViaShell("bunx");
    if (hasBunx) {
      return ["bunx", "jazz-ai"];
    }

    const hasPnpm = yield* commandExistsViaShell("pnpm");
    if (hasPnpm) {
      return ["pnpm", "dlx", "jazz-ai"];
    }

    const hasYarn = yield* commandExistsViaShell("yarn");
    if (hasYarn) {
      // Yarn classic (v1) doesn't support dlx, but if yarn is installed and jazz
      // wasn't found, this is still the best non-interactive attempt.
      return ["yarn", "dlx", "jazz-ai"];
    }

    // Default: npm-based runner (works when Node is installed)
    return ["npx", "--yes", "jazz-ai"];
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
  normalizedPath: string,
): "bun" | "pnpm" | "npm" | "yarn" | null {
  // Bun: ~/.bun/bin/jazz
  if (normalizedPath.includes("/.bun/") || normalizedPath.includes("\\bun\\")) {
    return "bun";
  }

  // Yarn: ~/.yarn/bin/jazz, ~/.config/yarn/global/...
  if (
    normalizedPath.includes("/.yarn/") ||
    normalizedPath.includes("\\.yarn\\") ||
    normalizedPath.includes("/.config/yarn/") ||
    normalizedPath.includes("\\.config\\yarn\\") ||
    normalizedPath.includes("/yarn/") ||
    normalizedPath.includes("\\yarn\\")
  ) {
    return "yarn";
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

function resolveJazzExecutablePathFromEnv(): string | null {
  const bunInstall = process.env["BUN_INSTALL"];
  if (bunInstall && bunInstall.trim().length > 0) {
    return path.join(bunInstall, "bin", "jazz");
  }

  const pnpmHome = process.env["PNPM_HOME"];
  if (pnpmHome && pnpmHome.trim().length > 0) {
    return path.join(pnpmHome, "jazz");
  }

  // npm/yarn frequently rely on a prefix that contains bin/
  const npmPrefix = process.env["npm_config_prefix"];
  if (npmPrefix && npmPrefix.trim().length > 0) {
    return path.join(npmPrefix, "bin", "jazz");
  }

  return null;
}

function resolveJazzExecutablePathFromCommonLocations(): string | null {
  const homeDir = os.homedir();
  const candidates = [
    path.join(homeDir, ".bun", "bin", "jazz"),
    path.join(homeDir, ".local", "share", "pnpm", "jazz"),
    path.join(homeDir, ".pnpm-global", "bin", "jazz"),
    path.join(homeDir, ".npm-global", "bin", "jazz"),
    path.join(homeDir, ".npm-packages", "bin", "jazz"),
    path.join(homeDir, ".yarn", "bin", "jazz"),
    path.join(homeDir, ".config", "yarn", "global", "node_modules", ".bin", "jazz"),
    "/usr/local/bin/jazz",
    "/usr/bin/jazz",
    "/bin/jazz",
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

function commandExistsViaShell(command: string): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    const { spawn } = yield* Effect.promise(() => import("child_process"));
    const isWindows = process.platform === "win32";
    const whichCommand = isWindows ? "where" : "which";

    return yield* Effect.async<boolean, never>((resume) => {
      const child = spawn(whichCommand, [command], {
        stdio: ["ignore", "ignore", "ignore"],
        shell: true,
      });

      child.on("close", (code) => {
        resume(Effect.succeed(code === 0));
      });

      child.on("error", () => {
        resume(Effect.succeed(false));
      });
    });
  });
}
