import { Effect } from "effect";
import packageJson from "../../../package.json";
import { UpdateCheckError, UpdateInstallError } from "../../core/types/errors";
import type { ConfigService } from "../../services/config";
import { LoggerServiceTag, type LoggerService } from "../../services/logger";
import { TerminalServiceTag, type TerminalService } from "../../services/terminal";

/**
 * CLI command for updating Jazz to the latest version
 */

/**
 * Version information from npm registry
 */
interface NpmPackageInfo {
  "dist-tags": {
    latest: string;
    [key: string]: string;
  };
  versions: Record<string, unknown>;
}

/**
 * Compare two semantic version strings
 * @returns -1 if v1 < v2, 0 if equal, 1 if v1 > v2
 */
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split(".").map((n) => parseInt(n, 10));
  const parts2 = v2.split(".").map((n) => parseInt(n, 10));

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const part1 = parts1[i] || 0;
    const part2 = parts2[i] || 0;

    if (part1 > part2) return 1;
    if (part1 < part2) return -1;
  }

  return 0;
}

/**
 * Check if a newer version is available on npm
 */
function checkForUpdate(): Effect.Effect<
  { hasUpdate: boolean; currentVersion: string; latestVersion: string },
  UpdateCheckError
> {
  return Effect.gen(function* () {
    const currentVersion = packageJson.version;

    // Fetch the latest version from npm registry
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(`https://registry.npmjs.org/${packageJson.name}`, {
          headers: {
            Accept: "application/json",
          },
        }),
      catch: (unknownError: unknown) =>
        new UpdateCheckError({
          message: "Failed to fetch version information from npm registry",
          cause: unknownError,
        }),
    });

    if (!response.ok) {
      return yield* Effect.fail(
        new UpdateCheckError({
          message: `npm registry returned status ${response.status}`,
        }),
      );
    }

    const data = (yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (unknownError: unknown) =>
        new UpdateCheckError({
          message: "Failed to parse npm registry response",
          cause: unknownError,
        }),
    })) as NpmPackageInfo;

    const latestVersion = data["dist-tags"].latest;

    if (!latestVersion) {
      return yield* Effect.fail(
        new UpdateCheckError({
          message: "Could not determine latest version from npm registry",
        }),
      );
    }

    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

    return {
      hasUpdate,
      currentVersion,
      latestVersion,
    };
  });
}

/**
 * Package manager information
 */
interface PackageManagerInfo {
  readonly name: string;
  readonly version: string;
}

/**
 * Find where the jazz command is installed
 * Returns the full path to the jazz executable, or null if not found
 */
function findJazzInstallationPath(): Effect.Effect<string | null, never> {
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
 */
function detectInstalledPackageManager(
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

    // Check for bun installation paths
    // Bun typically installs to: ~/.bun/bin/jazz or similar
    if (normalizedPath.includes("/.bun/") || normalizedPath.includes("\\bun\\")) {
      return "bun" as const;
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
      return "pnpm" as const;
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
      return "npm" as const;
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
      return "npm" as const;
    }

    // Cannot determine from path - return null
    return null;
  });
}

/**
 * Get the version of a package manager command
 * Gracefully handles errors - returns null if command doesn't exist or version check fails
 */
function getPackageManagerVersion(
  command: string,
): Effect.Effect<PackageManagerInfo | null, never> {
  return Effect.gen(function* () {
    const { spawn } = yield* Effect.promise(() => import("child_process"));

    return yield* Effect.async<PackageManagerInfo | null, never>((resume) => {
      const child = spawn(command, ["--version"], {
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
          // Successfully got version
          resume(
            Effect.succeed({
              name: command,
              version: stdout.trim(),
            }),
          );
        } else {
          // Command doesn't exist or version check failed
          resume(Effect.succeed(null));
        }
      });

      child.on("error", () => {
        // Command doesn't exist or spawn failed
        resume(Effect.succeed(null));
      });
    });
  });
}

/**
 * Detect which package manager to use for updating
 * First tries to detect which package manager was used to install Jazz
 * Falls back to checking available package managers if detection fails
 *
 * Future: Can add minimum version checks here
 */
function detectPackageManager(): Effect.Effect<PackageManagerInfo, UpdateInstallError> {
  return Effect.gen(function* () {
    // First, try to find where Jazz is installed
    const installPath = yield* findJazzInstallationPath();

    if (installPath) {
      // Try to detect which package manager was used based on installation path
      const detectedPm = yield* detectInstalledPackageManager(installPath);

      if (detectedPm) {
        // Found the package manager that was used to install Jazz
        const pmInfo = yield* getPackageManagerVersion(detectedPm);
        if (pmInfo) {
          return pmInfo;
        }
        // Package manager detected but version check failed - fall through to fallback
      }
    }

    // Fallback: Check available package managers in order of preference
    // Check bun first
    const bunInfo = yield* getPackageManagerVersion("bun");
    if (bunInfo) return bunInfo;

    // Check pnpm
    const pnpmInfo = yield* getPackageManagerVersion("pnpm");
    if (pnpmInfo) return pnpmInfo;

    // Check npm
    const npmInfo = yield* getPackageManagerVersion("npm");
    if (npmInfo) return npmInfo;

    // None of the package managers are installed
    return yield* Effect.fail(
      new UpdateInstallError({
        message:
          "No package manager found. Please install one of: bun, pnpm, or npm\n" +
          "npm usually comes with Node.js: https://nodejs.org/\n" +
          "bun: https://bun.sh/\n" +
          "pnpm: https://pnpm.io/",
      }),
    );
  });
}

/**
 * Install the latest version using the detected package manager
 */
function installUpdate(packageName: string, terminal: TerminalService): Effect.Effect<void, UpdateInstallError> {
  return Effect.gen(function* () {
    const { spawn } = yield* Effect.promise(() => import("child_process"));

    // Detect which package manager to use
    const pmInfo = yield* detectPackageManager();

    yield* terminal.log(`\n📦 Installing update using ${pmInfo.name} (${pmInfo.version})...`);

    const installArgs =
      pmInfo.name === "bun"
        ? ["add", "-g", `${packageName}@latest`]
        : pmInfo.name === "pnpm"
          ? ["add", "-g", `${packageName}@latest`]
          : ["install", "-g", `${packageName}@latest`];

    yield* Effect.async<void, UpdateInstallError>((resume) => {
      const child = spawn(pmInfo.name, installArgs, {
        stdio: "inherit",
        shell: true,
      });

      child.on("close", (code) => {
        if (code === 0) {
          resume(Effect.succeed(undefined));
        } else {
          resume(
            Effect.fail(
              new UpdateInstallError({
                message: `${pmInfo.name} install failed with exit code ${code ?? "unknown"}`,
              }),
            ),
          );
        }
      });

      child.on("error", (unknownError: unknown) => {
        resume(
          Effect.fail(
            new UpdateInstallError({
              message: `Failed to spawn ${pmInfo.name}`,
              cause: unknownError,
            }),
          ),
        );
      });
    });
  });
}

/**
 * Update command - checks for updates and installs if available
 */
export function updateCommand(options?: {
  check?: boolean;
}): Effect.Effect<void, never, LoggerService | ConfigService | TerminalService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const terminal = yield* TerminalServiceTag;

    yield* logger.info("Checking for updates...");
    yield* terminal.info("Checking for updates...");
    yield* terminal.log("");

    // Check for updates
    const versionInfo = yield* checkForUpdate().pipe(
      Effect.catchAll((checkError: UpdateCheckError) => {
        return Effect.gen(function* () {
          yield* logger.error("Failed to check for updates", { error: checkError.message });
          yield* terminal.error("Failed to check for updates:");
          yield* terminal.log(`   ${checkError.message}`);
          yield* terminal.log("\n💡 You can manually check for updates at:");
          yield* terminal.log(`   https://www.npmjs.com/package/${packageJson.name}`);
          return yield* Effect.fail(checkError);
        });
      }),
      Effect.catchAll(() => Effect.succeed({ hasUpdate: false, currentVersion: packageJson.version, latestVersion: packageJson.version })),
    );

    yield* terminal.log(`📦 Current version: ${versionInfo.currentVersion}`);
    yield* terminal.log(`📦 Latest version:  ${versionInfo.latestVersion}`);
    yield* terminal.log("");

    if (!versionInfo.hasUpdate) {
      yield* logger.info("Already on latest version");
      yield* terminal.success("You're already on the latest version!");
      return;
    }

    yield* terminal.success("A new version is available!");

    // If --check flag is used, just show the info and exit
    if (options?.check) {
      yield* terminal.log("\n💡 Run 'jazz update' to install the latest version");
      return;
    }

    yield* terminal.log("⚡ Starting update process...");
    yield* terminal.log("");

    // Install the update
    yield* installUpdate(packageJson.name, terminal).pipe(
      Effect.catchAll((installError: UpdateInstallError) => {
        return Effect.gen(function* () {
          yield* logger.error("Failed to install update", { error: installError.message });
          yield* terminal.error("Failed to install update:");
          yield* terminal.log(`   ${installError.message}`);
          yield* terminal.log("\n💡 You can manually update by running:");
          yield* terminal.log(`   npm install -g ${packageJson.name}@latest`);
          yield* terminal.log(`   bun add -g ${packageJson.name}@latest`);
          yield* terminal.log(`   pnpm add -g ${packageJson.name}@latest`);
        });
      }),
    );

    yield* logger.info("Update completed successfully");
    yield* terminal.success("Update completed successfully!");
    yield* terminal.log(`🎉 Jazz has been updated to version ${versionInfo.latestVersion}`);
  });
}
