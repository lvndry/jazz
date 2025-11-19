import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { AgentConfigService, type ConfigService } from "../../services/config";
import { GmailAuthenticationError, GmailServiceTag, type GmailService } from "../../services/gmail";
import { LoggerServiceTag, type LoggerService } from "../../services/logger";
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
  GmailService | LoggerService | ConfigService
> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const gmailService = yield* GmailServiceTag;

    yield* logger.info("Starting Gmail authentication...");
    console.log("🔐 Starting Gmail authentication process...");

    yield* gmailService.authenticate();
    yield* logger.info("Gmail authentication completed successfully");
    console.log("✅ Gmail authentication successful!");
    console.log("You can now use Gmail tools with your agents.");
  });
}

/**
 * Gmail logout command - removes stored tokens
 */
export function gmailLogoutCommand(): Effect.Effect<
  void,
  never,
  FileSystem.FileSystem | ConfigService | LoggerService
> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* AgentConfigService;

    yield* logger.info("Starting Gmail logout process...");
    console.log("🚪 Logging out of Gmail...");

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
            console.log("⚠️  Warning: Could not remove token file:");
            console.log(`   ${error instanceof Error ? error.message : String(error)}`);
          });
        }),
      );

      yield* logger.info("Gmail token removed successfully");
      console.log("✅ Successfully logged out of Gmail");
      console.log("Your authentication tokens have been removed.");
    } else {
      yield* logger.info("No Gmail token found to remove");
      console.log("ℹ️  No Gmail authentication found");
      console.log("You were not logged in to Gmail.");
    }
  });
}

/**
 * Check Gmail authentication status
 */
export function gmailStatusCommand(): Effect.Effect<
  void,
  never,
  FileSystem.FileSystem | ConfigService | LoggerService
> {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* AgentConfigService;

    yield* logger.info("Checking Gmail authentication status...");
    console.log("🔍 Checking Gmail authentication status...");

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

          console.log("✅ Gmail authentication status:");
          console.log(`   Status: ${isExpired ? "Expired" : "Active"}`);
          console.log(`   Access Token: ${token.access_token ? "Present" : "Missing"}`);
          console.log(`   Refresh Token: ${token.refresh_token ? "Present" : "Missing"}`);
          if (expiryDate) {
            console.log(`   Expires: ${expiryDate.toLocaleString()}`);
          }
          if (token.scope) {
            console.log(`   Scopes: ${token.scope}`);
          }
        } catch (parseError) {
          yield* logger.error("Failed to parse Gmail token", { error: parseError });
          console.log("⚠️  Gmail token file exists but is corrupted");
          console.log("   Run 'jazz auth gmail logout' to clean up and re-authenticate");
        }
      } else {
        yield* logger.info("Gmail token file is empty");
        console.log("⚠️  Gmail token file exists but is empty");
        console.log("   Run 'jazz auth gmail logout' to clean up and re-authenticate");
      }
    } else {
      yield* logger.info("No Gmail token found");
      console.log("❌ Gmail authentication status:");
      console.log("   Status: Not authenticated");
      console.log("   Run 'jazz auth gmail login' to authenticate");
    }
  });
}
