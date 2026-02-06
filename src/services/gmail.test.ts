import { FileSystem } from "@effect/platform";
import { auth, type gmail_v1 } from "@googleapis/gmail";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Effect, Either } from "effect";
import { GmailServiceResource } from "./gmail";
import type { GmailService } from "../core/interfaces/gmail";
import type { TerminalService } from "../core/interfaces/terminal";
import { GmailAuthenticationError, GmailOperationError } from "../core/types";

// Helper constant for test tokens with required scopes
const TEST_TOKEN_WITH_SCOPES = JSON.stringify({
  access_token: "test",
  scope:
    "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.labels https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events",
});

describe("GmailService", () => {
  let mockFileSystem: FileSystem.FileSystem;
  let mockGmail: gmail_v1.Gmail;
  let mockOAuthClient: InstanceType<typeof auth.OAuth2>;
  let mockRequireCredentials: () => Effect.Effect<void, GmailAuthenticationError>;
  let mockTerminal: TerminalService;
  let gmailService: GmailService;

  beforeEach(() => {
    // Mock FileSystem
    mockFileSystem = {
      readFileString: mock(() => Effect.succeed("")),
      writeFileString: mock(() => Effect.void),
      makeDirectory: mock(() => Effect.void),
    } as unknown as FileSystem.FileSystem;

    // Mock OAuth client with credentials storage
    const credentials: Record<string, unknown> = {};
    mockOAuthClient = {
      setCredentials: mock((creds: unknown) => {
        Object.assign(credentials, creds);
      }),
      getToken: mock(() => Promise.resolve({ tokens: {} })),
      generateAuthUrl: mock(() => "https://accounts.google.com/auth"),
      refreshAccessToken: mock(() => Promise.resolve({ credentials: {} })),
      _clientId: "test-client-id",
      _clientSecret: "test-client-secret",
      get credentials() {
        return credentials;
      },
    } as unknown as InstanceType<typeof auth.OAuth2>;

    // Mock Gmail API client
    mockGmail = {
      users: {
        messages: {
          list: mock(() => Promise.resolve({ data: { messages: [] } })),
          get: mock(() => Promise.resolve({ data: {} })),
          modify: mock(() => Promise.resolve({ data: {} })),
          batchModify: mock(() => Promise.resolve({})),
          trash: mock(() => Promise.resolve({})),
          delete: mock(() => Promise.resolve({})),
        },
        labels: {
          list: mock(() => Promise.resolve({ data: { labels: [] } })),
          create: mock(() => Promise.resolve({ data: {} })),
          update: mock(() => Promise.resolve({ data: {} })),
          delete: mock(() => Promise.resolve({})),
        },
        drafts: {
          create: mock(() => Promise.resolve({})),
        },
      },
    } as unknown as gmail_v1.Gmail;

    // Mock requireCredentials to always succeed
    mockRequireCredentials = mock(() => Effect.void);

    // Mock Terminal service
    mockTerminal = {
      info: mock(() => Effect.void),
      success: mock(() => Effect.void),
      error: mock(() => Effect.void),
      warn: mock(() => Effect.void),
      log: mock(() => Effect.void),
      debug: mock(() => Effect.void),
      heading: mock(() => Effect.void),
      list: mock(() => Effect.void),
      clear: mock(() => Effect.void),
      ask: mock(() => Effect.succeed("")),
      password: mock(() => Effect.succeed("")),
      select: mock(() => Effect.succeed("")),
      confirm: mock(() => Effect.succeed(true)),
      search: mock(() => Effect.succeed("")),
      checkbox: mock(() => Effect.succeed([""])),
    } as TerminalService;

    // Create service instance
    gmailService = new GmailServiceResource(
      mockFileSystem,
      "/tmp/test-token.json",
      mockOAuthClient,
      mockGmail,
      mockRequireCredentials,
      mockTerminal,
    );
  });

  describe("authenticate", () => {
    it("should succeed when token already exists", async () => {
      const mockToken = JSON.stringify({
        access_token: "test-token",
        refresh_token: "test-refresh",
        expiry_date: Date.now() + 3_600_000,
        scope:
          "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.labels https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events",
      });

      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(mockToken),
      );

      const result = await Effect.runPromise(gmailService.authenticate());

      expect(result).toBeUndefined();
      expect(mockFileSystem.readFileString).toHaveBeenCalledWith("/tmp/test-token.json");
      expect(mockOAuthClient.setCredentials).toHaveBeenCalled();
    });

    // Note: Testing OAuth flow (when token doesn't exist or is invalid) requires starting an HTTP server
    // which is not appropriate for unit tests. OAuth flow should be tested in integration tests.
    // We only test the happy path where a valid token already exists.
  });

  describe("listEmails", () => {
    it("should return empty array when no messages", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      (mockGmail.users.messages.list as ReturnType<typeof mock>).mockResolvedValue({
        data: { messages: [] },
      });

      const result = await Effect.runPromise(gmailService.listEmails(10));

      expect(result).toEqual([]);
      expect(mockGmail.users.messages.list).toHaveBeenCalledWith({
        userId: "me",
        maxResults: 10,
      });
    });

    it("should return emails with metadata", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      const mockMessage = {
        id: "msg-1",
        threadId: "thread-1",
        snippet: "Test snippet",
        payload: {
          headers: [
            { name: "Subject", value: "Test Subject" },
            { name: "From", value: "test@example.com" },
            { name: "To", value: "recipient@example.com" },
            { name: "Date", value: "Mon, 1 Jan 2024 00:00:00 +0000" },
          ],
        },
        labelIds: ["INBOX"],
      };

      (mockGmail.users.messages.list as ReturnType<typeof mock>).mockResolvedValue({
        data: { messages: [{ id: "msg-1" }] },
      });

      (mockGmail.users.messages.get as ReturnType<typeof mock>).mockResolvedValue({
        data: mockMessage as gmail_v1.Schema$Message,
      });

      const result = await Effect.runPromise(gmailService.listEmails(10));

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: "msg-1",
        threadId: "thread-1",
        subject: "Test Subject",
        from: "test@example.com",
        snippet: "Test snippet",
      });
    });

    it("should support query parameter", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      (mockGmail.users.messages.list as ReturnType<typeof mock>).mockResolvedValue({
        data: { messages: [] },
      });

      await Effect.runPromise(gmailService.listEmails(10, "from:test@example.com"));

      expect(mockGmail.users.messages.list).toHaveBeenCalledWith({
        userId: "me",
        maxResults: 10,
        q: "from:test@example.com",
      });
    });

    it("should handle API errors", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      // Mock a rejected promise - create error in a way that won't throw during test setup
      const createError = () => {
        const err = new Error("API Error");
        (err as any).status = 500;
        (err as any).response = { status: 500 };
        return err;
      };

      (mockGmail.users.messages.list as ReturnType<typeof mock>).mockRejectedValue(createError());

      const result = await Effect.runPromise(gmailService.listEmails(10).pipe(Effect.either));

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        const err = result.left;
        expect(err).toBeInstanceOf(GmailOperationError);
        expect(err.message).toContain("Failed to list emails");
        expect(err.message).toContain("API Error");
      } else {
        throw new Error(`Expected error but got success: ${JSON.stringify(result.right)}`);
      }
    });

    it("should require credentials before authentication", async () => {
      const failingRequireCredentials = mock(() =>
        Effect.fail(new GmailAuthenticationError({ message: "Missing credentials" })),
      );

      const serviceWithFailingCreds = new GmailServiceResource(
        mockFileSystem,
        "/tmp/test-token.json",
        mockOAuthClient,
        mockGmail,
        failingRequireCredentials,
        mockTerminal,
      );

      const result = await Effect.runPromise(
        serviceWithFailingCreds.listEmails(10).pipe(Effect.either),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        const error = result.left;
        expect(error).toBeInstanceOf(GmailAuthenticationError);
        expect(error.message).toContain("Missing credentials");
      }
    });
  });

  describe("getEmail", () => {
    it("should return email with full body", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      const mockMessage = {
        id: "msg-1",
        threadId: "thread-1",
        snippet: "Test snippet",
        payload: {
          headers: [
            { name: "Subject", value: "Test Subject" },
            { name: "From", value: "test@example.com" },
            { name: "To", value: "recipient@example.com" },
            { name: "Date", value: "Mon, 1 Jan 2024 00:00:00 +0000" },
          ],
          body: {
            data: Buffer.from("Email body text").toString("base64"),
          },
          mimeType: "text/plain",
        },
        labelIds: ["INBOX"],
      };

      (mockGmail.users.messages.get as ReturnType<typeof mock>).mockResolvedValue({
        data: mockMessage as gmail_v1.Schema$Message,
      });

      const result = await Effect.runPromise(gmailService.getEmail("msg-1"));

      expect(result.id).toBe("msg-1");
      expect(result.body).toBeDefined();
      expect(mockGmail.users.messages.get).toHaveBeenCalledWith({
        userId: "me",
        id: "msg-1",
        format: "full",
      });
    });

    it("should handle missing email", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      const createError = () => {
        const err = new Error("Not found");
        (err as any).status = 404;
        (err as any).response = { status: 404 };
        return err;
      };
      const error = createError();

      (mockGmail.users.messages.get as ReturnType<typeof mock>).mockRejectedValue(error);

      const result = await Effect.runPromise(
        gmailService.getEmail("nonexistent").pipe(Effect.either),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        const err = result.left;
        expect(err).toBeInstanceOf(GmailOperationError);
        expect(err.message).toContain("Failed to get email");
        expect(err.message).toContain("Not found");
      }
    });
  });

  describe("sendEmail", () => {
    it("should create draft email", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      (mockGmail.users.drafts.create as ReturnType<typeof mock>).mockResolvedValue({});

      const result = await Effect.runPromise(
        gmailService.sendEmail(["test@example.com"], "Subject", "Body"),
      );

      expect(result).toBeUndefined();
      expect(mockGmail.users.drafts.create).toHaveBeenCalled();
    });

    it("should include CC and BCC", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      (mockGmail.users.drafts.create as ReturnType<typeof mock>).mockResolvedValue({});

      await Effect.runPromise(
        gmailService.sendEmail(["to@example.com"], "Subject", "Body", {
          cc: ["cc@example.com"],
          bcc: ["bcc@example.com"],
        }),
      );

      expect(mockGmail.users.drafts.create).toHaveBeenCalled();
      const callArgs = (mockGmail.users.drafts.create as ReturnType<typeof mock>).mock.calls[0]![0];
      expect(callArgs.requestBody?.message?.raw).toBeDefined();
    });

    it("should handle send errors", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      const createError = () => {
        const err = new Error("Send failed");
        (err as any).status = 400;
        (err as any).response = { status: 400 };
        return err;
      };
      const error = createError();

      (mockGmail.users.drafts.create as ReturnType<typeof mock>).mockRejectedValue(error);

      const result = await Effect.runPromise(
        gmailService.sendEmail(["test@example.com"], "Subject", "Body").pipe(Effect.either),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        const err = result.left;
        expect(err).toBeInstanceOf(GmailOperationError);
        expect(err.message).toContain("Failed to create draft");
        expect(err.message).toContain("Send failed");
      }
    });
  });

  describe("searchEmails", () => {
    it("should delegate to listEmails with query", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      (mockGmail.users.messages.list as ReturnType<typeof mock>).mockResolvedValue({
        data: { messages: [] },
      });

      await Effect.runPromise(gmailService.searchEmails("test query", 5));

      expect(mockGmail.users.messages.list).toHaveBeenCalledWith({
        userId: "me",
        maxResults: 5,
        q: "test query",
      });
    });
  });

  describe("listLabels", () => {
    it("should return labels", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      const mockLabels = [
        {
          id: "label-1",
          name: "INBOX",
          type: "system",
          messagesTotal: 10,
          messagesUnread: 2,
        },
        {
          id: "label-2",
          name: "Custom Label",
          type: "user",
        },
      ];

      (mockGmail.users.labels.list as ReturnType<typeof mock>).mockResolvedValue({
        data: { labels: mockLabels as gmail_v1.Schema$Label[] },
      });

      const result = await Effect.runPromise(gmailService.listLabels());

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        id: "label-1",
        name: "INBOX",
        type: "system",
      });
    });

    it("should handle empty labels", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      (mockGmail.users.labels.list as ReturnType<typeof mock>).mockResolvedValue({
        data: { labels: [] },
      });

      const result = await Effect.runPromise(gmailService.listLabels());

      expect(result).toEqual([]);
    });
  });

  describe("createLabel", () => {
    it("should create label with all options", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      const mockLabel = {
        id: "label-new",
        name: "New Label",
        type: "user",
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
        color: {
          textColor: "#000000",
          backgroundColor: "#ffffff",
        },
      };

      (mockGmail.users.labels.create as ReturnType<typeof mock>).mockResolvedValue({
        data: mockLabel as gmail_v1.Schema$Label,
      });

      const result = await Effect.runPromise(
        gmailService.createLabel("New Label", {
          labelListVisibility: "labelShow",
          messageListVisibility: "show",
          color: { textColor: "#000000", backgroundColor: "#ffffff" },
        }),
      );

      expect(result).toMatchObject({
        id: "label-new",
        name: "New Label",
        type: "user",
      });
    });

    it("should create label with minimal options", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      const mockLabel = {
        id: "label-new",
        name: "New Label",
        type: "user",
      };

      (mockGmail.users.labels.create as ReturnType<typeof mock>).mockResolvedValue({
        data: mockLabel as gmail_v1.Schema$Label,
      });

      const result = await Effect.runPromise(gmailService.createLabel("New Label"));

      expect(result.name).toBe("New Label");
    });
  });

  describe("updateLabel", () => {
    it("should update label name", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      const mockLabel = {
        id: "label-1",
        name: "Updated Label",
        type: "user",
      };

      (mockGmail.users.labels.update as ReturnType<typeof mock>).mockResolvedValue({
        data: mockLabel as gmail_v1.Schema$Label,
      });

      const result = await Effect.runPromise(
        gmailService.updateLabel("label-1", { name: "Updated Label" }),
      );

      expect(result.name).toBe("Updated Label");
    });

    it("should update label color", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      const mockLabel = {
        id: "label-1",
        name: "Label",
        type: "user",
        color: {
          textColor: "#ffffff",
          backgroundColor: "#000000",
        },
      };

      (mockGmail.users.labels.update as ReturnType<typeof mock>).mockResolvedValue({
        data: mockLabel as gmail_v1.Schema$Label,
      });

      const result = await Effect.runPromise(
        gmailService.updateLabel("label-1", {
          color: { textColor: "#ffffff", backgroundColor: "#000000" },
        }),
      );

      expect(result.color).toEqual({
        textColor: "#ffffff",
        backgroundColor: "#000000",
      });
    });
  });

  describe("deleteLabel", () => {
    it("should delete label", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      (mockGmail.users.labels.delete as ReturnType<typeof mock>).mockResolvedValue({});

      const result = await Effect.runPromise(gmailService.deleteLabel("label-1"));

      expect(result).toBeUndefined();
      expect(mockGmail.users.labels.delete).toHaveBeenCalledWith({
        userId: "me",
        id: "label-1",
      });
    });
  });

  describe("modifyEmail", () => {
    it("should add labels to email", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      const mockMessage = {
        id: "msg-1",
        threadId: "thread-1",
        snippet: "Test",
        payload: {
          headers: [
            { name: "Subject", value: "Test" },
            { name: "From", value: "test@example.com" },
          ],
        },
        labelIds: ["INBOX", "IMPORTANT"],
      };

      (mockGmail.users.messages.modify as ReturnType<typeof mock>).mockResolvedValue({
        data: mockMessage as gmail_v1.Schema$Message,
      });

      const result = await Effect.runPromise(
        gmailService.modifyEmail("msg-1", { addLabelIds: ["IMPORTANT"] }),
      );

      expect(result.id).toBe("msg-1");
      expect(mockGmail.users.messages.modify).toHaveBeenCalledWith({
        userId: "me",
        id: "msg-1",
        requestBody: { addLabelIds: ["IMPORTANT"] },
      });
    });

    it("should remove labels from email", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      const mockMessage = {
        id: "msg-1",
        threadId: "thread-1",
        snippet: "Test",
        payload: {
          headers: [
            { name: "Subject", value: "Test" },
            { name: "From", value: "test@example.com" },
          ],
        },
        labelIds: ["INBOX"],
      };

      (mockGmail.users.messages.modify as ReturnType<typeof mock>).mockResolvedValue({
        data: mockMessage as gmail_v1.Schema$Message,
      });

      await Effect.runPromise(gmailService.modifyEmail("msg-1", { removeLabelIds: ["UNREAD"] }));

      expect(mockGmail.users.messages.modify).toHaveBeenCalledWith({
        userId: "me",
        id: "msg-1",
        requestBody: { removeLabelIds: ["UNREAD"] },
      });
    });
  });

  describe("batchModifyEmails", () => {
    it("should batch modify multiple emails", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      (mockGmail.users.messages.batchModify as ReturnType<typeof mock>).mockResolvedValue({});

      const result = await Effect.runPromise(
        gmailService.batchModifyEmails(["msg-1", "msg-2"], { addLabelIds: ["ARCHIVE"] }),
      );

      expect(result).toBeUndefined();
      expect(mockGmail.users.messages.batchModify).toHaveBeenCalledWith({
        userId: "me",
        requestBody: {
          ids: ["msg-1", "msg-2"],
          addLabelIds: ["ARCHIVE"],
        },
      });
    });
  });

  describe("trashEmail", () => {
    it("should trash email", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      (mockGmail.users.messages.trash as ReturnType<typeof mock>).mockResolvedValue({});

      const result = await Effect.runPromise(gmailService.trashEmail("msg-1"));

      expect(result).toBeUndefined();
      expect(mockGmail.users.messages.trash).toHaveBeenCalledWith({
        userId: "me",
        id: "msg-1",
      });
    });
  });

  describe("deleteEmail", () => {
    it("should permanently delete email", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      (mockGmail.users.messages.delete as ReturnType<typeof mock>).mockResolvedValue({});

      const result = await Effect.runPromise(gmailService.deleteEmail("msg-1"));

      expect(result).toBeUndefined();
      expect(mockGmail.users.messages.delete).toHaveBeenCalledWith({
        userId: "me",
        id: "msg-1",
      });
    });
  });

  describe("error handling", () => {
    it("should handle GaxiosError with status code", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      const createError = () => {
        const err = new Error("API Error");
        (err as any).status = 403;
        (err as any).response = { status: 403 };
        return err;
      };
      const error = createError();

      (mockGmail.users.messages.list as ReturnType<typeof mock>).mockRejectedValue(error);

      const result = await Effect.runPromise(gmailService.listEmails(10).pipe(Effect.either));

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        const err = result.left;
        expect(err).toBeInstanceOf(GmailOperationError);
        expect(err.message).toContain("Failed to list emails");
      }
    });

    it("should handle errors without status code", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      const error = new Error("Network error");

      (mockGmail.users.messages.list as ReturnType<typeof mock>).mockRejectedValue(error);

      const result = await Effect.runPromise(gmailService.listEmails(10).pipe(Effect.either));

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        const error = result.left;
        expect(error).toBeInstanceOf(GmailOperationError);
        expect(error.message).toContain("Network error");
      }
    });
  });

  describe("parseMessageToEmail", () => {
    it("should parse email with CC and BCC", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      const mockMessage = {
        id: "msg-1",
        threadId: "thread-1",
        snippet: "Test",
        payload: {
          headers: [
            { name: "Subject", value: "Test Subject" },
            { name: "From", value: "from@example.com" },
            { name: "To", value: "to1@example.com, to2@example.com" },
            { name: "Cc", value: "cc@example.com" },
            { name: "Bcc", value: "bcc@example.com" },
            { name: "Date", value: "Mon, 1 Jan 2024 00:00:00 +0000" },
          ],
        },
        labelIds: ["INBOX"],
      };

      (mockGmail.users.messages.get as ReturnType<typeof mock>).mockResolvedValue({
        data: mockMessage as gmail_v1.Schema$Message,
      });

      const result = await Effect.runPromise(gmailService.getEmail("msg-1"));

      expect(result.to).toEqual(["to1@example.com", "to2@example.com"]);
      expect(result.cc).toEqual(["cc@example.com"]);
      expect(result.bcc).toEqual(["bcc@example.com"]);
    });

    it("should handle missing headers gracefully", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      const mockMessage = {
        id: "msg-1",
        threadId: "thread-1",
        snippet: "Test",
        payload: {
          headers: [],
        },
        labelIds: [],
      };

      (mockGmail.users.messages.get as ReturnType<typeof mock>).mockResolvedValue({
        data: mockMessage as gmail_v1.Schema$Message,
      });

      const result = await Effect.runPromise(gmailService.getEmail("msg-1"));

      expect(result.subject).toBe("");
      expect(result.from).toBe("");
      expect(result.to).toEqual([]);
      expect(result.cc).toBeUndefined();
      expect(result.bcc).toBeUndefined();
    });
  });

  describe("parseLabelToGmailLabel", () => {
    it("should parse label with all fields", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      const mockLabel = {
        id: "label-1",
        name: "Test Label",
        type: "user",
        messagesTotal: 100,
        messagesUnread: 5,
        threadsTotal: 50,
        threadsUnread: 3,
        color: {
          textColor: "#000000",
          backgroundColor: "#ffffff",
        },
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      };

      (mockGmail.users.labels.list as ReturnType<typeof mock>).mockResolvedValue({
        data: { labels: [mockLabel as gmail_v1.Schema$Label] },
      });

      const result = await Effect.runPromise(gmailService.listLabels());

      expect(result[0]).toMatchObject({
        id: "label-1",
        name: "Test Label",
        type: "user",
        messagesTotal: 100,
        messagesUnread: 5,
        threadsTotal: 50,
        threadsUnread: 3,
        color: {
          textColor: "#000000",
          backgroundColor: "#ffffff",
        },
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      });
    });
  });
});
