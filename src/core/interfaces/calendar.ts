import { Context, Effect } from "effect";
import type {
  CalendarEvent,
  CalendarInfo,
  CreateEventOptions,
  ListEventsOptions,
  UpdateEventOptions,
} from "@/core/types/calendar";
import { CalendarAuthenticationError, CalendarOperationError } from "@/core/types/errors";

/**
 * Calendar service for interacting with Google Calendar API
 */
export interface CalendarService {
  /** Authenticates with Google Calendar API and initializes the service. */
  readonly authenticate: () => Effect.Effect<void, CalendarAuthenticationError>;

  /** Lists events from a calendar, optionally filtered by time range and query. */
  readonly listEvents: (
    calendarId: string,
    options?: ListEventsOptions,
  ) => Effect.Effect<CalendarEvent[], CalendarOperationError | CalendarAuthenticationError>;

  /** Retrieves a single event by its ID. */
  readonly getEvent: (
    calendarId: string,
    eventId: string,
  ) => Effect.Effect<CalendarEvent, CalendarOperationError | CalendarAuthenticationError>;

  /** Creates a new calendar event. */
  readonly createEvent: (
    calendarId: string,
    event: Omit<CalendarEvent, "id" | "created" | "updated" | "htmlLink">,
    options?: CreateEventOptions,
  ) => Effect.Effect<CalendarEvent, CalendarOperationError | CalendarAuthenticationError>;

  /** Updates an existing calendar event. */
  readonly updateEvent: (
    calendarId: string,
    eventId: string,
    event: Partial<Omit<CalendarEvent, "id" | "created" | "updated" | "htmlLink">>,
    options?: UpdateEventOptions,
  ) => Effect.Effect<CalendarEvent, CalendarOperationError | CalendarAuthenticationError>;

  /** Deletes a calendar event. */
  readonly deleteEvent: (
    calendarId: string,
    eventId: string,
    sendNotifications?: boolean,
  ) => Effect.Effect<void, CalendarOperationError | CalendarAuthenticationError>;

  /** Lists all calendars accessible to the user. */
  readonly listCalendars: () => Effect.Effect<
    CalendarInfo[],
    CalendarOperationError | CalendarAuthenticationError
  >;

  /** Retrieves calendar metadata. */
  readonly getCalendar: (
    calendarId: string,
  ) => Effect.Effect<CalendarInfo, CalendarOperationError | CalendarAuthenticationError>;

  /** Searches for events across all calendars. */
  readonly searchEvents: (
    query: string,
    options?: ListEventsOptions,
  ) => Effect.Effect<CalendarEvent[], CalendarOperationError | CalendarAuthenticationError>;

  /** Creates an event from a quick text description (e.g., "Meeting tomorrow at 3pm"). */
  readonly quickAddEvent: (
    calendarId: string,
    text: string,
    sendNotifications?: boolean,
  ) => Effect.Effect<CalendarEvent, CalendarOperationError | CalendarAuthenticationError>;
}

/**
 * Calendar service tag for dependency injection
 */
export const CalendarServiceTag = Context.GenericTag<CalendarService>("CalendarService");
