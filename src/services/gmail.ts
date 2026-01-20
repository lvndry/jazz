import http from "node:http";
import { FileSystem } from "@effect/platform";
import { gmail, auth, type gmail_v1 } from "@googleapis/gmail";
import { Effect, Layer } from "effect";
import open from "open";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import { GmailServiceTag, type GmailService } from "@/core/interfaces/gmail";
import type { LoggerService } from "@/core/interfaces/logger";
import { TerminalServiceTag, type TerminalService } from "@/core/interfaces/terminal";
import { GmailAuthenticationError, GmailOperationError } from "@/core/types/errors";
import type { GmailEmail, GmailLabel } from "@/core/types/gmail";
import { getHttpStatusFromError } from "@/core/utils/http-utils";
import { resolveStorageDirectory } from "@/core/utils/storage-utils";
import {
  ALL_GOOGLE_SCOPES,
  GMAIL_REQUIRED_SCOPES,
  getGoogleOAuthPort,
  getGoogleOAuthRedirectUri,
  getGoogleTokenFilePath,
  hasAnyRequiredScope,
  type GoogleOAuthToken,
} from "./google/auth";

/**
 * Gmail service for interacting with Gmail API
 * Implements the core GmailService interface
 */

export class GmailServiceResource implements GmailService {
  constructor(
    private readonly fs: FileSystem.FileSystem,
    private readonly tokenFilePath: string,
    private oauthClient: InstanceType<typeof auth.OAuth2>,
    private gmailClient: gmail_v1.Gmail,
    private readonly requireCredentials: () => Effect.Effect<void, GmailAuthenticationError>,
    private readonly terminal: TerminalService,
  ) {}

  authenticate(): Effect.Effect<void, GmailAuthenticationError> {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        const exists = yield* this.readTokenIfExists();
        if (!exists) {
          yield* this.performOAuthFlow();
        } else {
          // Validate the token by attempting to refresh it
          // If refresh fails with invalid_grant, the token is invalid and we need to re-authenticate
          const validationResult = yield* this.validateAndRefreshToken().pipe(
            Effect.map(() => true as const),
            Effect.catchAll((error) => {
              // If token refresh fails with invalid_grant, token is invalid - need to re-authenticate
              const errorMessage = error.message || String(error);
              if (
                errorMessage.includes("invalid_grant") ||
                errorMessage.includes("Failed to refresh")
              ) {
                return Effect.succeed(false as const);
              }
              // For other errors, propagate them
              return Effect.fail(error);
            }),
          );

          if (!validationResult) {
            // Token is invalid, remove it and re-authenticate
            yield* this.fs.remove(this.tokenFilePath).pipe(Effect.catchAll(() => Effect.void));
            yield* this.performOAuthFlow();
          }
        }
        return void 0;
      }.bind(this),
    );
  }

  listEmails(
    maxResults: number = 10,
    query?: string,
  ): Effect.Effect<GmailEmail[], GmailOperationError | GmailAuthenticationError> {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        yield* this.ensureAuthenticated();
        const paramsList: gmail_v1.Params$Resource$Users$Messages$List =
          query !== undefined && query !== ""
            ? { userId: "me", maxResults, q: query }
            : { userId: "me", maxResults };
        const listResp = yield* this.wrapGmailCall(
          () => this.gmailClient.users.messages.list(paramsList),
          "Failed to list emails",
        );
        const messages = listResp.data.messages || [];
        if (messages.length === 0) return [];
        const emails: GmailEmail[] = [];
        for (const message of messages) {
          if (!message.id) continue;
          const paramsGet: gmail_v1.Params$Resource$Users$Messages$Get = {
            userId: "me",
            id: message.id,
            format: "metadata",
            metadataHeaders: ["Subject", "From", "To", "Date", "Cc", "Bcc"],
          };
          const full = yield* this.wrapGmailCall(
            () => this.gmailClient.users.messages.get(paramsGet),
            "Failed to fetch email metadata",
          );
          const email = this.parseMessageToEmail(full.data);
          emails.push(email);
        }
        return emails;
      }.bind(this),
    );
  }

  getEmail(
    emailId: string,
  ): Effect.Effect<GmailEmail, GmailOperationError | GmailAuthenticationError> {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        yield* this.ensureAuthenticated();
        const paramsGet: gmail_v1.Params$Resource$Users$Messages$Get = {
          userId: "me",
          id: emailId,
          format: "full",
        };
        const full = yield* this.wrapGmailCall(
          () => this.gmailClient.users.messages.get(paramsGet),
          "Failed to get email",
        );
        const email = this.parseMessageToEmail(full.data, true);
        return email;
      }.bind(this),
    );
  }

  sendEmail(
    to: ReadonlyArray<string>,
    subject: string,
    body: string,
    options?: {
      readonly cc?: ReadonlyArray<string>;
      readonly bcc?: ReadonlyArray<string>;
      readonly attachments?: ReadonlyArray<{
        readonly filename: string;
        readonly content: string | Buffer;
        readonly contentType?: string;
      }>;
    },
  ): Effect.Effect<void, GmailOperationError | GmailAuthenticationError> {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        yield* this.ensureAuthenticated();
        const raw = this.buildRawEmail({
          to: [...to],
          subject,
          body,
          cc: options?.cc ? [...options.cc] : [],
          bcc: options?.bcc ? [...options.bcc] : [],
        });
        // Attachments not implemented in this first pass
        yield* this.wrapGmailCall(
          () =>
            this.gmailClient.users.drafts.create({
              userId: "me",
              requestBody: { message: { raw } },
            }),
          "Failed to create draft",
        );
        return void 0;
      }.bind(this),
    );
  }

  searchEmails(
    query: string,
    maxResults: number = 10,
  ): Effect.Effect<GmailEmail[], GmailOperationError | GmailAuthenticationError> {
    return this.listEmails(maxResults, query);
  }

  // Label management methods
  listLabels(): Effect.Effect<GmailLabel[], GmailOperationError | GmailAuthenticationError> {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        yield* this.ensureAuthenticated();
        const response = yield* this.wrapGmailCall(
          () => this.gmailClient.users.labels.list({ userId: "me" }),
          "Failed to list labels",
        );
        const labels = (response.data.labels || []).map((label) =>
          this.parseLabelToGmailLabel(label),
        );
        return labels;
      }.bind(this),
    );
  }

  createLabel(
    name: string,
    options?: {
      labelListVisibility?: "labelShow" | "labelHide";
      messageListVisibility?: "show" | "hide";
      color?: { textColor: string; backgroundColor: string };
    },
  ): Effect.Effect<GmailLabel, GmailOperationError | GmailAuthenticationError> {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        yield* this.ensureAuthenticated();
        const requestBody: gmail_v1.Schema$Label = {
          name,
          ...(options?.labelListVisibility && {
            labelListVisibility: options.labelListVisibility,
          }),
          ...(options?.messageListVisibility && {
            messageListVisibility: options.messageListVisibility,
          }),
          ...(options?.color && { color: options.color }),
        };
        const response = yield* this.wrapGmailCall(
          () => this.gmailClient.users.labels.create({ userId: "me", requestBody }),
          "Failed to create label",
        );
        return this.parseLabelToGmailLabel(response.data);
      }.bind(this),
    );
  }

  updateLabel(
    labelId: string,
    updates: {
      name?: string;
      labelListVisibility?: "labelShow" | "labelHide";
      messageListVisibility?: "show" | "hide";
      color?: { textColor: string; backgroundColor: string };
    },
  ): Effect.Effect<GmailLabel, GmailOperationError | GmailAuthenticationError> {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        yield* this.ensureAuthenticated();
        const requestBody: gmail_v1.Schema$Label = {};
        if (updates.name !== undefined) requestBody.name = updates.name;
        if (updates.labelListVisibility !== undefined)
          requestBody.labelListVisibility = updates.labelListVisibility;
        if (updates.messageListVisibility !== undefined)
          requestBody.messageListVisibility = updates.messageListVisibility;
        if (updates.color !== undefined) requestBody.color = updates.color;

        const response = yield* this.wrapGmailCall(
          () =>
            this.gmailClient.users.labels.update({
              userId: "me",
              id: labelId,
              requestBody,
            }),
          "Failed to update label",
        );
        return this.parseLabelToGmailLabel(response.data);
      }.bind(this),
    );
  }

  deleteLabel(
    labelId: string,
  ): Effect.Effect<void, GmailOperationError | GmailAuthenticationError> {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        yield* this.ensureAuthenticated();
        yield* this.wrapGmailCall(
          () => this.gmailClient.users.labels.delete({ userId: "me", id: labelId }),
          "Failed to delete label",
        );
        return void 0;
      }.bind(this),
    );
  }

  // Email modification methods
  modifyEmail(
    emailId: string,
    options: {
      readonly addLabelIds?: ReadonlyArray<string>;
      readonly removeLabelIds?: ReadonlyArray<string>;
    },
  ): Effect.Effect<GmailEmail, GmailOperationError | GmailAuthenticationError> {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        yield* this.ensureAuthenticated();
        const requestBody: gmail_v1.Schema$ModifyMessageRequest = {};
        if (options.addLabelIds) requestBody.addLabelIds = [...options.addLabelIds];
        if (options.removeLabelIds) requestBody.removeLabelIds = [...options.removeLabelIds];

        const response = yield* this.wrapGmailCall(
          () =>
            this.gmailClient.users.messages.modify({
              userId: "me",
              id: emailId,
              requestBody,
            }),
          "Failed to modify email",
        );
        return this.parseMessageToEmail(response.data);
      }.bind(this),
    );
  }

  batchModifyEmails(
    emailIds: ReadonlyArray<string>,
    options: {
      readonly addLabelIds?: ReadonlyArray<string>;
      readonly removeLabelIds?: ReadonlyArray<string>;
    },
  ): Effect.Effect<void, GmailOperationError | GmailAuthenticationError> {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        yield* this.ensureAuthenticated();
        const requestBody: gmail_v1.Schema$BatchModifyMessagesRequest = {
          ids: [...emailIds],
        };
        if (options.addLabelIds) requestBody.addLabelIds = [...options.addLabelIds];
        if (options.removeLabelIds) requestBody.removeLabelIds = [...options.removeLabelIds];

        yield* this.wrapGmailCall(
          () =>
            this.gmailClient.users.messages.batchModify({
              userId: "me",
              requestBody,
            }),
          "Failed to batch modify emails",
        );
        return void 0;
      }.bind(this),
    );
  }

  trashEmail(emailId: string): Effect.Effect<void, GmailOperationError | GmailAuthenticationError> {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        yield* this.ensureAuthenticated();
        yield* this.wrapGmailCall(
          () => this.gmailClient.users.messages.trash({ userId: "me", id: emailId }),
          "Failed to trash email",
        );
        return void 0;
      }.bind(this),
    );
  }

  deleteEmail(
    emailId: string,
  ): Effect.Effect<void, GmailOperationError | GmailAuthenticationError> {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        yield* this.ensureAuthenticated();
        yield* this.wrapGmailCall(
          () => this.gmailClient.users.messages.delete({ userId: "me", id: emailId }),
          "Failed to delete email",
        );
        return void 0;
      }.bind(this),
    );
  }

  private ensureAuthenticated(): Effect.Effect<void, GmailAuthenticationError> {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        // Fail fast if credentials are missing when a Gmail operation is invoked
        yield* this.requireCredentials();
        const tokenLoaded = yield* this.readTokenIfExists();
        if (!tokenLoaded) {
          yield* this.performOAuthFlow();
        } else {
          yield* this.validateAndRefreshToken();
        }
        return void 0;
      }.bind(this),
    );
  }

  private readTokenIfExists(): Effect.Effect<boolean, GmailAuthenticationError> {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        const token = yield* this.fs.readFileString(this.tokenFilePath).pipe(
          Effect.mapError(() => undefined),
          Effect.catchAll(() => Effect.succeed(undefined as unknown as string)),
        );
        if (!token) return false;
        try {
          const parsed = JSON.parse(token) as GoogleOAuthToken;
          // Check if token has required Gmail scopes
          if (!hasAnyRequiredScope(parsed, GMAIL_REQUIRED_SCOPES)) {
            // Token exists but doesn't have required scopes, need to re-authenticate
            return false;
          }
          this.oauthClient.setCredentials(parsed);
          return true;
        } catch {
          return false;
        }
      }.bind(this),
    );
  }

  private validateAndRefreshToken(): Effect.Effect<void, GmailAuthenticationError> {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        const credentials = this.oauthClient.credentials as GoogleOAuthToken;

        // Check if access token exists
        if (!credentials.access_token) {
          throw new GmailAuthenticationError({
            message:
              "Access token is missing. Please run 'bun run cli auth google login' to authenticate.",
          });
        }

        // Check if token is expired (with 5 minute buffer for clock skew)
        const now = Date.now();
        const expiryDate = credentials.expiry_date;
        const isExpired = expiryDate !== undefined && expiryDate <= now + 5 * 60 * 1000;

        if (isExpired) {
          // Try to refresh the token
          if (!credentials.refresh_token) {
            throw new GmailAuthenticationError({
              message:
                "Access token expired and no refresh token available. Please run 'bun run cli auth google login' to re-authenticate.",
            });
          }

          try {
            // Attempt to refresh the token
            const refreshed = yield* Effect.tryPromise({
              try: () => this.oauthClient.refreshAccessToken(),
              catch: (err) =>
                new GmailAuthenticationError({
                  message: `Failed to refresh access token: ${err instanceof Error ? err.message : String(err)}. Please run 'bun run cli auth google login' to re-authenticate.`,
                }),
            });

            // Update credentials with refreshed token
            this.oauthClient.setCredentials(refreshed.credentials);
            // Persist the refreshed token
            yield* this.persistToken(refreshed.credentials as GoogleOAuthToken);
          } catch {
            throw new GmailAuthenticationError({
              message:
                "Failed to refresh access token. Please run 'bun run cli auth google login' to re-authenticate.",
            });
          }
        }
      }.bind(this),
    );
  }

  private performOAuthFlow(): Effect.Effect<void, GmailAuthenticationError> {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        const port = getGoogleOAuthPort();
        const redirectUri = getGoogleOAuthRedirectUri(port);
        // Recreate OAuth client with runtime redirectUri (property is readonly)
        const currentCreds = this.oauthClient.credentials as GoogleOAuthToken;
        const clientId = this.oauthClient._clientId;
        if (!clientId) {
          throw new GmailAuthenticationError({ message: "Missing client ID" });
        }
        const clientSecret = this.oauthClient._clientSecret;
        if (!clientSecret) {
          throw new GmailAuthenticationError({ message: "Missing client secret" });
        }
        const freshClient = new auth.OAuth2({
          clientId,
          clientSecret,
          redirectUri,
        });
        freshClient.setCredentials(currentCreds);
        this.oauthClient = freshClient;
        this.gmailClient = gmail({ version: "v1", auth: this.oauthClient });

        // Include both Gmail and Calendar scopes since they share the same token file
        const scopes = ALL_GOOGLE_SCOPES;

        const authUrl = this.oauthClient.generateAuthUrl({
          access_type: "offline",
          scope: [...scopes],
          prompt: "consent",
        });

        // Start local server to capture the OAuth code
        const code = yield* Effect.async<string, GmailAuthenticationError>((resume) => {
          const server = http.createServer((req, res) => {
            if (!req.url) return;
            const url = new URL(req.url, `http://localhost:${port}`);
            if (url.pathname === "/oauth2callback") {
              const codeParam = url.searchParams.get("code");
              if (codeParam) {
                res.writeHead(200, { "Content-Type": "text/html" });
                res.end(
                  "<html><body><h1>Authentication successful</h1>You can close this window.</body></html>",
                );
                server.close(() => resume(Effect.succeed(codeParam)));
              } else {
                res.writeHead(400);
                res.end("Missing code");
              }
            } else {
              res.writeHead(404);
              res.end("Not found");
            }
          });
          server.listen(port, () => {
            void open(authUrl).catch(() => {
              // ignore browser open failures; user can copy URL
            });
            // Also print URL to terminal for visibility in CLI
            void Effect.runPromise(
              this.terminal.log(
                `Open this URL in your browser to authenticate with Google: ${authUrl}`,
              ),
            );
          });
        });

        try {
          const tokenResp = (yield* Effect.promise(() => this.oauthClient.getToken(code))) as {
            tokens: GoogleOAuthToken;
          };
          this.oauthClient.setCredentials(tokenResp.tokens);
          yield* this.persistToken(tokenResp.tokens);
        } catch (err) {
          throw new GmailAuthenticationError({
            message: `OAuth flow failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }.bind(this),
    );
  }

  private persistToken(token: GoogleOAuthToken): Effect.Effect<void, GmailAuthenticationError> {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        const dir = this.tokenFilePath.substring(0, this.tokenFilePath.lastIndexOf("/"));
        yield* this.fs
          .makeDirectory(dir, { recursive: true })
          .pipe(Effect.catchAll(() => Effect.void));
        const content = JSON.stringify(token, null, 2);
        yield* this.fs.writeFileString(this.tokenFilePath, content).pipe(
          Effect.mapError(
            (err) =>
              new GmailAuthenticationError({
                message: `Failed to persist token: ${String((err as Error).message ?? err)}`,
              }),
          ),
        );
      }.bind(this),
    );
  }

  private parseMessageToEmail(
    message: gmail_v1.Schema$Message,
    includeBody: boolean = false,
  ): GmailEmail {
    const headers = (message.payload?.headers ?? []).reduce<Record<string, string>>(
      (acc, header) => {
        if (header.name && header.value) acc[header.name.toLowerCase()] = header.value;
        return acc;
      },
      {},
    );
    const subject = headers["subject"] || "";
    const from = headers["from"] || "";
    const to = (headers["to"] || "").split(/,\s*/).filter(Boolean) as ReadonlyArray<string>;
    const cc = headers["cc"]
      ? (headers["cc"].split(/,\s*/).filter(Boolean) as ReadonlyArray<string>)
      : undefined;
    const bcc = headers["bcc"]
      ? (headers["bcc"].split(/,\s*/).filter(Boolean) as ReadonlyArray<string>)
      : undefined;
    const date = headers["date"] || new Date().toISOString();

    const attachments: GmailEmail["attachments"] = [];

    let bodyText: string | undefined;
    if (includeBody) {
      bodyText = this.extractPlainTextBody(message.payload);
    }

    return {
      id: message.id || "",
      threadId: message.threadId || "",
      subject,
      from,
      to,
      ...(cc ? { cc } : {}),
      ...(bcc ? { bcc } : {}),
      date,
      snippet: message.snippet || "",
      body: bodyText,
      labels: (message.labelIds || []) as ReadonlyArray<string>,
      attachments,
    };
  }

  private parseLabelToGmailLabel(label: gmail_v1.Schema$Label): GmailLabel {
    return {
      id: label.id || "",
      name: label.name || "",
      type: label.type === "system" ? "system" : "user",
      messagesTotal: label.messagesTotal ?? undefined,
      messagesUnread: label.messagesUnread ?? undefined,
      threadsTotal: label.threadsTotal ?? undefined,
      threadsUnread: label.threadsUnread ?? undefined,
      color: label.color
        ? {
            textColor: label.color.textColor || "#000000",
            backgroundColor: label.color.backgroundColor || "#ffffff",
          }
        : undefined,
      labelListVisibility: label.labelListVisibility as "labelShow" | "labelHide" | undefined,
      messageListVisibility: label.messageListVisibility as "show" | "hide" | undefined,
    };
  }

  private extractPlainTextBody(part?: gmail_v1.Schema$MessagePart): string | undefined {
    if (!part) return undefined;
    if (part.mimeType === "text/plain" && part.body?.data) {
      return Buffer.from(part.body.data, "base64").toString("utf8");
    }
    if (part.parts && part.parts.length > 0) {
      for (const p of part.parts) {
        const text = this.extractPlainTextBody(p);
        if (text) return text;
      }
    }
    return undefined;
  }

  private buildRawEmail(input: {
    to: string[];
    subject: string;
    body: string;
    cc?: string[];
    bcc?: string[];
  }): string {
    const lines = [
      `To: ${input.to.join(", ")}`,
      input.cc && input.cc.length > 0 ? `Cc: ${input.cc.join(", ")}` : undefined,
      input.bcc && input.bcc.length > 0 ? `Bcc: ${input.bcc.join(", ")}` : undefined,
      `Subject: ${input.subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 7bit",
      "",
      input.body,
    ].filter(Boolean) as string[];
    const message = lines.join("\r\n");
    return Buffer.from(message).toString("base64url");
  }

  private wrapGmailCall<A>(
    operation: () => Promise<A>,
    failureMessage: string,
  ): Effect.Effect<A, GmailOperationError | GmailAuthenticationError> {
    return Effect.tryPromise({
      try: operation,
      catch: (err) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const status = getHttpStatusFromError(err);

        // Check if this is an authentication error (invalid_grant, unauthorized, etc.)
        if (
          errorMessage.includes("invalid_grant") ||
          errorMessage.includes("invalid_token") ||
          errorMessage.includes("unauthorized") ||
          status === 401
        ) {
          return new GmailAuthenticationError({
            message: `${failureMessage}: ${errorMessage}`,
            suggestion: "Please run 'bun run cli auth google login' to re-authenticate.",
          });
        }

        return new GmailOperationError({
          message: `${failureMessage}: ${errorMessage}`,
          ...(status !== undefined ? { status } : {}),
        });
      },
    });
  }
}

// GmailServiceTag is exported from core/interfaces/gmail.ts

// Layer for providing the real Gmail service
export function createGmailServiceLayer(): Layer.Layer<
  GmailService,
  never,
  FileSystem.FileSystem | AgentConfigService | LoggerService | TerminalService
> {
  return Layer.effect(
    GmailServiceTag,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const terminal = yield* TerminalServiceTag;

      const agentConfig = yield* AgentConfigServiceTag;
      const appConfig = yield* agentConfig.appConfig;
      const clientId = appConfig.google?.clientId;
      const clientSecret = appConfig.google?.clientSecret;
      const missingCreds = !clientId || !clientSecret;

      function requireCredentials(): Effect.Effect<void, GmailAuthenticationError> {
        if (missingCreds) {
          return Effect.fail(
            new GmailAuthenticationError({
              message:
                "Missing Google OAuth credentials. Set config.google.clientId and config.google.clientSecret.",
            }),
          );
        }
        return Effect.void as Effect.Effect<void, GmailAuthenticationError>;
      }

      const port = getGoogleOAuthPort();
      const redirectUri = getGoogleOAuthRedirectUri(port);
      const oauth2Client = new auth.OAuth2(clientId, clientSecret, redirectUri);
      const gmailInstance = gmail({ version: "v1", auth: oauth2Client });

      const { storage } = yield* agentConfig.appConfig;
      const dataDir = resolveStorageDirectory(storage);
      const tokenFilePath = getGoogleTokenFilePath(dataDir);
      const service: GmailService = new GmailServiceResource(
        fs,
        tokenFilePath,
        oauth2Client,
        gmailInstance,
        requireCredentials,
        terminal,
      );

      return service;
    }),
  );
}

// Helper functions for common Gmail operations
export function authenticateGmail(): Effect.Effect<void, GmailAuthenticationError, GmailService> {
  return Effect.gen(function* () {
    const gmailService = yield* GmailServiceTag;
    return yield* gmailService.authenticate();
  });
}

export function listGmailEmails(
  maxResults?: number,
  query?: string,
): Effect.Effect<GmailEmail[], GmailOperationError | GmailAuthenticationError, GmailService> {
  return Effect.gen(function* () {
    const gmailService = yield* GmailServiceTag;
    return yield* gmailService.listEmails(maxResults, query);
  });
}

export function getGmailEmail(
  emailId: string,
): Effect.Effect<GmailEmail, GmailOperationError | GmailAuthenticationError, GmailService> {
  return Effect.gen(function* () {
    const gmailService = yield* GmailServiceTag;
    return yield* gmailService.getEmail(emailId);
  });
}

export function sendGmailEmail(
  to: string[],
  subject: string,
  body: string,
  options?: {
    cc?: string[];
    bcc?: string[];
    attachments?: Array<{
      filename: string;
      content: string | Buffer;
      contentType?: string;
    }>;
  },
): Effect.Effect<void, GmailOperationError | GmailAuthenticationError, GmailService> {
  return Effect.gen(function* () {
    const gmailService = yield* GmailServiceTag;
    return yield* gmailService.sendEmail(to, subject, body, options);
  });
}

export function searchGmailEmails(
  query: string,
  maxResults?: number,
): Effect.Effect<GmailEmail[], GmailOperationError | GmailAuthenticationError, GmailService> {
  return Effect.gen(function* () {
    const gmailService = yield* GmailServiceTag;
    return yield* gmailService.searchEmails(query, maxResults);
  });
}

// Label management helper functions
export function listGmailLabels(): Effect.Effect<
  GmailLabel[],
  GmailOperationError | GmailAuthenticationError,
  GmailService
> {
  return Effect.gen(function* () {
    const gmailService = yield* GmailServiceTag;
    return yield* gmailService.listLabels();
  });
}

export function createGmailLabel(
  name: string,
  options?: {
    labelListVisibility?: "labelShow" | "labelHide";
    messageListVisibility?: "show" | "hide";
    color?: { textColor: string; backgroundColor: string };
  },
): Effect.Effect<GmailLabel, GmailOperationError | GmailAuthenticationError, GmailService> {
  return Effect.gen(function* () {
    const gmailService = yield* GmailServiceTag;
    return yield* gmailService.createLabel(name, options);
  });
}

export function updateGmailLabel(
  labelId: string,
  updates: {
    name?: string;
    labelListVisibility?: "labelShow" | "labelHide";
    messageListVisibility?: "show" | "hide";
    color?: { textColor: string; backgroundColor: string };
  },
): Effect.Effect<GmailLabel, GmailOperationError | GmailAuthenticationError, GmailService> {
  return Effect.gen(function* () {
    const gmailService = yield* GmailServiceTag;
    return yield* gmailService.updateLabel(labelId, updates);
  });
}

export function deleteGmailLabel(
  labelId: string,
): Effect.Effect<void, GmailOperationError | GmailAuthenticationError, GmailService> {
  return Effect.gen(function* () {
    const gmailService = yield* GmailServiceTag;
    return yield* gmailService.deleteLabel(labelId);
  });
}

// Email modification helper functions
export function modifyGmailEmail(
  emailId: string,
  options: {
    addLabelIds?: string[];
    removeLabelIds?: string[];
  },
): Effect.Effect<GmailEmail, GmailOperationError | GmailAuthenticationError, GmailService> {
  return Effect.gen(function* () {
    const gmailService = yield* GmailServiceTag;
    return yield* gmailService.modifyEmail(emailId, options);
  });
}

export function batchModifyGmailEmails(
  emailIds: string[],
  options: {
    addLabelIds?: string[];
    removeLabelIds?: string[];
  },
): Effect.Effect<void, GmailOperationError | GmailAuthenticationError, GmailService> {
  return Effect.gen(function* () {
    const gmailService = yield* GmailServiceTag;
    return yield* gmailService.batchModifyEmails(emailIds, options);
  });
}

export function trashGmailEmail(
  emailId: string,
): Effect.Effect<void, GmailOperationError | GmailAuthenticationError, GmailService> {
  return Effect.gen(function* () {
    const gmailService = yield* GmailServiceTag;
    return yield* gmailService.trashEmail(emailId);
  });
}

export function deleteGmailEmail(
  emailId: string,
): Effect.Effect<void, GmailOperationError | GmailAuthenticationError, GmailService> {
  return Effect.gen(function* () {
    const gmailService = yield* GmailServiceTag;
    return yield* gmailService.deleteEmail(emailId);
  });
}
