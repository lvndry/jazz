import http from "node:http";
import { FileSystem } from "@effect/platform";
import { calendar, auth, type calendar_v3 } from "@googleapis/calendar";
import { Effect, Layer } from "effect";
import open from "open";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import { CalendarServiceTag, type CalendarService } from "@/core/interfaces/calendar";
import type { LoggerService } from "@/core/interfaces/logger";
import { TerminalServiceTag, type TerminalService } from "@/core/interfaces/terminal";
import type {
  CalendarEvent,
  CalendarEventAttendee,
  CalendarEventDateTime,
  CalendarEventReminder,
  CalendarInfo,
  CreateEventOptions,
  ListEventsOptions,
  UpdateEventOptions,
} from "@/core/types/calendar";
import { CalendarAuthenticationError, CalendarOperationError } from "@/core/types/errors";
import { getHttpStatusFromError } from "@/core/utils/http-utils";
import { resolveStorageDirectory } from "@/core/utils/storage-utils";
import {
  ALL_GOOGLE_SCOPES,
  CALENDAR_REQUIRED_SCOPES,
  getGoogleOAuthPort,
  getGoogleOAuthRedirectUri,
  getGoogleTokenFilePath,
  hasRequiredScopes,
  type GoogleOAuthToken,
} from "./google/auth";

/**
 * Calendar service for interacting with Google Calendar API
 * Implements the core CalendarService interface
 */

export class CalendarServiceResource implements CalendarService {
  constructor(
    private readonly fs: FileSystem.FileSystem,
    private readonly tokenFilePath: string,
    private oauthClient: InstanceType<typeof auth.OAuth2>,
    private calendarClient: calendar_v3.Calendar,
    private readonly requireCredentials: () => Effect.Effect<void, CalendarAuthenticationError>,
    private readonly terminal: TerminalService,
  ) {}

  authenticate(): Effect.Effect<void, CalendarAuthenticationError> {
    return Effect.gen(
      function* (this: CalendarServiceResource) {
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

  listEvents(
    calendarId: string,
    options?: ListEventsOptions,
  ): Effect.Effect<CalendarEvent[], CalendarOperationError | CalendarAuthenticationError> {
    return Effect.gen(
      function* (this: CalendarServiceResource) {
        yield* this.ensureAuthenticated();
        const params: calendar_v3.Params$Resource$Events$List = {
          calendarId,
          maxResults: options?.maxResults ?? 10,
          singleEvents: options?.singleEvents ?? true,
          orderBy: options?.orderBy ?? "startTime",
          showDeleted: options?.showDeleted ?? false,
          ...(options?.timeMin && { timeMin: options.timeMin }),
          ...(options?.timeMax && { timeMax: options.timeMax }),
          ...(options?.query && { q: options.query }),
          ...(options?.updatedMin && { updatedMin: options.updatedMin }),
        };
        const response = yield* this.wrapCalendarCall(
          () => this.calendarClient.events.list(params),
          "Failed to list events",
        );
        const events = (response.data.items || []).map((item) =>
          this.parseEventToCalendarEvent(item),
        );
        return events;
      }.bind(this),
    );
  }

  getEvent(
    calendarId: string,
    eventId: string,
  ): Effect.Effect<CalendarEvent, CalendarOperationError | CalendarAuthenticationError> {
    return Effect.gen(
      function* (this: CalendarServiceResource) {
        yield* this.ensureAuthenticated();
        const response = yield* this.wrapCalendarCall(
          () => this.calendarClient.events.get({ calendarId, eventId }),
          "Failed to get event",
        );
        return this.parseEventToCalendarEvent(response.data);
      }.bind(this),
    );
  }

  createEvent(
    calendarId: string,
    event: Omit<CalendarEvent, "id" | "created" | "updated" | "htmlLink">,
    options?: CreateEventOptions,
  ): Effect.Effect<CalendarEvent, CalendarOperationError | CalendarAuthenticationError> {
    return Effect.gen(
      function* (this: CalendarServiceResource) {
        yield* this.ensureAuthenticated();
        const requestBody = this.buildEventRequestBody(event);
        const response = yield* this.wrapCalendarCall(
          () =>
            this.calendarClient.events.insert({
              calendarId,
              requestBody,
              ...(options?.sendNotifications !== undefined && {
                sendNotifications: options.sendNotifications,
              }),
              ...(options?.conferenceDataVersion !== undefined && {
                conferenceDataVersion: options.conferenceDataVersion,
              }),
              ...(options?.supportsAttachments !== undefined && {
                supportsAttachments: options.supportsAttachments,
              }),
            }),
          "Failed to create event",
        );
        return this.parseEventToCalendarEvent(response.data);
      }.bind(this),
    );
  }

  updateEvent(
    calendarId: string,
    eventId: string,
    event: Partial<Omit<CalendarEvent, "id" | "created" | "updated" | "htmlLink">>,
    options?: UpdateEventOptions,
  ): Effect.Effect<CalendarEvent, CalendarOperationError | CalendarAuthenticationError> {
    return Effect.gen(
      function* (this: CalendarServiceResource) {
        yield* this.ensureAuthenticated();
        const requestBody = this.buildEventRequestBody(event);
        const response = yield* this.wrapCalendarCall(
          () =>
            this.calendarClient.events.patch({
              calendarId,
              eventId,
              requestBody,
              ...(options?.sendNotifications !== undefined && {
                sendNotifications: options.sendNotifications,
              }),
              ...(options?.conferenceDataVersion !== undefined && {
                conferenceDataVersion: options.conferenceDataVersion,
              }),
              ...(options?.supportsAttachments !== undefined && {
                supportsAttachments: options.supportsAttachments,
              }),
            }),
          "Failed to update event",
        );
        return this.parseEventToCalendarEvent(response.data);
      }.bind(this),
    );
  }

  deleteEvent(
    calendarId: string,
    eventId: string,
    sendNotifications?: boolean,
  ): Effect.Effect<void, CalendarOperationError | CalendarAuthenticationError> {
    return Effect.gen(
      function* (this: CalendarServiceResource) {
        yield* this.ensureAuthenticated();
        yield* this.wrapCalendarCall(
          () =>
            this.calendarClient.events.delete({
              calendarId,
              eventId,
              ...(sendNotifications !== undefined && { sendNotifications }),
            }),
          "Failed to delete event",
        );
        return void 0;
      }.bind(this),
    );
  }

  listCalendars(): Effect.Effect<
    CalendarInfo[],
    CalendarOperationError | CalendarAuthenticationError
  > {
    return Effect.gen(
      function* (this: CalendarServiceResource) {
        yield* this.ensureAuthenticated();
        const response = yield* this.wrapCalendarCall(
          () => this.calendarClient.calendarList.list(),
          "Failed to list calendars",
        );
        const calendars = (response.data.items || []).map((item) =>
          this.parseCalendarToCalendarInfo(item),
        );
        return calendars;
      }.bind(this),
    );
  }

  getCalendar(
    calendarId: string,
  ): Effect.Effect<CalendarInfo, CalendarOperationError | CalendarAuthenticationError> {
    return Effect.gen(
      function* (this: CalendarServiceResource) {
        yield* this.ensureAuthenticated();
        const response = yield* this.wrapCalendarCall(
          () => this.calendarClient.calendarList.get({ calendarId }),
          "Failed to get calendar",
        );
        return this.parseCalendarToCalendarInfo(response.data);
      }.bind(this),
    );
  }

  searchEvents(
    query: string,
    options?: ListEventsOptions,
  ): Effect.Effect<CalendarEvent[], CalendarOperationError | CalendarAuthenticationError> {
    return Effect.gen(
      function* (this: CalendarServiceResource) {
        yield* this.ensureAuthenticated();
        // Search across primary calendar by default
        return yield* this.listEvents("primary", { ...options, query });
      }.bind(this),
    );
  }

  quickAddEvent(
    calendarId: string,
    text: string,
    sendNotifications?: boolean,
  ): Effect.Effect<CalendarEvent, CalendarOperationError | CalendarAuthenticationError> {
    return Effect.gen(
      function* (this: CalendarServiceResource) {
        yield* this.ensureAuthenticated();
        const response = yield* this.wrapCalendarCall(
          () =>
            this.calendarClient.events.quickAdd({
              calendarId,
              text,
              ...(sendNotifications !== undefined && { sendNotifications }),
            }),
          "Failed to quick add event",
        );
        return this.parseEventToCalendarEvent(response.data);
      }.bind(this),
    );
  }

  private ensureAuthenticated(): Effect.Effect<void, CalendarAuthenticationError> {
    return Effect.gen(
      function* (this: CalendarServiceResource) {
        // Fail fast if credentials are missing when a Calendar operation is invoked
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

  private readTokenIfExists(): Effect.Effect<boolean, CalendarAuthenticationError> {
    return Effect.gen(
      function* (this: CalendarServiceResource) {
        const token = yield* this.fs.readFileString(this.tokenFilePath).pipe(
          Effect.mapError(() => undefined),
          Effect.catchAll(() => Effect.succeed(undefined as unknown as string)),
        );
        if (!token) return false;
        try {
          const parsed = JSON.parse(token) as GoogleOAuthToken;
          // Check if token has required Calendar scopes
          if (!hasRequiredScopes(parsed, CALENDAR_REQUIRED_SCOPES)) {
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

  private validateAndRefreshToken(): Effect.Effect<void, CalendarAuthenticationError> {
    return Effect.gen(
      function* (this: CalendarServiceResource) {
        const credentials = this.oauthClient.credentials as GoogleOAuthToken;

        // Check if access token exists
        if (!credentials.access_token) {
          throw new CalendarAuthenticationError({
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
            throw new CalendarAuthenticationError({
              message:
                "Access token expired and no refresh token available. Please run 'bun run cli auth google login' to re-authenticate.",
            });
          }

          try {
            // Attempt to refresh the token
            const refreshed = yield* Effect.tryPromise({
              try: () => this.oauthClient.refreshAccessToken(),
              catch: (err) =>
                new CalendarAuthenticationError({
                  message: `Failed to refresh access token: ${err instanceof Error ? err.message : String(err)}. Please run 'bun run cli auth google login' to re-authenticate.`,
                }),
            });

            // Update credentials with refreshed token
            this.oauthClient.setCredentials(refreshed.credentials);
            // Persist the refreshed token
            yield* this.persistToken(refreshed.credentials as GoogleOAuthToken);
          } catch {
            // If refresh fails, throw error prompting user to re-authenticate
            throw new CalendarAuthenticationError({
              message:
                "Failed to refresh access token. Please run 'bun run cli auth google login' to re-authenticate.",
            });
          }
        }
      }.bind(this),
    );
  }

  private performOAuthFlow(): Effect.Effect<void, CalendarAuthenticationError> {
    return Effect.gen(
      function* (this: CalendarServiceResource) {
        const port = getGoogleOAuthPort();
        const redirectUri = getGoogleOAuthRedirectUri(port);
        // Recreate OAuth client with runtime redirectUri (property is readonly)
        const currentCreds = this.oauthClient.credentials as GoogleOAuthToken;
        const clientId = this.oauthClient._clientId;
        if (!clientId) {
          throw new CalendarAuthenticationError({ message: "Missing client ID" });
        }
        const clientSecret = this.oauthClient._clientSecret;
        if (!clientSecret) {
          throw new CalendarAuthenticationError({ message: "Missing client secret" });
        }
        const freshClient = new auth.OAuth2({
          clientId,
          clientSecret,
          redirectUri,
        });
        freshClient.setCredentials(currentCreds);
        this.oauthClient = freshClient;
        this.calendarClient = calendar({ version: "v3", auth: this.oauthClient });

        // Include both Calendar and Gmail scopes since they share the same token file
        const scopes = [...ALL_GOOGLE_SCOPES];

        const authUrl = this.oauthClient.generateAuthUrl({
          access_type: "offline",
          scope: scopes,
          prompt: "consent",
        });

        // Start local server to capture the OAuth code
        const code = yield* Effect.async<string, CalendarAuthenticationError>((resume) => {
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
                `Open this URL in your browser to authenticate with Google Calendar: ${authUrl}`,
              ),
            );
          });
        });

        const tokenResp = yield* Effect.tryPromise({
          try: () => this.oauthClient.getToken(code),
          catch: (err) =>
            new CalendarAuthenticationError({
              message: `OAuth flow failed: ${err instanceof Error ? err.message : String(err)}`,
            }),
        }).pipe(Effect.map((resp) => resp as { tokens: GoogleOAuthToken }));
        this.oauthClient.setCredentials(tokenResp.tokens);
        yield* this.persistToken(tokenResp.tokens);
      }.bind(this),
    );
  }

  private persistToken(token: GoogleOAuthToken): Effect.Effect<void, CalendarAuthenticationError> {
    return Effect.gen(
      function* (this: CalendarServiceResource) {
        const dir = this.tokenFilePath.substring(0, this.tokenFilePath.lastIndexOf("/"));
        yield* this.fs
          .makeDirectory(dir, { recursive: true })
          .pipe(Effect.catchAll(() => Effect.void));
        const content = JSON.stringify(token, null, 2);
        yield* this.fs.writeFileString(this.tokenFilePath, content).pipe(
          Effect.mapError(
            (err) =>
              new CalendarAuthenticationError({
                message: `Failed to persist token: ${String((err as Error).message ?? err)}`,
              }),
          ),
        );
      }.bind(this),
    );
  }

  private parseEventToCalendarEvent(event: calendar_v3.Schema$Event): CalendarEvent {
    const validResponseStatuses = ["needsAction", "declined", "tentative", "accepted"] as const;
    const attendees: CalendarEventAttendee[] =
      event.attendees?.map((attendee) => {
        const responseStatus: CalendarEventAttendee["responseStatus"] =
          attendee.responseStatus !== undefined &&
          attendee.responseStatus !== null &&
          validResponseStatuses.includes(
            attendee.responseStatus as (typeof validResponseStatuses)[number],
          )
            ? (attendee.responseStatus as CalendarEventAttendee["responseStatus"])
            : undefined;
        return {
          email: attendee.email || "",
          ...(attendee.displayName && { displayName: attendee.displayName }),
          ...(attendee.organizer !== undefined &&
            attendee.organizer !== null && { organizer: attendee.organizer }),
          ...(attendee.self !== undefined && attendee.self !== null && { self: attendee.self }),
          ...(attendee.resource !== undefined &&
            attendee.resource !== null && { resource: attendee.resource }),
          ...(attendee.optional !== undefined &&
            attendee.optional !== null && { optional: attendee.optional }),
          ...(responseStatus !== undefined && { responseStatus }),
          ...(attendee.comment && { comment: attendee.comment }),
          ...(attendee.additionalGuests !== undefined &&
            attendee.additionalGuests !== null && { additionalGuests: attendee.additionalGuests }),
        };
      }) ?? [];

    const start: CalendarEventDateTime = {
      ...(event.start?.dateTime && { dateTime: event.start.dateTime }),
      ...(event.start?.date && { date: event.start.date }),
      ...(event.start?.timeZone && { timeZone: event.start.timeZone }),
    };

    const end: CalendarEventDateTime = {
      ...(event.end?.dateTime && { dateTime: event.end.dateTime }),
      ...(event.end?.date && { date: event.end.date }),
      ...(event.end?.timeZone && { timeZone: event.end.timeZone }),
    };

    return {
      id: event.id || "",
      summary: event.summary || "",
      ...(event.description !== undefined &&
        event.description !== null && { description: event.description }),
      ...(event.location !== undefined && event.location !== null && { location: event.location }),
      start,
      end,
      attendees,
      ...(event.organizer !== undefined &&
        event.organizer !== null && {
          organizer: {
            email: event.organizer.email || "",
            ...(event.organizer.displayName && { displayName: event.organizer.displayName }),
            ...(event.organizer.self !== undefined && { self: event.organizer.self }),
          },
        }),
      ...(event.creator !== undefined &&
        event.creator !== null && {
          creator: {
            email: event.creator.email || "",
            ...(event.creator.displayName && { displayName: event.creator.displayName }),
            ...(event.creator.self !== undefined && { self: event.creator.self }),
          },
        }),
      ...(event.status !== undefined &&
        event.status !== null && {
          status: event.status as "confirmed" | "tentative" | "cancelled",
        }),
      ...(event.htmlLink !== undefined && event.htmlLink !== null && { htmlLink: event.htmlLink }),
      ...(event.created !== undefined && event.created !== null && { created: event.created }),
      ...(event.updated !== undefined && event.updated !== null && { updated: event.updated }),
      ...(event.recurringEventId !== undefined &&
        event.recurringEventId !== null && { recurringEventId: event.recurringEventId }),
      ...(event.recurrence !== undefined &&
        event.recurrence !== null && { recurrence: event.recurrence }),
      ...(event.reminders !== undefined &&
        event.reminders !== null && {
          reminders: (() => {
            const overrides = event.reminders.overrides?.map((reminder) => ({
              method: reminder.method as "email" | "popup",
              minutes: reminder.minutes || 0,
            })) as ReadonlyArray<CalendarEventReminder> | undefined;
            return {
              useDefault: event.reminders.useDefault ?? false,
              ...(overrides !== undefined && { overrides }),
            } as const;
          })(),
        }),
      ...(event.colorId !== undefined && event.colorId !== null && { colorId: event.colorId }),
      ...(event.visibility !== undefined &&
        event.visibility !== null && {
          visibility: event.visibility as "default" | "public" | "private" | "confidential",
        }),
      ...(event.guestsCanModify !== undefined &&
        event.guestsCanModify !== null && { guestsCanModify: event.guestsCanModify }),
      ...(event.guestsCanInviteOthers !== undefined &&
        event.guestsCanInviteOthers !== null && {
          guestsCanInviteOthers: event.guestsCanInviteOthers,
        }),
      ...(event.guestsCanSeeOtherGuests !== undefined &&
        event.guestsCanSeeOtherGuests !== null && {
          guestsCanSeeOtherGuests: event.guestsCanSeeOtherGuests,
        }),
      ...(event.conferenceData !== undefined &&
        event.conferenceData !== null && {
          conferenceData: {
            ...(event.conferenceData.entryPoints !== undefined &&
              event.conferenceData.entryPoints !== null && {
                entryPoints: event.conferenceData.entryPoints.map((ep) => ({
                  entryPointType: ep.entryPointType || "",
                  uri: ep.uri || "",
                  ...(ep.label !== undefined && ep.label !== null && { label: ep.label }),
                })),
              }),
          },
        }),
    };
  }

  private parseCalendarToCalendarInfo(
    calendar: calendar_v3.Schema$CalendarListEntry,
  ): CalendarInfo {
    const validAccessRoles = ["freeBusyReader", "reader", "writer", "owner"] as const;
    const accessRole =
      calendar.accessRole &&
      validAccessRoles.includes(calendar.accessRole as (typeof validAccessRoles)[number])
        ? (calendar.accessRole as CalendarInfo["accessRole"])
        : undefined;
    return {
      id: calendar.id || "",
      summary: calendar.summary || "",
      ...(calendar.description && { description: calendar.description }),
      timeZone: calendar.timeZone || "UTC",
      ...(calendar.colorId && { colorId: calendar.colorId }),
      ...(calendar.backgroundColor && { backgroundColor: calendar.backgroundColor }),
      ...(calendar.foregroundColor && { foregroundColor: calendar.foregroundColor }),
      ...(calendar.selected !== undefined &&
        calendar.selected !== null && { selected: calendar.selected }),
      ...(accessRole !== undefined && { accessRole }),
      ...(calendar.primary !== undefined &&
        calendar.primary !== null && { primary: calendar.primary }),
    };
  }

  private buildEventRequestBody(
    event: Partial<Omit<CalendarEvent, "id" | "created" | "updated" | "htmlLink">>,
  ): calendar_v3.Schema$Event {
    const requestBody: calendar_v3.Schema$Event = {};

    if (event.summary !== undefined) requestBody.summary = event.summary;
    if (event.description !== undefined) requestBody.description = event.description;
    if (event.location !== undefined) requestBody.location = event.location;
    if (event.start !== undefined) requestBody.start = event.start;
    if (event.end !== undefined) requestBody.end = event.end;
    if (event.attendees !== undefined) {
      requestBody.attendees = event.attendees.map((attendee) => ({
        email: attendee.email,
        ...(attendee.displayName !== undefined && { displayName: attendee.displayName }),
        ...(attendee.organizer !== undefined && { organizer: attendee.organizer }),
        ...(attendee.self !== undefined && { self: attendee.self }),
        ...(attendee.resource !== undefined && { resource: attendee.resource }),
        ...(attendee.optional !== undefined && { optional: attendee.optional }),
        ...(attendee.responseStatus !== undefined && { responseStatus: attendee.responseStatus }),
        ...(attendee.comment !== undefined && { comment: attendee.comment }),
        ...(attendee.additionalGuests !== undefined && {
          additionalGuests: attendee.additionalGuests,
        }),
      }));
    }
    if (event.recurrence !== undefined) requestBody.recurrence = [...event.recurrence];
    if (event.reminders !== undefined) {
      requestBody.reminders = {
        useDefault: event.reminders.useDefault,
        ...(event.reminders.overrides && {
          overrides: event.reminders.overrides.map((r) => ({
            method: r.method,
            minutes: r.minutes,
          })),
        }),
      };
    }
    if (event.colorId !== undefined) requestBody.colorId = event.colorId;
    if (event.visibility !== undefined) requestBody.visibility = event.visibility;
    if (event.guestsCanModify !== undefined) requestBody.guestsCanModify = event.guestsCanModify;
    if (event.guestsCanInviteOthers !== undefined)
      requestBody.guestsCanInviteOthers = event.guestsCanInviteOthers;
    if (event.guestsCanSeeOtherGuests !== undefined)
      requestBody.guestsCanSeeOtherGuests = event.guestsCanSeeOtherGuests;

    return requestBody;
  }

  private wrapCalendarCall<A>(
    operation: () => Promise<A>,
    failureMessage: string,
  ): Effect.Effect<A, CalendarOperationError> {
    return Effect.tryPromise({
      try: operation,
      catch: (err) => {
        const status = getHttpStatusFromError(err);
        return new CalendarOperationError({
          message: `${failureMessage}: ${err instanceof Error ? err.message : String(err)}`,
          ...(status !== undefined ? { status } : {}),
        });
      },
    });
  }
}

// Layer for providing the real Calendar service
export function createCalendarServiceLayer(): Layer.Layer<
  CalendarService,
  never,
  FileSystem.FileSystem | AgentConfigService | LoggerService | TerminalService
> {
  return Layer.effect(
    CalendarServiceTag,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const terminal = yield* TerminalServiceTag;

      const agentConfig = yield* AgentConfigServiceTag;
      const appConfig = yield* agentConfig.appConfig;
      const clientId = appConfig.google?.clientId;
      const clientSecret = appConfig.google?.clientSecret;
      const missingCreds = !clientId || !clientSecret;

      function requireCredentials(): Effect.Effect<void, CalendarAuthenticationError> {
        if (missingCreds) {
          return Effect.fail(
            new CalendarAuthenticationError({
              message:
                "Missing Google OAuth credentials. Set config.google.clientId and config.google.clientSecret.",
            }),
          );
        }
        return Effect.void as Effect.Effect<void, CalendarAuthenticationError>;
      }

      const port = getGoogleOAuthPort();
      const redirectUri = getGoogleOAuthRedirectUri(port);
      const oauth2Client = new auth.OAuth2(clientId, clientSecret, redirectUri);
      const calendarInstance = calendar({ version: "v3", auth: oauth2Client });

      const { storage } = yield* agentConfig.appConfig;
      const dataDir = resolveStorageDirectory(storage);
      const tokenFilePath = getGoogleTokenFilePath(dataDir); // Shared with Gmail
      const service: CalendarService = new CalendarServiceResource(
        fs,
        tokenFilePath,
        oauth2Client,
        calendarInstance,
        requireCredentials,
        terminal,
      );

      return service;
    }),
  );
}

// Helper functions for common Calendar operations
export function authenticateCalendar(): Effect.Effect<
  void,
  CalendarAuthenticationError,
  CalendarService
> {
  return Effect.gen(function* () {
    const calendarService = yield* CalendarServiceTag;
    return yield* calendarService.authenticate();
  });
}

export function listCalendarEvents(
  calendarId: string,
  options?: ListEventsOptions,
): Effect.Effect<
  CalendarEvent[],
  CalendarOperationError | CalendarAuthenticationError,
  CalendarService
> {
  return Effect.gen(function* () {
    const calendarService = yield* CalendarServiceTag;
    return yield* calendarService.listEvents(calendarId, options);
  });
}

export function getCalendarEvent(
  calendarId: string,
  eventId: string,
): Effect.Effect<
  CalendarEvent,
  CalendarOperationError | CalendarAuthenticationError,
  CalendarService
> {
  return Effect.gen(function* () {
    const calendarService = yield* CalendarServiceTag;
    return yield* calendarService.getEvent(calendarId, eventId);
  });
}

export function createCalendarEvent(
  calendarId: string,
  event: Omit<CalendarEvent, "id" | "created" | "updated" | "htmlLink">,
  options?: CreateEventOptions,
): Effect.Effect<
  CalendarEvent,
  CalendarOperationError | CalendarAuthenticationError,
  CalendarService
> {
  return Effect.gen(function* () {
    const calendarService = yield* CalendarServiceTag;
    return yield* calendarService.createEvent(calendarId, event, options);
  });
}

export function updateCalendarEvent(
  calendarId: string,
  eventId: string,
  event: Partial<Omit<CalendarEvent, "id" | "created" | "updated" | "htmlLink">>,
  options?: UpdateEventOptions,
): Effect.Effect<
  CalendarEvent,
  CalendarOperationError | CalendarAuthenticationError,
  CalendarService
> {
  return Effect.gen(function* () {
    const calendarService = yield* CalendarServiceTag;
    return yield* calendarService.updateEvent(calendarId, eventId, event, options);
  });
}

export function deleteCalendarEvent(
  calendarId: string,
  eventId: string,
  sendNotifications?: boolean,
): Effect.Effect<void, CalendarOperationError | CalendarAuthenticationError, CalendarService> {
  return Effect.gen(function* () {
    const calendarService = yield* CalendarServiceTag;
    return yield* calendarService.deleteEvent(calendarId, eventId, sendNotifications);
  });
}

export function listCalendars(): Effect.Effect<
  CalendarInfo[],
  CalendarOperationError | CalendarAuthenticationError,
  CalendarService
> {
  return Effect.gen(function* () {
    const calendarService = yield* CalendarServiceTag;
    return yield* calendarService.listCalendars();
  });
}

export function searchCalendarEvents(
  query: string,
  options?: ListEventsOptions,
): Effect.Effect<
  CalendarEvent[],
  CalendarOperationError | CalendarAuthenticationError,
  CalendarService
> {
  return Effect.gen(function* () {
    const calendarService = yield* CalendarServiceTag;
    return yield* calendarService.searchEvents(query, options);
  });
}

export function quickAddCalendarEvent(
  calendarId: string,
  text: string,
  sendNotifications?: boolean,
): Effect.Effect<
  CalendarEvent,
  CalendarOperationError | CalendarAuthenticationError,
  CalendarService
> {
  return Effect.gen(function* () {
    const calendarService = yield* CalendarServiceTag;
    return yield* calendarService.quickAddEvent(calendarId, text, sendNotifications);
  });
}
