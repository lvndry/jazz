import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import { TerminalServiceTag, type TerminalService } from "@/core/interfaces/terminal";
import { getUserDataDirectory } from "@/core/utils/runtime-detection";
import { checkForUpdate, fetchReleaseNotesSince } from "./commands/update";

const UPDATE_CHECK_INTERVAL_HOURS = 72;
const MS_PER_HOUR = 60 * 60 * 1000;
const UPDATE_CHECK_FILE = "update_check";

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
    if (now - lastCheck < UPDATE_CHECK_INTERVAL_HOURS * MS_PER_HOUR) {
      return;
    }

    yield* logger.debug("Checking for updates (auto-check triggered)...");

    // Perform the check with a timeout to avoid blocking startup for too long
    const result = yield* checkForUpdate().pipe(
      Effect.timeout(2000), // 2 seconds timeout
      Effect.catchAll((error) => {
        // Log error but don't fail the program
        return Effect.gen(function* () {
          yield* logger.debug(`Auto-update check failed: ${String(error)}`);
          return null; // Return null to indicate failure/timeout
        });
      }),
    );

    // Update the last check timestamp regardless of result to avoid blocking startup repeatedly on failures
    yield* fs.writeFileString(checkFilePath, now.toString()).pipe(
      Effect.catchAll((err) =>
        Effect.gen(function* () {
          yield* logger.debug(`Failed to write update check file: ${String(err)}`);
        }),
      ),
    );

    if (!result) {
      // Check failed or timed out
      return;
    }

    if (result.hasUpdate) {
      yield* terminal.log("");
      yield* terminal.log(`╭─────────────────────────────────────────────────────────────────╮`);
      yield* terminal.log(`│                                                                 │`);
      yield* terminal.log(
        `│   Update available! ${result.currentVersion} → ${result.latestVersion}                              │`,
      );
      yield* terminal.log(`│   Run \`jazz update\` to upgrade to the latest version.           │`);
      yield* terminal.log(`│                                                                 │`);
      yield* terminal.log(`╰─────────────────────────────────────────────────────────────────╯`);

      // Fetch and display release notes since current version
      const releaseNotes = yield* fetchReleaseNotesSince(result.currentVersion).pipe(
        Effect.timeout(3000), // 3 seconds timeout for release notes
        Effect.catchAll(() => Effect.succeed(null)),
      );

      if (releaseNotes && releaseNotes.length > 0) {
        yield* terminal.log("");
        yield* terminal.log("📋 What's new:");
        for (const release of releaseNotes) {
          yield* terminal.log(`   ${release.version}: ${release.summary}`);
        }
      }

      yield* terminal.log("");
    }
  });
}
