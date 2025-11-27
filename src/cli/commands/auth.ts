import { FileSystem } from "@effect/platform";
import { Effect } from "effect";

import { AgentConfigServiceTag, type AgentConfigService } from "../../core/interfaces/agent-config";
import { GmailServiceTag, type GmailService } from "../../core/interfaces/gmail";
import { LoggerServiceTag, type LoggerService } from "../../core/interfaces/logger";
import { TerminalServiceTag, type TerminalService } from "../../core/interfaces/terminal";
import { GmailAuthenticationError } from "../../core/types/errors";
import { resolveStorageDirectory } from "../../core/utils/storage-utils";

/**
 * CLI commands for authentication management
 */

interface GoogleOAuthToken {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date?: number;
}

/**
 * Unified Google login command - initiates OAuth flow for Gmail and Calendar
 */
export function googleLoginCommand(): Effect.Effect<
  void,
  GmailAuthenticationError,
  GmailService | LoggerService | AgentConfigService | TerminalService
> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const gmailService = yield* GmailServiceTag;
    const terminal = yield* TerminalServiceTag;

    yield* logger.info("Starting Google authentication...");
    yield* terminal.info("Starting Google authentication...");
    yield* terminal.log("This will authenticate you for both Gmail and Calendar services.");

    yield* gmailService.authenticate();
    yield* logger.info("Google authentication completed successfully");
    yield* terminal.success("Google authentication successful!");
    yield* terminal.log("You can now use Gmail and Calendar tools with your agents.");
  });
}

/**
 * Unified Google logout command - removes stored tokens
 */
export function googleLogoutCommand(): Effect.Effect<
  void,
  never,
  FileSystem.FileSystem | AgentConfigService | LoggerService | TerminalService
> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* AgentConfigServiceTag;
    const terminal = yield* TerminalServiceTag;

    yield* logger.info("Starting Google logout process...");
    yield* terminal.info("Logging out of Google...");

    // Get the token file path from config
    const { storage } = yield* config.appConfig;
    const dataDir = resolveStorageDirectory(storage);
    const tokenFilePath = `${dataDir}/google/gmail-token.json`;

    // Check if token file exists
    const tokenExists = yield* fs
      .exists(tokenFilePath)
      .pipe(Effect.catchAll(() => Effect.succeed(false)));

    if (tokenExists) {
      // Remove the token file
      yield* fs.remove(tokenFilePath).pipe(
        Effect.catchAll((error) => {
          return Effect.gen(function* () {
            yield* logger.error("Failed to remove token file", { error });
            yield* terminal.warn("Warning: Could not remove token file:");
            yield* terminal.log(`   ${error instanceof Error ? error.message : String(error)}`);
          });
        }),
      );

      yield* logger.info("Google token removed successfully");
      yield* terminal.success("Successfully logged out of Google");
      yield* terminal.log("Your authentication tokens have been removed.");
      yield* terminal.log("This affects both Gmail and Calendar services.");
    } else {
      yield* logger.info("No Google token found to remove");
      yield* terminal.info("No Google authentication found");
      yield* terminal.log("You were not logged in to Google.");
    }
  });
}

/**
 * Unified Google status command - checks authentication status
 */
export function googleStatusCommand(): Effect.Effect<
  void,
  never,
  FileSystem.FileSystem | AgentConfigService | LoggerService | TerminalService
> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* AgentConfigServiceTag;
    const terminal = yield* TerminalServiceTag;

    yield* logger.info("Checking Google authentication status...");
    yield* terminal.info("Checking Google authentication status...");

    // Get the token file path from config
    const { storage } = yield* config.appConfig;
    const dataDir = resolveStorageDirectory(storage);
    const tokenFilePath = `${dataDir}/google/gmail-token.json`;

    // Check if token file exists
    const tokenExists = yield* fs
      .exists(tokenFilePath)
      .pipe(Effect.catchAll(() => Effect.succeed(false)));

    if (tokenExists) {
      // Try to read and parse the token
      const tokenContent = yield* fs
        .readFileString(tokenFilePath)
        .pipe(Effect.catchAll(() => Effect.succeed("")));

      if (tokenContent) {
        try {
          const token = JSON.parse(tokenContent) as GoogleOAuthToken;

          yield* logger.info("Google token found and parsed", {
            hasAccessToken: !!token.access_token,
            hasRefreshToken: !!token.refresh_token,
          });

          yield* terminal.success("Google authentication status:");
          yield* terminal.log(`   Access Token: ${token.access_token ? "Present" : "Missing"}`);
          yield* terminal.log(`   Refresh Token: ${token.refresh_token ? "Present" : "Missing"}`);

          if (token.scope) {
            yield* terminal.log(`   Scopes: ${token.scope}`);
          }

          yield* terminal.log("");
          yield* terminal.log("   Services enabled:");
          yield* terminal.log("   ✓ Gmail");
          yield* terminal.log("   ✓ Calendar");
        } catch (parseError) {
          yield* logger.error("Failed to parse Google token", { error: parseError });
          yield* terminal.warn("Google token file exists but is corrupted");
          yield* terminal.log("   Run 'jazz auth google logout' to clean up and re-authenticate");
        }
      } else {
        yield* logger.info("Google token file is empty");
        yield* terminal.warn("Google token file exists but is empty");
        yield* terminal.log("   Run 'jazz auth google logout' to clean up and re-authenticate");
      }
    } else {
      yield* logger.info("No Google token found");
      yield* terminal.error("Google authentication status:");
      yield* terminal.log("   Status: Not authenticated");
      yield* terminal.log("   Run 'jazz auth google login' to authenticate");
    }
  });
}
