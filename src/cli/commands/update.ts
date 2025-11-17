/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-return */

import { Effect } from "effect";
import packageJson from "../../../package.json";
import { UpdateCheckError, UpdateInstallError } from "../../core/types/errors";
import type { ConfigService } from "../../services/config";
import { LoggerServiceTag, type LoggerService } from "../../services/logger";

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
 * Install the latest version using npm
 */
function installUpdate(packageName: string): Effect.Effect<void, UpdateInstallError> {
  return Effect.gen(function* () {
    const { spawn } = yield* Effect.promise(() => import("child_process"));

    // Detect which package manager to use
    const packageManager = yield* Effect.sync(() => {
      // Check if bun is available
      try {
        const bunCheck = spawn("bun", ["--version"], { stdio: "ignore" });
        if (bunCheck.exitCode === 0) return "bun";
      } catch {
        // bun not available
      }

      // Check if pnpm is available
      try {
        const pnpmCheck = spawn("pnpm", ["--version"], { stdio: "ignore" });
        if (pnpmCheck.exitCode === 0) return "pnpm";
      } catch {
        // pnpm not available
      }

      // Default to npm
      return "npm";
    });

    console.log(`\n📦 Installing update using ${packageManager}...`);

    const installArgs =
      packageManager === "bun"
        ? ["add", "-g", `${packageName}@latest`]
        : packageManager === "pnpm"
          ? ["add", "-g", `${packageName}@latest`]
          : ["install", "-g", `${packageName}@latest`];

    yield* Effect.async<void, UpdateInstallError>((resume) => {
      const child = spawn(packageManager, installArgs, {
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
                message: `${packageManager} install failed with exit code ${code ?? "unknown"}`,
              }),
            ),
          );
        }
      });

      child.on("error", (unknownError: unknown) => {
        resume(
          Effect.fail(
            new UpdateInstallError({
              message: `Failed to spawn ${packageManager}`,
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
}): Effect.Effect<void, never, LoggerService | ConfigService> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;

    yield* logger.info("Checking for updates...");
    console.log("🔍 Checking for updates...\n");

    // Check for updates
    const versionInfo = yield* checkForUpdate().pipe(
      Effect.catchAll((checkError: UpdateCheckError) => {
        return Effect.gen(function* () {
          yield* logger.error("Failed to check for updates", { error: checkError.message });
          console.log("❌ Failed to check for updates:");
          console.log(`   ${checkError.message}`);
          console.log("\n💡 You can manually check for updates at:");
          console.log(`   https://www.npmjs.com/package/${packageJson.name}`);
          return yield* Effect.fail(checkError);
        });
      }),
      Effect.catchAll(() => Effect.succeed({ hasUpdate: false, currentVersion: packageJson.version, latestVersion: packageJson.version })),
    );

    console.log(`📦 Current version: ${versionInfo.currentVersion}`);
    console.log(`📦 Latest version:  ${versionInfo.latestVersion}\n`);

    if (!versionInfo.hasUpdate) {
      yield* logger.info("Already on latest version");
      console.log("✅ You're already on the latest version!");
      return;
    }

    console.log("🎉 A new version is available!");

    // If --check flag is used, just show the info and exit
    if (options?.check) {
      console.log("\n💡 Run 'jazz update' to install the latest version");
      return;
    }

    console.log("⚡ Starting update process...\n");

    // Install the update
    yield* installUpdate(packageJson.name).pipe(
      Effect.catchAll((installError: UpdateInstallError) => {
        return Effect.gen(function* () {
          yield* logger.error("Failed to install update", { error: installError.message });
          console.log("\n❌ Failed to install update:");
          console.log(`   ${installError.message}`);
          console.log("\n💡 You can manually update by running:");
          console.log(`   npm install -g ${packageJson.name}@latest`);
          console.log("   or");
          console.log(`   bun add -g ${packageJson.name}@latest`);
        });
      }),
    );

    yield* logger.info("Update completed successfully");
    console.log("\n✅ Update completed successfully!");
    console.log(`🎉 Jazz has been updated to version ${versionInfo.latestVersion}`);
  });
}
