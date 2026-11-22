/**
 * Startup update check: throttled to once per UPDATE_CHECK_INTERVAL_DAYS via a
 * timestamp file, so it doesn't hit the registry on every invocation. A newer
 * version is installed by a detached process, so the next launch runs it.
 */

import { LoggerServiceTag, type LoggerService } from "@jazz/core/interfaces/logger";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import { getUserDataDirectory } from "@jazz/core/utils/paths";
import { stateDirectoryMode, stateFileMode } from "@jazz/core/utils/private-mode";
import { getJazzSchedulerInvocation, isRunningInDevelopmentMode } from "@jazz/core/utils/runtime";
import { Effect, FileSystem } from "effect";
import { checkForUpdate, isPatchUpdate } from "./commands/update";
import { getGlyphs } from "./ui/glyphs";
import { releaseUpdateInstallClaim, tryClaimUpdateInstall } from "./update-claim";

const UPDATE_CHECK_INTERVAL_DAYS = 1;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_FILE = "update_check";
/** How long after a failed launch the next startup tries again. */
const LAUNCH_RETRY_DELAY_MS = 60 * 60 * 1000;
/** Content width of the boxed update notice, between its vertical borders. */
const UPDATE_BANNER_INNER_WIDTH = 67;

/**
 * Checks for updates if the check interval has passed, and notifies the user if a new version is available.
 * This is meant to be run at application startup.
 */
export function autoCheckForUpdate(): Effect.Effect<
  void,
  never,
  TerminalService | LoggerService | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const logger = yield* LoggerServiceTag;
    const fs = yield* FileSystem.FileSystem;

    const dataDir = getUserDataDirectory();
    const checkFilePath = `${dataDir}/${UPDATE_CHECK_FILE}`;

    // Ensure data directory exists
    yield* fs
      .makeDirectory(dataDir, { recursive: true, mode: stateDirectoryMode() })
      .pipe(Effect.catch(() => Effect.void));

    // Read last check timestamp
    const lastCheckStr = yield* fs
      .readFileString(checkFilePath)
      .pipe(Effect.catch(() => Effect.succeed("0")));

    const lastCheck = parseInt(lastCheckStr.trim(), 10) || 0;
    const now = Date.now();

    // Check if enough time has passed since the last check
    if (now - lastCheck < UPDATE_CHECK_INTERVAL_DAYS * MS_PER_DAY) {
      return;
    }

    yield* logger.debug("Checking for updates (auto-check triggered)...");

    // Perform the check with a timeout to avoid blocking startup for too long
    const result = yield* checkForUpdate().pipe(
      Effect.timeout(2000), // 2 seconds timeout
      Effect.catch(() => {
        // Log error but don't fail the program
        return Effect.gen(function* () {
          yield* logger.debug("Auto-update check failed", { errorType: "check_failed" });
          return null; // Return null to indicate failure/timeout
        });
      }),
    );

    const writeCheckTimestamp = (timestamp: number): Effect.Effect<void> =>
      fs.writeFileString(checkFilePath, timestamp.toString(), { mode: stateFileMode() }).pipe(
        Effect.catch(() =>
          Effect.gen(function* () {
            yield* logger.warn("Failed to write update check timestamp", {
              errorType: "state_write_failed",
            });
          }),
        ),
      );

    // Update the last check timestamp regardless of result to avoid blocking startup repeatedly on failures
    yield* writeCheckTimestamp(now);

    if (!result) {
      // Check failed or timed out
      return;
    }
    if (!result.hasUpdate) {
      return;
    }
    let installingInBackground = false;
    if (
      shouldInstallInBackground(
        process.env,
        isRunningInDevelopmentMode(),
        result.currentVersion,
        result.latestVersion,
      )
    ) {
      if (!tryClaimUpdateInstall(dataDir)) {
        yield* logger.debug("Background update already claimed by another process");
        installingInBackground = true;
      } else {
        installingInBackground = yield* launchBackgroundUpdate(logger);
        if (!installingInBackground) {
          releaseUpdateInstallClaim(dataDir);
          yield* writeCheckTimestamp(
            now - (UPDATE_CHECK_INTERVAL_DAYS * MS_PER_DAY - LAUNCH_RETRY_DELAY_MS),
          );
        }
      }
    }
    const destination = updateBannerDestination(terminal.isInteractive, process.stderr.isTTY);
    if (destination === "none") {
      return;
    }
    const lines = formatUpdateBanner(
      result.currentVersion,
      result.latestVersion,
      installingInBackground,
    );
    if (destination === "stderr") {
      process.stderr.write(`${lines.join("\n")}\n`);
      return;
    }
    for (const line of lines) {
      yield* terminal.log(line);
    }
  });
}

/**
 * Whether a newer version installs itself. Only patch releases do: a minor release may carry
 * breaking changes the user should read first. A source checkout updates through git, and
 * `JAZZ_DISABLE_AUTO_UPDATE=1` opts out; all three keep the banner that asks for `jazz update`.
 */
export function shouldInstallInBackground(
  env: Readonly<Record<string, string | undefined>>,
  isDevelopmentMode: boolean,
  currentVersion: string,
  latestVersion: string,
): boolean {
  return (
    env["JAZZ_DISABLE_AUTO_UPDATE"] !== "1" &&
    !isDevelopmentMode &&
    isPatchUpdate(currentVersion, latestVersion)
  );
}

const UPDATER_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TERM",
  "BUN_INSTALL",
  "PNPM_HOME",
  "NVM_DIR",
  "VOLTA_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "JAZZ_HOME",
  "JAZZ_CONFIG_PATH",
]);

const UPDATER_ENVIRONMENT_PREFIXES: readonly string[] = ["LC_", "XDG_"];

/**
 * The environment of the detached updater. The package manager it runs executes install
 * scripts, so it receives only what locating and fetching the package needs; API keys and
 * other credentials in the caller's environment stay behind.
 */
export function buildUpdaterEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const updaterEnvironment: Record<string, string> = { JAZZ_DISABLE_UPDATE_CHECK: "1" };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }
    if (
      UPDATER_ENVIRONMENT_NAMES.has(name) ||
      UPDATER_ENVIRONMENT_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      updaterEnvironment[name] = value;
    }
  }
  return updaterEnvironment;
}

/**
 * Starts `jazz update --background` as a detached process that outlives this one.
 *
 * @returns Whether the operating system started the process.
 */
function launchBackgroundUpdate(logger: LoggerService): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const invocation = yield* getJazzSchedulerInvocation();
    const [command, ...baseArguments] = invocation;
    if (!command) {
      yield* logger.warn("Failed to launch background update", { errorType: "no_invocation" });
      return false;
    }
    const { spawn } = yield* Effect.promise(() => import("node:child_process"));
    return yield* Effect.callback<boolean>((resume) => {
      const reportFailure = (cause: unknown): void => {
        resume(
          logger
            .warn("Failed to launch background update", {
              errorType: "spawn_failed",
              reason: String(cause),
            })
            .pipe(Effect.as(false)),
        );
      };
      try {
        const child = spawn(command, [...baseArguments, "update", "--background"], {
          detached: true,
          stdio: "ignore",
          env: buildUpdaterEnvironment(process.env),
        });
        child.once("error", reportFailure);
        child.once("spawn", () => {
          child.unref();
          resume(logger.debug("Background update launched", { command }).pipe(Effect.as(true)));
        });
      } catch (cause) {
        reportFailure(cause);
      }
    });
  });
}

/**
 * Where the update notice may appear. The interactive UI owns the terminal and
 * shows it in place. A plain terminal writes it to stderr, and only when stderr
 * is a terminal, so piped output and log files never carry it.
 */
export function updateBannerDestination(
  terminalIsInteractive: boolean,
  stderrIsTTY: boolean | undefined,
): "terminal" | "stderr" | "none" {
  if (terminalIsInteractive) {
    return "terminal";
  }
  return stderrIsTTY === true ? "stderr" : "none";
}

/** The boxed "update available" notice, one entry per line. */
function formatUpdateBanner(
  currentVersion: string,
  latestVersion: string,
  installingInBackground: boolean,
): readonly string[] {
  const glyphs = getGlyphs();
  const innerWidth = UPDATE_BANNER_INNER_WIDTH;
  const horizontal = glyphs.boxH.repeat(innerWidth);
  const blank = " ".repeat(innerWidth);
  const versions = `Update available! ${currentVersion} ${glyphs.arrow} ${latestVersion}`;
  const upgrade = installingInBackground
    ? "Installing in the background; ready on your next launch."
    : "Run `jazz update` to upgrade to the latest version.";
  const padLine = (message: string): string => {
    const pad = innerWidth - message.length - 3; // 3 = leading "  "+1 trailing space
    return `${glyphs.boxV}  ${message}${" ".repeat(Math.max(0, pad))} ${glyphs.boxV}`;
  };
  return [
    "",
    `${glyphs.boxTL}${horizontal}${glyphs.boxTR}`,
    `${glyphs.boxV}${blank}${glyphs.boxV}`,
    padLine(versions),
    padLine(upgrade),
    `${glyphs.boxV}${blank}${glyphs.boxV}`,
    `${glyphs.boxBL}${horizontal}${glyphs.boxBR}`,
    "  See what's new: https://github.com/lvndry/jazz/releases",
    "",
  ];
}
