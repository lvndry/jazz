import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { AgentConfigServiceTag, type AgentConfigService } from "../../core/interfaces/agent-config";
import { GmailServiceTag, type GmailService } from "../../core/interfaces/gmail";
import { LoggerServiceTag, type LoggerService } from "../../core/interfaces/logger";
import { TerminalServiceTag, type TerminalService } from "../../core/interfaces/terminal";
import { GmailAuthenticationError } from "../../core/types/errors";
import { resolveStorageDirectory } from "../../services/storage/utils";

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
 * Gmail login command - initiates OAuth flow
 */
export function gmailLoginCommand(): Effect.Effect<
  void,
  GmailAuthenticationError,
  GmailService | LoggerService | AgentConfigService | TerminalService
> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const gmailService = yield* GmailServiceTag;
    const terminal = yield* TerminalServiceTag;

    yield* logger.info("Starting Gmail authentication...");
    yield* terminal.info("Starting Gmail authentication...");

    yield* gmailService.authenticate();
    yield* logger.info("Gmail authentication completed successfully");
    yield* terminal.success("Gmail authentication successful!");
    yield* terminal.log("You can now use Gmail tools with your agents.");
  });
}

/**
 * Gmail logout command - removes stored tokens
 */
export function gmailLogoutCommand(): Effect.Effect<
  void,
  never,
  FileSystem.FileSystem | AgentConfigService | LoggerService | TerminalService
> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* AgentConfigServiceTag;
    const terminal = yield* TerminalServiceTag;

    yield* logger.info("Starting Gmail logout process...");
    yield* terminal.info("Logging out of Gmail...");

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

      yield* logger.info("Gmail token removed successfully");
      yield* terminal.success("Successfully logged out of Gmail");
      yield* terminal.log("Your authentication tokens have been removed.");
    } else {
      yield* logger.info("No Gmail token found to remove");
      yield* terminal.info("No Gmail authentication found");
      yield* terminal.log("You were not logged in to Gmail.");
    }
  });
}

/**
 * Check Gmail authentication status
 */
export function gmailStatusCommand(): Effect.Effect<
  void,
  never,
  FileSystem.FileSystem | AgentConfigService | LoggerService | TerminalService
> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* AgentConfigServiceTag;
    const terminal = yield* TerminalServiceTag;

    yield* logger.info("Checking Gmail authentication status...");
    yield* terminal.info("Checking Gmail authentication status...");

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
          const expiryDate = token.expiry_date ? new Date(token.expiry_date) : null;
          const isExpired = expiryDate ? expiryDate < new Date() : false;

          yield* logger.info("Gmail token found and parsed", {
            hasAccessToken: !!token.access_token,
            hasRefreshToken: !!token.refresh_token,
            isExpired,
          });

          yield* terminal.success("Gmail authentication status:");
          yield* terminal.log(`   Status: ${isExpired ? "Expired" : "Active"}`);
          yield* terminal.log(`   Access Token: ${token.access_token ? "Present" : "Missing"}`);
          yield* terminal.log(`   Refresh Token: ${token.refresh_token ? "Present" : "Missing"}`);
          if (expiryDate) {
            yield* terminal.log(`   Expires: ${expiryDate.toLocaleString()}`);
          }
          if (token.scope) {
            yield* terminal.log(`   Scopes: ${token.scope}`);
          }
        } catch (parseError) {
          yield* logger.error("Failed to parse Gmail token", { error: parseError });
          yield* terminal.warn("Gmail token file exists but is corrupted");
          yield* terminal.log("   Run 'jazz auth gmail logout' to clean up and re-authenticate");
        }
      } else {
        yield* logger.info("Gmail token file is empty");
        yield* terminal.warn("Gmail token file exists but is empty");
        yield* terminal.log("   Run 'jazz auth gmail logout' to clean up and re-authenticate");
      }
    } else {
      yield* logger.info("No Gmail token found");
      yield* terminal.error("Gmail authentication status:");
      yield* terminal.log("   Status: Not authenticated");
      yield* terminal.log("   Run 'jazz auth gmail login' to authenticate");
    }
  });
}
