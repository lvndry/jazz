/**
 * Google Calendar types and interfaces
 * Based on Google Calendar API v3
 */

/**
 * Attendee of a calendar event
 *
 * Represents a person or resource invited to a calendar event with their RSVP status and details.
 */
export interface CalendarEventAttendee {
  readonly email: string;
  readonly displayName?: string;
  readonly organizer?: boolean;
  readonly self?: boolean;
  readonly resource?: boolean;
  readonly optional?: boolean;
  readonly responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
  readonly comment?: string;
  readonly additionalGuests?: number;
}

/**
 * Date/time specification for a calendar event
 *
 * Can represent either a specific point in time (dateTime) or an all-day event (date).
 */
export interface CalendarEventDateTime {
  readonly dateTime?: string; // RFC3339 timestamp
  readonly date?: string; // Date only (YYYY-MM-DD)
  readonly timeZone?: string;
}

/**
 * Recurring event rule definitions in RRULE format
 *
 * Array of recurrence rules following RFC5545 specification, including RRULE, EXRULE, RDATE, and EXDATE.
 */
export type CalendarEventRecurrence = ReadonlyArray<string>; // RRULE, EXRULE, RDATE, EXDATE

/**
 * Reminder configuration for calendar events
 *
 * Defines when and how to notify attendees about an upcoming event.
 */
export interface CalendarEventReminder {
  readonly method: "email" | "popup";
  readonly minutes: number;
}

/**
 * Core calendar event entity
 *
 * Represents a single event on a calendar with all associated metadata, attendees,
 * timing, and recurrence information.
 */
export interface CalendarEvent {
  readonly id: string;
  summary: string;
  description?: string;
  location?: string;
  start: CalendarEventDateTime;
  end: CalendarEventDateTime;
  attendees?: CalendarEventAttendee[];
  organizer?: {
    email: string;
    displayName?: string;
    self?: boolean;
  };
  readonly creator?: {
    readonly email: string;
    readonly displayName?: string;
    readonly self?: boolean;
  };
  readonly status?: "confirmed" | "tentative" | "cancelled";
  readonly htmlLink?: string;
  readonly created?: string;
  readonly updated?: string;
  readonly recurringEventId?: string;
  readonly recurrence?: CalendarEventRecurrence;
  readonly reminders?: {
    readonly useDefault: boolean;
    readonly overrides?: ReadonlyArray<CalendarEventReminder>;
  };
  readonly colorId?: string;
  readonly visibility?: "default" | "public" | "private" | "confidential";
  readonly guestsCanModify?: boolean;
  readonly guestsCanInviteOthers?: boolean;
  readonly guestsCanSeeOtherGuests?: boolean;
  readonly conferenceData?: {
    readonly entryPoints?: ReadonlyArray<{
      readonly entryPointType: string;
      readonly uri: string;
      readonly label?: string;
    }>;
  };
}

/**
 * Calendar information
 */
export interface CalendarInfo {
  readonly id: string;
  readonly summary: string;
  readonly description?: string;
  readonly timeZone: string;
  readonly colorId?: string;
  readonly backgroundColor?: string;
  readonly foregroundColor?: string;
  readonly selected?: boolean;
  readonly accessRole?: "freeBusyReader" | "reader" | "writer" | "owner";
  readonly primary?: boolean;
}

/**
 * Options for creating a calendar event
 */
export interface CreateEventOptions {
  readonly sendNotifications?: boolean;
  readonly conferenceDataVersion?: number;
  readonly supportsAttachments?: boolean;
}

/**
 * Options for updating a calendar event
 */
export interface UpdateEventOptions {
  readonly sendNotifications?: boolean;
  readonly conferenceDataVersion?: number;
  readonly supportsAttachments?: boolean;
}

/**
 * Options for listing calendar events
 */
export interface ListEventsOptions {
  readonly timeMin?: string; // RFC3339 timestamp
  readonly timeMax?: string; // RFC3339 timestamp
  readonly maxResults?: number;
  readonly query?: string; // Free text search
  readonly singleEvents?: boolean; // Expand recurring events
  readonly orderBy?: "startTime" | "updated";
  readonly showDeleted?: boolean;
  readonly updatedMin?: string;
}
