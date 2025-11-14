import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer } from "effect";
import { GaxiosError } from "gaxios";
import { google, type gmail_v1 } from "googleapis";
import http from "node:http";
import open from "open";
import type { ConfigService } from "./config";
import { AgentConfigService } from "./config";
import type { LoggerService } from "./logger";

// Helper function to extract HTTP status code from gaxios errors
function getHttpStatusFromError(error: unknown): number | undefined {
  if (error instanceof GaxiosError) {
    return error.status ?? error.response?.status;
  }
  return undefined;
}

/**
 * Gmail service for interacting with Gmail API
 */

// Gmail service errors
export class GmailAuthenticationError extends Error {
  readonly _tag = "GmailAuthenticationError";
  constructor(message: string) {
    super(message);
    this.name = "GmailAuthenticationError";
  }
}

export class GmailOperationError extends Error {
  readonly _tag = "GmailOperationError";
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "GmailOperationError";
    this.status = status;
  }
}

// Gmail email interface
export interface GmailEmail {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string[];
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  date: string;
  snippet: string;
  body?: string | undefined;
  labels?: string[] | undefined;
  attachments?: Array<{
    filename: string;
    mimeType: string;
    size: number;
  }>;
}

// Gmail label interface
export interface GmailLabel {
  id: string;
  name: string;
  type: "system" | "user";
  messagesTotal?: number | undefined;
  messagesUnread?: number | undefined;
  threadsTotal?: number | undefined;
  threadsUnread?: number | undefined;
  color?:
    | {
        textColor: string;
        backgroundColor: string;
      }
    | undefined;
  labelListVisibility?: "labelShow" | "labelHide" | undefined;
  messageListVisibility?: "show" | "hide" | undefined;
}

// Gmail service interface
export interface GmailService {
  readonly authenticate: () => Effect.Effect<void, GmailAuthenticationError>;
  readonly listEmails: (
    maxResults?: number,
    query?: string,
  ) => Effect.Effect<
    GmailEmail[],
    GmailOperationError | GmailAuthenticationError
  >;
  readonly getEmail: (
    emailId: string,
  ) => Effect.Effect<
    GmailEmail,
    GmailOperationError | GmailAuthenticationError
  >;
  readonly sendEmail: (
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
  ) => Effect.Effect<void, GmailOperationError | GmailAuthenticationError>;
  readonly searchEmails: (
    query: string,
    maxResults?: number,
  ) => Effect.Effect<
    GmailEmail[],
    GmailOperationError | GmailAuthenticationError
  >;

  // Label management
  readonly listLabels: () => Effect.Effect<
    GmailLabel[],
    GmailOperationError | GmailAuthenticationError
  >;
  readonly createLabel: (
    name: string,
    options?: {
      labelListVisibility?: "labelShow" | "labelHide";
      messageListVisibility?: "show" | "hide";
      color?: { textColor: string; backgroundColor: string };
    },
  ) => Effect.Effect<
    GmailLabel,
    GmailOperationError | GmailAuthenticationError
  >;
  readonly updateLabel: (
    labelId: string,
    updates: {
      name?: string;
      labelListVisibility?: "labelShow" | "labelHide";
      messageListVisibility?: "show" | "hide";
      color?: { textColor: string; backgroundColor: string };
    },
  ) => Effect.Effect<
    GmailLabel,
    GmailOperationError | GmailAuthenticationError
  >;
  readonly deleteLabel: (
    labelId: string,
  ) => Effect.Effect<void, GmailOperationError | GmailAuthenticationError>;

  // Email modification
  readonly modifyEmail: (
    emailId: string,
    options: {
      addLabelIds?: string[];
      removeLabelIds?: string[];
    },
  ) => Effect.Effect<
    GmailEmail,
    GmailOperationError | GmailAuthenticationError
  >;
  readonly batchModifyEmails: (
    emailIds: string[],
    options: {
      addLabelIds?: string[];
      removeLabelIds?: string[];
    },
  ) => Effect.Effect<void, GmailOperationError | GmailAuthenticationError>;

  // Destructive email operations
  readonly trashEmail: (
    emailId: string,
  ) => Effect.Effect<void, GmailOperationError | GmailAuthenticationError>;
  readonly deleteEmail: (
    emailId: string,
  ) => Effect.Effect<void, GmailOperationError | GmailAuthenticationError>;
}

interface GoogleOAuthToken {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date?: number;
}

export class GmailServiceResource implements GmailService {
  constructor(
    private readonly fs: FileSystem.FileSystem,
    private readonly tokenFilePath: string,
    private oauthClient: InstanceType<typeof google.auth.OAuth2>,
    private gmail: gmail_v1.Gmail,
    private readonly requireCredentials: () => Effect.Effect<
      void,
      GmailAuthenticationError
    >,
  ) {}

  authenticate(): Effect.Effect<void, GmailAuthenticationError> {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        const exists = yield* this.readTokenIfExists();
        if (!exists) {
          yield* this.performOAuthFlow();
        }
        return void 0;
      }.bind(this),
    );
  }

  listEmails(
    maxResults: number = 10,
    query?: string,
  ): Effect.Effect<
    GmailEmail[],
    GmailOperationError | GmailAuthenticationError
  > {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        yield* this.ensureAuthenticated();
        try {
          const paramsList: gmail_v1.Params$Resource$Users$Messages$List =
            query !== undefined && query !== ""
              ? { userId: "me", maxResults, q: query }
              : { userId: "me", maxResults };
          const listResp = yield* Effect.promise(() =>
            this.gmail.users.messages.list(paramsList),
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
            const full = yield* Effect.promise(() =>
              this.gmail.users.messages.get(paramsGet),
            );
            const email = this.parseMessageToEmail(full.data);
            emails.push(email);
          }
          return emails;
        } catch (err) {
          const status = getHttpStatusFromError(err);
          throw new GmailOperationError(
            `Failed to list emails: ${err instanceof Error ? err.message : String(err)}`,
            status,
          );
        }
      }.bind(this),
    );
  }

  getEmail(
    emailId: string,
  ): Effect.Effect<GmailEmail, GmailOperationError | GmailAuthenticationError> {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        yield* this.ensureAuthenticated();
        try {
          const paramsGet: gmail_v1.Params$Resource$Users$Messages$Get = {
            userId: "me",
            id: emailId,
            format: "full",
          };
          const full = yield* Effect.promise(() =>
            this.gmail.users.messages.get(paramsGet),
          );
          const email = this.parseMessageToEmail(full.data, true);
          return email;
        } catch (err) {
          const status = getHttpStatusFromError(err);
          throw new GmailOperationError(
            `Failed to get email: ${err instanceof Error ? err.message : String(err)}`,
            status,
          );
        }
      }.bind(this),
    );
  }

  sendEmail(
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
  ): Effect.Effect<void, GmailOperationError | GmailAuthenticationError> {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        yield* this.ensureAuthenticated();
        try {
          const raw = this.buildRawEmail({
            to,
            subject,
            body,
            cc: options?.cc ?? [],
            bcc: options?.bcc ?? [],
          });
          // Attachments not implemented in this first pass
          yield* Effect.promise(() =>
            this.gmail.users.drafts.create({
              userId: "me",
              requestBody: { message: { raw } },
            }),
          );
          return void 0;
        } catch (err) {
          const status = getHttpStatusFromError(err);
          throw new GmailOperationError(
            `Failed to create draft: ${err instanceof Error ? err.message : String(err)}`,
            status,
          );
        }
      }.bind(this),
    );
  }

  searchEmails(
    query: string,
    maxResults: number = 10,
  ): Effect.Effect<
    GmailEmail[],
    GmailOperationError | GmailAuthenticationError
  > {
    return this.listEmails(maxResults, query);
  }

  // Label management methods
  listLabels(): Effect.Effect<
    GmailLabel[],
    GmailOperationError | GmailAuthenticationError
  > {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        yield* this.ensureAuthenticated();
        try {
          const response = yield* Effect.promise(() =>
            this.gmail.users.labels.list({ userId: "me" }),
          );
          const labels = (response.data.labels || []).map((label) =>
            this.parseLabelToGmailLabel(label),
          );
          return labels;
        } catch (err) {
          const status = getHttpStatusFromError(err);
          throw new GmailOperationError(
            `Failed to list labels: ${err instanceof Error ? err.message : String(err)}`,
            status,
          );
        }
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
        try {
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
          const response = yield* Effect.promise(() =>
            this.gmail.users.labels.create({ userId: "me", requestBody }),
          );
          return this.parseLabelToGmailLabel(response.data);
        } catch (err) {
          const status = getHttpStatusFromError(err);
          throw new GmailOperationError(
            `Failed to create label: ${err instanceof Error ? err.message : String(err)}`,
            status,
          );
        }
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
        try {
          const requestBody: gmail_v1.Schema$Label = {};
          if (updates.name !== undefined) requestBody.name = updates.name;
          if (updates.labelListVisibility !== undefined)
            requestBody.labelListVisibility = updates.labelListVisibility;
          if (updates.messageListVisibility !== undefined)
            requestBody.messageListVisibility = updates.messageListVisibility;
          if (updates.color !== undefined) requestBody.color = updates.color;

          const response = yield* Effect.promise(() =>
            this.gmail.users.labels.update({
              userId: "me",
              id: labelId,
              requestBody,
            }),
          );
          return this.parseLabelToGmailLabel(response.data);
        } catch (err) {
          const status = getHttpStatusFromError(err);
          throw new GmailOperationError(
            `Failed to update label: ${err instanceof Error ? err.message : String(err)}`,
            status,
          );
        }
      }.bind(this),
    );
  }

  deleteLabel(
    labelId: string,
  ): Effect.Effect<void, GmailOperationError | GmailAuthenticationError> {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        yield* this.ensureAuthenticated();
        try {
          yield* Effect.promise(() =>
            this.gmail.users.labels.delete({ userId: "me", id: labelId }),
          );
          return void 0;
        } catch (err) {
          const status = getHttpStatusFromError(err);
          throw new GmailOperationError(
            `Failed to delete label: ${err instanceof Error ? err.message : String(err)}`,
            status,
          );
        }
      }.bind(this),
    );
  }

  // Email modification methods
  modifyEmail(
    emailId: string,
    options: {
      addLabelIds?: string[];
      removeLabelIds?: string[];
    },
  ): Effect.Effect<GmailEmail, GmailOperationError | GmailAuthenticationError> {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        yield* this.ensureAuthenticated();
        try {
          const requestBody: gmail_v1.Schema$ModifyMessageRequest = {};
          if (options.addLabelIds)
            requestBody.addLabelIds = options.addLabelIds;
          if (options.removeLabelIds)
            requestBody.removeLabelIds = options.removeLabelIds;

          const response = yield* Effect.promise(() =>
            this.gmail.users.messages.modify({
              userId: "me",
              id: emailId,
              requestBody,
            }),
          );
          return this.parseMessageToEmail(response.data);
        } catch (err) {
          const status = getHttpStatusFromError(err);
          throw new GmailOperationError(
            `Failed to modify email: ${err instanceof Error ? err.message : String(err)}`,
            status,
          );
        }
      }.bind(this),
    );
  }

  batchModifyEmails(
    emailIds: string[],
    options: {
      addLabelIds?: string[];
      removeLabelIds?: string[];
    },
  ): Effect.Effect<void, GmailOperationError | GmailAuthenticationError> {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        yield* this.ensureAuthenticated();
        try {
          const requestBody: gmail_v1.Schema$BatchModifyMessagesRequest = {
            ids: emailIds,
          };
          if (options.addLabelIds)
            requestBody.addLabelIds = options.addLabelIds;
          if (options.removeLabelIds)
            requestBody.removeLabelIds = options.removeLabelIds;

          yield* Effect.promise(() =>
            this.gmail.users.messages.batchModify({
              userId: "me",
              requestBody,
            }),
          );
          return void 0;
        } catch (err) {
          const status = getHttpStatusFromError(err);
          throw new GmailOperationError(
            `Failed to batch modify emails: ${err instanceof Error ? err.message : String(err)}`,
            status,
          );
        }
      }.bind(this),
    );
  }

  trashEmail(
    emailId: string,
  ): Effect.Effect<void, GmailOperationError | GmailAuthenticationError> {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        yield* this.ensureAuthenticated();
        try {
          yield* Effect.promise(() =>
            this.gmail.users.messages.trash({ userId: "me", id: emailId }),
          );
          return void 0;
        } catch (err) {
          const status = getHttpStatusFromError(err);
          throw new GmailOperationError(
            `Failed to trash email: ${err instanceof Error ? err.message : String(err)}`,
            status,
          );
        }
      }.bind(this),
    );
  }

  deleteEmail(
    emailId: string,
  ): Effect.Effect<void, GmailOperationError | GmailAuthenticationError> {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        yield* this.ensureAuthenticated();
        try {
          yield* Effect.promise(() =>
            this.gmail.users.messages.delete({ userId: "me", id: emailId }),
          );
          return void 0;
        } catch (err) {
          const status = getHttpStatusFromError(err);
          throw new GmailOperationError(
            `Failed to delete email: ${err instanceof Error ? err.message : String(err)}`,
            status,
          );
        }
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
        }
        return void 0;
      }.bind(this),
    );
  }

  private readTokenIfExists(): Effect.Effect<
    boolean,
    GmailAuthenticationError
  > {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        const token = yield* this.fs.readFileString(this.tokenFilePath).pipe(
          Effect.mapError(() => undefined),
          Effect.catchAll(() => Effect.succeed(undefined as unknown as string)),
        );
        if (!token) return false;
        try {
          const parsed = JSON.parse(token) as GoogleOAuthToken;
          this.oauthClient.setCredentials(parsed);
          return true;
        } catch {
          return false;
        }
      }.bind(this),
    );
  }

  private performOAuthFlow(): Effect.Effect<void, GmailAuthenticationError> {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        const port = Number(process.env["GOOGLE_REDIRECT_PORT"] || 53682);
        const redirectUri = `http://localhost:${port}/oauth2callback`;
        // Recreate OAuth client with runtime redirectUri (property is readonly)
        const currentCreds = this.oauthClient.credentials as GoogleOAuthToken;
        const clientId = this.oauthClient._clientId;
        if (!clientId) {
          throw new GmailAuthenticationError("Missing client ID");
        }
        const clientSecret = this.oauthClient._clientSecret;
        if (!clientSecret) {
          throw new GmailAuthenticationError("Missing client secret");
        }
        const freshClient = new google.auth.OAuth2({
          clientId,
          clientSecret,
          redirectUri,
        });
        freshClient.setCredentials(currentCreds);
        this.oauthClient = freshClient;
        this.gmail = google.gmail({ version: "v1", auth: this.oauthClient });

        const scopes = [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.send",
          "https://www.googleapis.com/auth/gmail.modify",
          "https://www.googleapis.com/auth/gmail.labels",
          "https://www.googleapis.com/auth/gmail.compose",
        ];

        const authUrl = this.oauthClient.generateAuthUrl({
          access_type: "offline",
          scope: scopes,
          prompt: "consent",
        });

        // Start local server to capture the OAuth code
        const code = yield* Effect.async<string, GmailAuthenticationError>(
          (resume) => {
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
              // Also print URL to console for visibility in CLI
              console.log(
                `Open this URL in your browser to authenticate with Google: ${authUrl}`,
              );
            });
          },
        );

        try {
          const tokenResp = (yield* Effect.promise(() =>
            this.oauthClient.getToken(code),
          )) as {
            tokens: GoogleOAuthToken;
          };
          this.oauthClient.setCredentials(tokenResp.tokens);
          yield* this.persistToken(tokenResp.tokens);
        } catch (err) {
          throw new GmailAuthenticationError(
            `OAuth flow failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }.bind(this),
    );
  }

  private persistToken(
    token: GoogleOAuthToken,
  ): Effect.Effect<void, GmailAuthenticationError> {
    return Effect.gen(
      function* (this: GmailServiceResource) {
        const dir = this.tokenFilePath.substring(
          0,
          this.tokenFilePath.lastIndexOf("/"),
        );
        yield* this.fs
          .makeDirectory(dir, { recursive: true })
          .pipe(Effect.catchAll(() => Effect.void));
        const content = JSON.stringify(token, null, 2);
        yield* this.fs
          .writeFileString(this.tokenFilePath, content)
          .pipe(
            Effect.mapError(
              (err) =>
                new GmailAuthenticationError(
                  `Failed to persist token: ${String((err as Error).message ?? err)}`,
                ),
            ),
          );
      }.bind(this),
    );
  }

  private parseMessageToEmail(
    message: gmail_v1.Schema$Message,
    includeBody: boolean = false,
  ): GmailEmail {
    const headers = (message.payload?.headers ?? []).reduce<
      Record<string, string>
    >((acc, h) => {
      if (h.name && h.value) acc[h.name.toLowerCase()] = h.value;
      return acc;
    }, {});
    const subject = headers["subject"] || "";
    const from = headers["from"] || "";
    const to = (headers["to"] || "").split(/,\s*/).filter(Boolean);
    const cc = headers["cc"]
      ? headers["cc"].split(/,\s*/).filter(Boolean)
      : undefined;
    const bcc = headers["bcc"]
      ? headers["bcc"].split(/,\s*/).filter(Boolean)
      : undefined;
    const date = headers["date"] || new Date().toISOString();

    const attachments: GmailEmail["attachments"] | undefined = [];

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
      labels: message.labelIds || [],
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
      labelListVisibility: label.labelListVisibility as
        | "labelShow"
        | "labelHide"
        | undefined,
      messageListVisibility: label.messageListVisibility as
        | "show"
        | "hide"
        | undefined,
    };
  }

  private extractPlainTextBody(
    part?: gmail_v1.Schema$MessagePart,
  ): string | undefined {
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
      input.cc && input.cc.length > 0
        ? `Cc: ${input.cc.join(", ")}`
        : undefined,
      input.bcc && input.bcc.length > 0
        ? `Bcc: ${input.bcc.join(", ")}`
        : undefined,
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
}

// Service tag for dependency injection
export const GmailServiceTag = Context.GenericTag<GmailService>("GmailService");

// Layer for providing the real Gmail service
export function createGmailServiceLayer(): Layer.Layer<
  GmailService,
  never,
  FileSystem.FileSystem | ConfigService | LoggerService
> {
  return Layer.effect(
    GmailServiceTag,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const agentConfig = yield* AgentConfigService;
      const appConfig = yield* agentConfig.appConfig;
      const clientId = appConfig.google?.clientId;
      const clientSecret = appConfig.google?.clientSecret;
      const missingCreds = !clientId || !clientSecret;

      function requireCredentials(): Effect.Effect<
        void,
        GmailAuthenticationError
      > {
        if (missingCreds) {
          return Effect.fail(
            new GmailAuthenticationError(
              "Missing Google OAuth credentials. Set config.google.clientId and config.google.clientSecret.",
            ),
          );
        }
        return Effect.void as Effect.Effect<void, GmailAuthenticationError>;
      }

      const port = 53682;
      const redirectUri = `http://localhost:${port}/oauth2callback`;
      const oauth2Client = new google.auth.OAuth2(
        clientId,
        clientSecret,
        redirectUri,
      );
      const gmail = google.gmail({ version: "v1", auth: oauth2Client });

      const { storage } = yield* agentConfig.appConfig;
      const dataDir = storage.type === "file" ? storage.path : "./.jazz";
      const tokenFilePath = `${dataDir}/google/gmail-token.json`;
      const service: GmailService = new GmailServiceResource(
        fs,
        tokenFilePath,
        oauth2Client,
        gmail,
        requireCredentials,
      );

      return service;
    }),
  );
}

// Helper functions for common Gmail operations
export function authenticateGmail(): Effect.Effect<
  void,
  GmailAuthenticationError,
  GmailService
> {
  return Effect.gen(function* () {
    const gmailService = yield* GmailServiceTag;
    return yield* gmailService.authenticate();
  });
}

export function listGmailEmails(
  maxResults?: number,
  query?: string,
): Effect.Effect<
  GmailEmail[],
  GmailOperationError | GmailAuthenticationError,
  GmailService
> {
  return Effect.gen(function* () {
    const gmailService = yield* GmailServiceTag;
    return yield* gmailService.listEmails(maxResults, query);
  });
}

export function getGmailEmail(
  emailId: string,
): Effect.Effect<
  GmailEmail,
  GmailOperationError | GmailAuthenticationError,
  GmailService
> {
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
): Effect.Effect<
  void,
  GmailOperationError | GmailAuthenticationError,
  GmailService
> {
  return Effect.gen(function* () {
    const gmailService = yield* GmailServiceTag;
    return yield* gmailService.sendEmail(to, subject, body, options);
  });
}

export function searchGmailEmails(
  query: string,
  maxResults?: number,
): Effect.Effect<
  GmailEmail[],
  GmailOperationError | GmailAuthenticationError,
  GmailService
> {
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
): Effect.Effect<
  GmailLabel,
  GmailOperationError | GmailAuthenticationError,
  GmailService
> {
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
): Effect.Effect<
  GmailLabel,
  GmailOperationError | GmailAuthenticationError,
  GmailService
> {
  return Effect.gen(function* () {
    const gmailService = yield* GmailServiceTag;
    return yield* gmailService.updateLabel(labelId, updates);
  });
}

export function deleteGmailLabel(
  labelId: string,
): Effect.Effect<
  void,
  GmailOperationError | GmailAuthenticationError,
  GmailService
> {
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
): Effect.Effect<
  GmailEmail,
  GmailOperationError | GmailAuthenticationError,
  GmailService
> {
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
): Effect.Effect<
  void,
  GmailOperationError | GmailAuthenticationError,
  GmailService
> {
  return Effect.gen(function* () {
    const gmailService = yield* GmailServiceTag;
    return yield* gmailService.batchModifyEmails(emailIds, options);
  });
}

export function trashGmailEmail(
  emailId: string,
): Effect.Effect<
  void,
  GmailOperationError | GmailAuthenticationError,
  GmailService
> {
  return Effect.gen(function* () {
    const gmailService = yield* GmailServiceTag;
    return yield* gmailService.trashEmail(emailId);
  });
}

export function deleteGmailEmail(
  emailId: string,
): Effect.Effect<
  void,
  GmailOperationError | GmailAuthenticationError,
  GmailService
> {
  return Effect.gen(function* () {
    const gmailService = yield* GmailServiceTag;
    return yield* gmailService.deleteEmail(emailId);
  });
}
