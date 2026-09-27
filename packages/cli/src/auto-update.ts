/**
 * Startup update check: throttled to once per UPDATE_CHECK_INTERVAL_DAYS via a
 * timestamp file, so it doesn't hit the registry on every invocation.
 */

import { FileSystem } from "@effect/platform";
import { LoggerServiceTag, type LoggerService } from "@jazz/core/interfaces/logger";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import { getUserDataDirectory } from "@jazz/core/utils/paths";
import { Effect } from "effect";
import { checkForUpdate } from "./commands/update";
import { getGlyphs } from "./ui/glyphs";

const UPDATE_CHECK_INTERVAL_DAYS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_FILE = "update_check";
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
    yield* fs.makeDirectory(dataDir, { recursive: true }).pipe(Effect.catchAll(() => Effect.void));

    // Read last check timestamp
    const lastCheckStr = yield* fs
      .readFileString(checkFilePath)
      .pipe(Effect.catchAll(() => Effect.succeed("0")));

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
      Effect.catchAll(() => {
        // Log error but don't fail the program
        return Effect.gen(function* () {
          yield* logger.debug("Auto-update check failed", { errorType: "check_failed" });
          return null; // Return null to indicate failure/timeout
        });
      }),
    );

    // Update the last check timestamp regardless of result to avoid blocking startup repeatedly on failures
    yield* fs.writeFileString(checkFilePath, now.toString()).pipe(
      Effect.catchAll(() =>
        Effect.gen(function* () {
          yield* logger.warn("Failed to write update check timestamp", {
            errorType: "state_write_failed",
          });
        }),
      ),
    );

    if (!result) {
      // Check failed or timed out
      return;
    }
    if (!result.hasUpdate) {
      return;
    }
    const destination = updateBannerDestination(terminal.isInteractive, process.stderr.isTTY);
    if (destination === "none") {
      return;
    }
    const lines = formatUpdateBanner(result.currentVersion, result.latestVersion);
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
function formatUpdateBanner(currentVersion: string, latestVersion: string): readonly string[] {
  const glyphs = getGlyphs();
  const innerWidth = UPDATE_BANNER_INNER_WIDTH;
  const horizontal = glyphs.boxH.repeat(innerWidth);
  const blank = " ".repeat(innerWidth);
  const versions = `Update available! ${currentVersion} ${glyphs.arrow} ${latestVersion}`;
  const upgrade = "Run `jazz update` to upgrade to the latest version.";
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
