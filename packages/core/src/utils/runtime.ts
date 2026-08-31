import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";

/**
 * Detects Jazz's runtime installation, executable, package manager, and
 * scheduler invocation. Runtime mode does not determine where user data is
 * stored; directory resolution belongs in `paths.ts`.
 */

/**
 * Return whether Jazz should suppress its own optional outbound requests.
 *
 * `JAZZ_OFFLINE` accepts the exact values `1` and `true`. Provider inference
 * is unaffected; airgapped deployments should configure a local provider.
 */
export function isOfflineMode(): boolean {
  const value = process.env["JAZZ_OFFLINE"];
  return value === "1" || value === "true";
}

/**
 * Checks whether Jazz is running as a standalone binary.
 *
 * The compiled binary serves its own modules out of a virtual filesystem
 * rooted at `/$bunfs` (`B:\~BUN` on Windows), which is the one thing that
 * distinguishes it from every install that has real files on disk.
 */
export function isStandaloneBinary(): boolean {
  const moduleDirectory = import.meta.dirname ?? "";
  return moduleDirectory.startsWith("/$bunfs") || moduleDirectory.startsWith("B:\\~BUN");
}

/**
 * Checks whether Jazz is running from a global package-manager installation.
 *
 * Jazz source directories are treated as development mode. Otherwise known
 * package-manager paths, system global directories, and external
 * `node_modules` paths are treated as global installations.
 */
export function isRunningFromGlobalInstall(): boolean {
  if (isStandaloneBinary()) {
    return true;
  }

  const pathsToCheck = [
    process.argv[1] ? path.resolve(process.argv[1]) : null,
    import.meta.dirname,
  ].filter((candidatePath): candidatePath is string => candidatePath !== null);

  for (const checkPath of pathsToCheck) {
    try {
      if (isWithinJazzSourceDirectory(checkPath)) {
        return false;
      }

      if (matchesGlobalPackageManagerPath(checkPath)) {
        return true;
      }

      if (isInSystemGlobalDirectory(checkPath)) {
        return true;
      }

      if (checkPath.includes("node_modules") && !isWithinJazzSourceDirectory(checkPath)) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

/**
 * Checks whether Jazz is running from source rather than a global install.
 */
export function isRunningInDevelopmentMode(): boolean {
  return !isRunningFromGlobalInstall();
}

/**
 * Finds the Jazz executable with the platform shell's `which` or `where`.
 *
 * @returns An effect resolving to the first executable path, or `null`.
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
          const executablePath = lines[0]?.trim();
          resume(Effect.succeed(executablePath || null));
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
 * Detects the package manager associated with an installation path.
 *
 * Resolves symlinks before matching known Bun, pnpm, yarn, and npm paths.
 *
 * @param filePath - The executable or installation path to inspect.
 * @returns An effect resolving to the package-manager name, or `null`.
 */
export function detectPackageManagerFromPath(
  filePath: string,
): Effect.Effect<"bun" | "pnpm" | "npm" | "yarn" | null, never> {
  return Effect.gen(function* () {
    const fsModule = yield* Effect.promise(() => import("fs"));

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
 * Builds a robust Jazz invocation for launchd, cron, and other schedulers.
 *
 * Prefers an absolute executable path, then installation environment paths,
 * then common locations. Falls back to an available package-manager runner.
 *
 * @returns An effect resolving to an argv-style invocation.
 */
export function getJazzSchedulerInvocation(): Effect.Effect<readonly string[], never> {
  return Effect.gen(function* () {
    // A standalone binary is the whole installation, so it is its own most
    // reliable invocation — and the only one a machine without a package
    // manager can run.
    if (isStandaloneBinary()) {
      return [process.execPath];
    }

    // A source checkout is already running the exact entry point a persistent service needs.
    // Looking up `jazz` as root during `daemon install` is both unreliable (the invoking
    // user's PATH is not root's) and wrong when it finds a different global installation.
    // Keep Bun plus the absolute source entry point instead, so systemd can start precisely
    // the checkout that installed the service.
    const sourceEntryPoint = process.argv[1];
    if (
      sourceEntryPoint !== undefined &&
      isWithinJazzSourceDirectory(sourceEntryPoint) &&
      isRunningInDevelopmentMode()
    ) {
      return [process.execPath, path.resolve(sourceEntryPoint)];
    }

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
      return ["yarn", "dlx", "jazz-ai"];
    }

    return ["npx", "--yes", "jazz-ai"];
  });
}

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
  ].map((globalPath) => globalPath.toLowerCase().replace(/\\/g, "/"));

  return globalPaths.some((globalPath) => normalized.includes(globalPath));
}

function inferPackageManagerFromNormalizedPath(
  normalizedPath: string,
): "bun" | "pnpm" | "npm" | "yarn" | null {
  if (normalizedPath.includes("/.bun/") || normalizedPath.includes("\\bun\\")) {
    return "bun";
  }

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

  if (
    normalizedPath.includes("/pnpm/") ||
    normalizedPath.includes("\\pnpm\\") ||
    normalizedPath.includes("/.pnpm") ||
    normalizedPath.includes("\\.pnpm")
  ) {
    return "pnpm";
  }

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
      // Ignore inaccessible candidates
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
