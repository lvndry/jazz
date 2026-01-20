import { FileSystem } from "@effect/platform";
import { auth, type calendar_v3 } from "@googleapis/calendar";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Effect, Either } from "effect";
import { CalendarServiceResource } from "./calendar";
import { CalendarService } from "../core/interfaces/calendar";
import type { TerminalService } from "../core/interfaces/terminal";
import { CalendarAuthenticationError, CalendarOperationError } from "../core/types";

// Helper constant for test tokens with required scopes
const TEST_TOKEN_WITH_SCOPES = JSON.stringify({
  access_token: "test",
  scope:
    "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.labels https://www.googleapis.com/auth/gmail.compose",
});

describe("CalendarService", () => {
  let mockFileSystem: FileSystem.FileSystem;
  let mockCalendar: calendar_v3.Calendar;
  let mockOAuthClient: InstanceType<typeof auth.OAuth2>;
  let mockRequireCredentials: () => Effect.Effect<void, CalendarAuthenticationError>;
  let mockTerminal: TerminalService;
  let calendarService: CalendarService;

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

    // Mock Calendar API client
    mockCalendar = {
      events: {
        list: mock(() => Promise.resolve({ data: { items: [] } })),
        get: mock(() => Promise.resolve({ data: {} })),
        insert: mock(() => Promise.resolve({ data: {} })),
        patch: mock(() => Promise.resolve({ data: {} })),
        delete: mock(() => Promise.resolve({})),
        quickAdd: mock(() => Promise.resolve({ data: {} })),
      },
      calendarList: {
        list: mock(() => Promise.resolve({ data: { items: [] } })),
        get: mock(() => Promise.resolve({ data: {} })),
      },
    } as unknown as calendar_v3.Calendar;

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
      updateLog: mock(() => Effect.void),
      ask: mock(() => Effect.succeed("")),
      password: mock(() => Effect.succeed("")),
      select: mock(() => Effect.succeed("")),
      confirm: mock(() => Effect.succeed(true)),
      search: mock(() => Effect.succeed("")),
      checkbox: mock(() => Effect.succeed([""])),
    } as unknown as TerminalService;

    // Create service instance
    calendarService = new CalendarServiceResource(
      mockFileSystem,
      "/tmp/test-token.json",
      mockOAuthClient,
      mockCalendar,
      mockRequireCredentials,
      mockTerminal,
    );
  });

  describe("authenticate", () => {
    it("should succeed when token already exists", async () => {
      const mockToken = JSON.stringify({
        access_token: "test-token",
        refresh_token: "test-refresh",
        expiry_date: Date.now() + 3600000,
        scope:
          "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events",
      });

      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(mockToken),
      );

      const result = await Effect.runPromise(calendarService.authenticate());

      expect(result).toBeUndefined();
      expect(mockFileSystem.readFileString).toHaveBeenCalledWith("/tmp/test-token.json");
      expect(mockOAuthClient.setCredentials).toHaveBeenCalled();
    });

    // Note: Testing OAuth flow (when token doesn't exist or is invalid) requires starting an HTTP server
    // which is not appropriate for unit tests. OAuth flow should be tested in integration tests.
    // We only test the happy path where a valid token already exists.
  });

  describe("listEvents", () => {
    it("should return empty array when no events", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      (mockCalendar.events.list as ReturnType<typeof mock>).mockResolvedValue({
        data: { items: [] },
      });

      const result = await Effect.runPromise(calendarService.listEvents("primary"));

      expect(result).toEqual([]);
      expect(mockCalendar.events.list).toHaveBeenCalledWith({
        calendarId: "primary",
        maxResults: 10,
        singleEvents: true,
        orderBy: "startTime",
        showDeleted: false,
      });
    });

    it("should return events with metadata", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      const mockEvent = {
        id: "event-1",
        summary: "Test Event",
        description: "Test Description",
        start: {
          dateTime: "2024-01-01T10:00:00Z",
          timeZone: "UTC",
        },
        end: {
          dateTime: "2024-01-01T11:00:00Z",
          timeZone: "UTC",
        },
        location: "Test Location",
        status: "confirmed",
        created: "2024-01-01T09:00:00Z",
        updated: "2024-01-01T09:00:00Z",
      };

      (mockCalendar.events.list as ReturnType<typeof mock>).mockResolvedValue({
        data: { items: [mockEvent as calendar_v3.Schema$Event] },
      });

      const result = await Effect.runPromise(calendarService.listEvents("primary"));

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: "event-1",
        summary: "Test Event",
        description: "Test Description",
      });
    });

    it("should support query parameter", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      (mockCalendar.events.list as ReturnType<typeof mock>).mockResolvedValue({
        data: { items: [] },
      });

      await Effect.runPromise(
        calendarService.listEvents("primary", { query: "meeting", maxResults: 5 }),
      );

      expect(mockCalendar.events.list).toHaveBeenCalledWith({
        calendarId: "primary",
        maxResults: 5,
        singleEvents: true,
        orderBy: "startTime",
        showDeleted: false,
        q: "meeting",
      });
    });

    it("should handle API errors", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      const createError = () => {
        const err = new Error("API Error");
        (err as any).status = 500;
        (err as any).response = { status: 500 };
        return err;
      };

      (mockCalendar.events.list as ReturnType<typeof mock>).mockRejectedValue(createError());

      const result = await Effect.runPromise(
        calendarService.listEvents("primary").pipe(Effect.either),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        const err = result.left;
        expect(err).toBeInstanceOf(CalendarOperationError);
        expect(err.message).toContain("Failed to list events");
        expect(err.message).toContain("API Error");
      } else {
        throw new Error(`Expected error but got success: ${JSON.stringify(result.right)}`);
      }
    });

    it("should require credentials before authentication", async () => {
      const failingRequireCredentials = mock(() =>
        Effect.fail(new CalendarAuthenticationError({ message: "Missing credentials" })),
      );

      const serviceWithFailingCreds = new CalendarServiceResource(
        mockFileSystem,
        "/tmp/test-token.json",
        mockOAuthClient,
        mockCalendar,
        failingRequireCredentials,
        mockTerminal,
      );

      const result = await Effect.runPromise(
        serviceWithFailingCreds.listEvents("primary").pipe(Effect.either),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        const error = result.left;
        expect(error).toBeInstanceOf(CalendarAuthenticationError);
        expect(error.message).toContain("Missing credentials");
      }
    });
  });

  describe("getEvent", () => {
    it("should return event with full details", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      const mockEvent = {
        id: "event-1",
        summary: "Test Event",
        description: "Test Description",
        start: {
          dateTime: "2024-01-01T10:00:00Z",
          timeZone: "UTC",
        },
        end: {
          dateTime: "2024-01-01T11:00:00Z",
          timeZone: "UTC",
        },
        location: "Test Location",
        status: "confirmed",
        created: "2024-01-01T09:00:00Z",
        updated: "2024-01-01T09:00:00Z",
      };

      (mockCalendar.events.get as ReturnType<typeof mock>).mockResolvedValue({
        data: mockEvent as calendar_v3.Schema$Event,
      });

      const result = await Effect.runPromise(calendarService.getEvent("primary", "event-1"));

      expect(result.id).toBe("event-1");
      expect(result.summary).toBe("Test Event");
      expect(mockCalendar.events.get).toHaveBeenCalledWith({
        calendarId: "primary",
        eventId: "event-1",
      });
    });

    it("should handle missing event", async () => {
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

      (mockCalendar.events.get as ReturnType<typeof mock>).mockRejectedValue(error);

      const result = await Effect.runPromise(
        calendarService.getEvent("primary", "nonexistent").pipe(Effect.either),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        const err = result.left;
        expect(err).toBeInstanceOf(CalendarOperationError);
        expect(err.message).toContain("Failed to get event");
        expect(err.message).toContain("Not found");
      }
    });
  });

  describe("createEvent", () => {
    it("should create event", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      const mockEvent = {
        id: "event-new",
        summary: "New Event",
        start: {
          dateTime: "2024-01-01T10:00:00Z",
          timeZone: "UTC",
        },
        end: {
          dateTime: "2024-01-01T11:00:00Z",
          timeZone: "UTC",
        },
        status: "confirmed",
        created: "2024-01-01T09:00:00Z",
        updated: "2024-01-01T09:00:00Z",
      };

      (mockCalendar.events.insert as ReturnType<typeof mock>).mockResolvedValue({
        data: mockEvent as calendar_v3.Schema$Event,
      });

      const result = await Effect.runPromise(
        calendarService.createEvent("primary", {
          summary: "New Event",
          start: {
            dateTime: "2024-01-01T10:00:00Z",
            timeZone: "UTC",
          },
          end: {
            dateTime: "2024-01-01T11:00:00Z",
            timeZone: "UTC",
          },
        }),
      );

      expect(result.id).toBe("event-new");
      expect(result.summary).toBe("New Event");
      expect(mockCalendar.events.insert).toHaveBeenCalled();
    });

    it("should handle create errors", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      const createError = () => {
        const err = new Error("Create failed");
        (err as any).status = 400;
        (err as any).response = { status: 400 };
        return err;
      };
      const error = createError();

      (mockCalendar.events.insert as ReturnType<typeof mock>).mockRejectedValue(error);

      const result = await Effect.runPromise(
        calendarService
          .createEvent("primary", {
            summary: "New Event",
            start: {
              dateTime: "2024-01-01T10:00:00Z",
              timeZone: "UTC",
            },
            end: {
              dateTime: "2024-01-01T11:00:00Z",
              timeZone: "UTC",
            },
          })
          .pipe(Effect.either),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        const err = result.left;
        expect(err).toBeInstanceOf(CalendarOperationError);
        expect(err.message).toContain("Failed to create event");
        expect(err.message).toContain("Create failed");
      }
    });
  });

  describe("updateEvent", () => {
    it("should update event", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      const mockEvent = {
        id: "event-1",
        summary: "Updated Event",
        start: {
          dateTime: "2024-01-01T10:00:00Z",
          timeZone: "UTC",
        },
        end: {
          dateTime: "2024-01-01T11:00:00Z",
          timeZone: "UTC",
        },
        status: "confirmed",
        updated: "2024-01-01T09:30:00Z",
      };

      (mockCalendar.events.patch as ReturnType<typeof mock>).mockResolvedValue({
        data: mockEvent as calendar_v3.Schema$Event,
      });

      const result = await Effect.runPromise(
        calendarService.updateEvent("primary", "event-1", { summary: "Updated Event" }),
      );

      expect(result.summary).toBe("Updated Event");
      expect(mockCalendar.events.patch).toHaveBeenCalledWith({
        calendarId: "primary",
        eventId: "event-1",
        requestBody: expect.objectContaining({ summary: "Updated Event" }),
      });
    });
  });

  describe("deleteEvent", () => {
    it("should delete event", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      (mockCalendar.events.delete as ReturnType<typeof mock>).mockResolvedValue({});

      const result = await Effect.runPromise(calendarService.deleteEvent("primary", "event-1"));

      expect(result).toBeUndefined();
      expect(mockCalendar.events.delete).toHaveBeenCalledWith({
        calendarId: "primary",
        eventId: "event-1",
      });
    });
  });

  describe("listCalendars", () => {
    it("should return calendars", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      const mockCalendars = [
        {
          id: "primary",
          summary: "Primary Calendar",
          description: "My primary calendar",
          timeZone: "America/New_York",
        },
        {
          id: "calendar-2",
          summary: "Work Calendar",
          description: "Work events",
          timeZone: "America/New_York",
        },
      ];

      (mockCalendar.calendarList.list as ReturnType<typeof mock>).mockResolvedValue({
        data: { items: mockCalendars as calendar_v3.Schema$CalendarListEntry[] },
      });

      const result = await Effect.runPromise(calendarService.listCalendars());

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        id: "primary",
        summary: "Primary Calendar",
      });
    });

    it("should handle empty calendars", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      (mockCalendar.calendarList.list as ReturnType<typeof mock>).mockResolvedValue({
        data: { items: [] },
      });

      const result = await Effect.runPromise(calendarService.listCalendars());

      expect(result).toEqual([]);
    });
  });

  describe("getCalendar", () => {
    it("should return calendar metadata", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      const mockCalendarInfo = {
        id: "primary",
        summary: "Primary Calendar",
        description: "My primary calendar",
        timeZone: "America/New_York",
      };

      (mockCalendar.calendarList.get as ReturnType<typeof mock>).mockResolvedValue({
        data: mockCalendarInfo as calendar_v3.Schema$CalendarListEntry,
      });

      const result = await Effect.runPromise(calendarService.getCalendar("primary"));

      expect(result.id).toBe("primary");
      expect(result.summary).toBe("Primary Calendar");
      expect(mockCalendar.calendarList.get).toHaveBeenCalledWith({
        calendarId: "primary",
      });
    });
  });

  describe("searchEvents", () => {
    it("should delegate to listEvents with query", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      (mockCalendar.events.list as ReturnType<typeof mock>).mockResolvedValue({
        data: { items: [] },
      });

      await Effect.runPromise(calendarService.searchEvents("meeting", { maxResults: 5 }));

      expect(mockCalendar.events.list).toHaveBeenCalledWith({
        calendarId: "primary",
        maxResults: 5,
        singleEvents: true,
        orderBy: "startTime",
        showDeleted: false,
        q: "meeting",
      });
    });
  });

  describe("quickAddEvent", () => {
    it("should create event from text", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      const mockEvent = {
        id: "event-quick",
        summary: "Quick Event",
        start: {
          dateTime: "2024-01-01T10:00:00Z",
          timeZone: "UTC",
        },
        end: {
          dateTime: "2024-01-01T11:00:00Z",
          timeZone: "UTC",
        },
        status: "confirmed",
        created: "2024-01-01T09:00:00Z",
        updated: "2024-01-01T09:00:00Z",
      };

      (mockCalendar.events.quickAdd as ReturnType<typeof mock>).mockResolvedValue({
        data: mockEvent as calendar_v3.Schema$Event,
      });

      const result = await Effect.runPromise(
        calendarService.quickAddEvent("primary", "Meeting tomorrow at 3pm"),
      );

      expect(result.id).toBe("event-quick");
      expect(mockCalendar.events.quickAdd).toHaveBeenCalledWith({
        calendarId: "primary",
        text: "Meeting tomorrow at 3pm",
      });
    });
  });

  describe("error handling", () => {
    it("should handle errors with status code", async () => {
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

      (mockCalendar.events.list as ReturnType<typeof mock>).mockRejectedValue(error);

      const result = await Effect.runPromise(
        calendarService.listEvents("primary").pipe(Effect.either),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        const err = result.left;
        expect(err).toBeInstanceOf(CalendarOperationError);
        expect(err.message).toContain("Failed to list events");
      }
    });

    it("should handle errors without status code", async () => {
      (mockFileSystem.readFileString as ReturnType<typeof mock>).mockReturnValue(
        Effect.succeed(TEST_TOKEN_WITH_SCOPES),
      );

      const error = new Error("Network error");

      (mockCalendar.events.list as ReturnType<typeof mock>).mockRejectedValue(error);

      const result = await Effect.runPromise(
        calendarService.listEvents("primary").pipe(Effect.either),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        const error = result.left;
        expect(error).toBeInstanceOf(CalendarOperationError);
        expect(error.message).toContain("Network error");
      }
    });
  });
});
