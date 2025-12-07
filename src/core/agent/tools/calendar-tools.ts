import { Effect } from "effect";
import { z } from "zod";
import { CalendarServiceTag, type CalendarService } from "../../interfaces/calendar";
import type { Tool } from "../../interfaces/tool-registry";
import type { CalendarEvent, CalendarEventAttendee, CalendarInfo } from "../../types/calendar";
import { defineTool } from "./base-tool";

/**
 * Calendar tools for agent
 */

// Helper function to format date/time for display
function formatDateTime(dt: { dateTime?: string; date?: string; timeZone?: string }): string {
  if (dt.dateTime) {
    const date = new Date(dt.dateTime);
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString()} ${dt.timeZone ? `(${dt.timeZone})` : ""}`;
  }
  if (dt.date) {
    return `${dt.date} (All-day)`;
  }
  return "No time specified";
}

// Format event for display
function formatEventForDisplay(event: CalendarEvent): string {
  const parts = [
    `📅 ${event.summary}`,
    `   ID: ${event.id}`,
    `   ⏰ Start: ${formatDateTime(event.start)}`,
    `   ⏰ End: ${formatDateTime(event.end)}`,
  ];

  if (event.description) parts.push(`   📝 ${event.description}`);
  if (event.location) parts.push(`   📍 ${event.location}`);
  if (event.attendees && event.attendees.length > 0) {
    parts.push(`   👥 Attendees (${event.attendees.length}):`);
    event.attendees.slice(0, 5).forEach((a) => {
      const status = a.responseStatus ? ` [${a.responseStatus}]` : "";
      parts.push(`      - ${a.displayName || a.email}${status}`);
    });
    if (event.attendees.length > 5) {
      parts.push(`      ... and ${event.attendees.length - 5} more`);
    }
  }
  if (event.status) parts.push(`   Status: ${event.status}`);
  if (event.htmlLink) parts.push(`   🔗 ${event.htmlLink}`);

  return parts.join("\\n");
}

// Format events list for display
function formatEventsForDisplay(events: CalendarEvent[]): string {
  if (events.length === 0) return "No events found";
  return events.map((e) => formatEventForDisplay(e)).join("\\n\\n");
}

// Format calendar for display
function formatCalendarForDisplay(calendar: CalendarInfo): string {
  const parts = [
    `📆 ${calendar.summary}${calendar.primary ? " (Primary)" : ""}`,
    `   ID: ${calendar.id}`,
    `   Timezone: ${calendar.timeZone}`,
  ];
  if (calendar.description) parts.push(`   Description: ${calendar.description}`);
  if (calendar.accessRole) parts.push(`   Access: ${calendar.accessRole}`);
  return parts.join("\\n");
}

// Format calendars list for display
function formatCalendarsForDisplay(calendars: CalendarInfo[]): string {
  if (calendars.length === 0) return "No calendars found";
  return calendars.map((c) => formatCalendarForDisplay(c)).join("\\n\\n");
}

// List calendar events tool
export function createListCalendarEventsTool(): Tool<CalendarService> {
  const parameters = z
    .object({
      calendarId: z
        .string()
        .optional()
        .default("primary")
        .describe("Calendar ID ('primary' for user's primary calendar)"),
      maxResults: z.number().int().min(1).max(100).optional().describe("Maximum events to return"),
      timeMin: z
        .string()
        .optional()
        .describe("RFC3339 timestamp for start range (e.g., '2024-01-01T00:00:00Z')"),
      timeMax: z
        .string()
        .optional()
        .describe("RFC3339 timestamp for end range (e.g., '2024-12-31T23:59:59Z')"),
      query: z.string().optional().describe("Free text search query to filter events"),
    })
    .strict();

  type ListCalendarEventsArgs = z.infer<typeof parameters>;
  return defineTool<CalendarService, ListCalendarEventsArgs>({
    name: "list_calendar_events",
    description:
      "List events from a Google Calendar with optional time range and search filters. Returns event details including title, time, location, attendees. Use 'primary' as calendarId for the user's main calendar. Supports filtering by time range (timeMin/timeMax) and text search.",
    tags: ["calendar", "list"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (validatedArgs) =>
      Effect.gen(function* () {
        const calendarService = yield* CalendarServiceTag;
        const events = yield* calendarService.listEvents(validatedArgs.calendarId, {
          ...(validatedArgs.maxResults && { maxResults: validatedArgs.maxResults }),
          ...(validatedArgs.timeMin && { timeMin: validatedArgs.timeMin }),
          ...(validatedArgs.timeMax && { timeMax: validatedArgs.timeMax }),
          ...(validatedArgs.query && { query: validatedArgs.query }),
        });
        return { success: true, result: formatEventsForDisplay(events) };
      }),
  });
}

// Get calendar event tool
export function createGetCalendarEventTool(): Tool<CalendarService> {
  const parameters = z
    .object({
      calendarId: z
        .string()
        .optional()
        .default("primary")
        .describe("Calendar ID ('primary' for user's primary calendar)"),
      eventId: z.string().min(1).describe("ID of the event to retrieve"),
    })
    .strict();

  type GetCalendarEventArgs = z.infer<typeof parameters>;
  return defineTool<CalendarService, GetCalendarEventArgs>({
    name: "get_calendar_event",
    description:
      "Retrieve the complete details of a specific calendar event by its ID. Returns full event information including title, description, time, location, attendees, recurrence, reminders, and conference data. Use after list_calendar_events to get full details of a specific event.",
    tags: ["calendar", "read"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (validatedArgs) =>
      Effect.gen(function* () {
        const calendarService = yield* CalendarServiceTag;
        const event = yield* calendarService.getEvent(
          validatedArgs.calendarId,
          validatedArgs.eventId,
        );
        return { success: true, result: formatEventForDisplay(event) };
      }),
  });
}

// Create calendar event tool
export function createCreateCalendarEventTool(): Tool<CalendarService> {
  const parameters = z
    .object({
      calendarId: z
        .string()
        .optional()
        .default("primary")
        .describe("Calendar ID ('primary' for user's primary calendar)"),
      summary: z.string().min(1).describe("Event title/summary"),
      description: z.string().optional().describe("Event description"),
      location: z.string().optional().describe("Event location"),
      startDateTime: z
        .string()
        .optional()
        .describe("Start date-time (RFC3339, e.g., '2024-01-15T14:00:00-08:00')"),
      startDate: z.string().optional().describe("Start date for all-day events (YYYY-MM-DD)"),
      endDateTime: z
        .string()
        .optional()
        .describe("End date-time (RFC3339, e.g., '2024-01-15T15:00:00-08:00')"),
      endDate: z.string().optional().describe("End date for all-day events (YYYY-MM-DD)"),
      timeZone: z
        .string()
        .optional()
        .describe("Timezone for the event (e.g., 'America/Los_Angeles')"),
      attendees: z
        .array(
          z.object({
            email: z.string().email().describe("Attendee email address"),
            displayName: z.string().optional().describe("Attendee display name"),
            optional: z.boolean().optional().describe("Whether attendance is optional"),
          }),
        )
        .optional()
        .describe("List of event attendees"),
      sendNotifications: z
        .boolean()
        .optional()
        .default(true)
        .describe("Whether to send notifications to attendees"),
    })
    .strict()
    .refine(
      (data) => (data.startDateTime && data.endDateTime) || (data.startDate && data.endDate),
      {
        message: "Must provide either startDateTime+endDateTime OR startDate+endDate",
      },
    );

  type CreateCalendarEventArgs = z.infer<typeof parameters>;
  return defineTool<CalendarService, CreateCalendarEventArgs>({
    name: "create_calendar_event",
    description:
      "⚠️ APPROVAL REQUIRED: Create a new event in Google Calendar with specified details. Supports both timed events (using startDateTime/endDateTime) and all-day events (using startDate/endDate). Can specify title, description, location, attendees, and notifications. This tool requests user approval and does NOT perform the event creation directly. After the user confirms, you MUST call execute_create_calendar_event with the exact arguments provided in the approval response.",
    tags: ["calendar", "create"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args) =>
        Effect.succeed(
          `About to create calendar event:\\n\\n` +
            `📅 ${args.summary}\\n` +
            `${args.description ? `📝 ${args.description}\\n` : ""}` +
            `${args.location ? `📍 ${args.location}\\n` : ""}` +
            `⏰ ${args.startDateTime || args.startDate} → ${args.endDateTime || args.endDate}\\n` +
            `${args.attendees ? `👥 ${args.attendees.length} attendee(s)\\n` : ""}` +
            `\\nIf the user confirms, call execute_create_calendar_event with the same arguments.`,
        ),
      execute: {
        toolName: "execute_create_calendar_event",
        buildArgs: (args) => args,
      },
    },
    handler: (validatedArgs) =>
      Effect.gen(function* () {
        const calendarService = yield* CalendarServiceTag;

        const event = yield* calendarService.createEvent(
          validatedArgs.calendarId,
          {
            summary: validatedArgs.summary,
            ...(validatedArgs.description && { description: validatedArgs.description }),
            ...(validatedArgs.location && { location: validatedArgs.location }),
            start: {
              ...(validatedArgs.startDateTime && { dateTime: validatedArgs.startDateTime }),
              ...(validatedArgs.startDate && { date: validatedArgs.startDate }),
              ...(validatedArgs.timeZone && { timeZone: validatedArgs.timeZone }),
            },
            end: {
              ...(validatedArgs.endDateTime && { dateTime: validatedArgs.endDateTime }),
              ...(validatedArgs.endDate && { date: validatedArgs.endDate }),
              ...(validatedArgs.timeZone && { timeZone: validatedArgs.timeZone }),
            },
            ...(validatedArgs.attendees && {
              attendees: validatedArgs.attendees as CalendarEventAttendee[],
            }),
          },
          { sendNotifications: validatedArgs.sendNotifications },
        );

        return { success: true, result: formatEventForDisplay(event) };
      }),
  });
}

// Execute create calendar event (internal - after approval)
export function createExecuteCreateCalendarEventTool(): Tool<CalendarService> {
  const parameters = z
    .object({
      calendarId: z.string().optional().default("primary"),
      summary: z.string().min(1),
      description: z.string().optional(),
      location: z.string().optional(),
      startDateTime: z.string().optional(),
      startDate: z.string().optional(),
      endDateTime: z.string().optional(),
      endDate: z.string().optional(),
      timeZone: z.string().optional(),
      attendees: z
        .array(
          z.object({
            email: z.string().email(),
            displayName: z.string().optional(),
            optional: z.boolean().optional(),
          }),
        )
        .optional(),
      sendNotifications: z.boolean().optional().default(true),
    })
    .strict();

  type ExecuteCreateCalendarEventArgs = z.infer<typeof parameters>;
  return defineTool<CalendarService, ExecuteCreateCalendarEventArgs>({
    name: "execute_create_calendar_event",
    description:
      "🔧 EXECUTION TOOL: Performs the actual calendar event creation after user approval of create_calendar_event. Creates a new event in Google Calendar with the specified details. This tool should only be called after create_calendar_event receives user approval.",
    hidden: true,
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (validatedArgs) =>
      Effect.gen(function* () {
        const calendarService = yield* CalendarServiceTag;

        const event = yield* calendarService.createEvent(
          validatedArgs.calendarId,
          {
            summary: validatedArgs.summary,
            ...(validatedArgs.description && { description: validatedArgs.description }),
            ...(validatedArgs.location && { location: validatedArgs.location }),
            start: {
              ...(validatedArgs.startDateTime && { dateTime: validatedArgs.startDateTime }),
              ...(validatedArgs.startDate && { date: validatedArgs.startDate }),
              ...(validatedArgs.timeZone && { timeZone: validatedArgs.timeZone }),
            },
            end: {
              ...(validatedArgs.endDateTime && { dateTime: validatedArgs.endDateTime }),
              ...(validatedArgs.endDate && { date: validatedArgs.endDate }),
              ...(validatedArgs.timeZone && { timeZone: validatedArgs.timeZone }),
            },
            ...(validatedArgs.attendees && {
              attendees: validatedArgs.attendees as CalendarEventAttendee[],
            }),
          },
          { sendNotifications: validatedArgs.sendNotifications },
        );

        return { success: true, result: formatEventForDisplay(event) };
      }),
  });
}

// Update calendar event tool
export function createUpdateCalendarEventTool(): Tool<CalendarService> {
  const parameters = z
    .object({
      calendarId: z.string().optional().default("primary"),
      eventId: z.string().min(1).describe("ID of the event to update"),
      summary: z.string().optional().describe("New event title"),
      description: z.string().optional().describe("New event description"),
      location: z.string().optional().describe("New event location"),
      startDateTime: z.string().optional().describe("New start date-time (RFC3339)"),
      startDate: z.string().optional().describe("New start date for all-day events (YYYY-MM-DD)"),
      endDateTime: z.string().optional().describe("New end date-time (RFC3339)"),
      endDate: z.string().optional().describe("New end date for all-day events (YYYY-MM-DD)"),
      timeZone: z.string().optional().describe("New timezone"),
      sendNotifications: z.boolean().optional().default(true),
    })
    .strict();

  type UpdateCalendarEventArgs = z.infer<typeof parameters>;
  return defineTool<CalendarService, UpdateCalendarEventArgs>({
    name: "update_calendar_event",
    description:
      "⚠️ APPROVAL REQUIRED: Update an existing calendar event's properties. Can modify title, description, location, time, or timezone. Only provided fields will be updated; others remain unchanged. Use to reschedule events or update event details. This tool requests user approval and does NOT perform the update directly. After the user confirms, you MUST call execute_update_calendar_event with the exact arguments provided in the approval response.",
    tags: ["calendar", "update"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args) =>
        Effect.gen(function* () {
          const calendarService = yield* CalendarServiceTag;
          try {
            const event = yield* calendarService.getEvent(
              args.calendarId || "primary",
              args.eventId,
            );
            return (
              `About to update calendar event:\\n\\n` +
              `Current: ${event.summary}\\n` +
              `${args.summary ? `New title: ${args.summary}\\n` : ""}` +
              `${args.description !== undefined ? `New description: ${args.description}\\n` : ""}` +
              `${args.location !== undefined ? `New location: ${args.location}\\n` : ""}` +
              `${args.startDateTime || args.startDate ? `New start: ${args.startDateTime || args.startDate}\\n` : ""}` +
              `${args.endDateTime || args.endDate ? `New end: ${args.endDateTime || args.endDate}\\n` : ""}` +
              `\\nIf the user confirms, call execute_update_calendar_event with the same arguments.`
            );
          } catch {
            return `About to update event ${args.eventId}. If the user confirms, call execute_update_calendar_event with the same arguments.`;
          }
        }),
      execute: {
        toolName: "execute_update_calendar_event",
        buildArgs: (args) => args,
      },
    },
    handler: (validatedArgs) =>
      Effect.gen(function* () {
        const calendarService = yield* CalendarServiceTag;

        const updates: Partial<Omit<CalendarEvent, "id" | "created" | "updated" | "htmlLink">> = {};
        if (validatedArgs.summary) updates.summary = validatedArgs.summary;
        if (validatedArgs.description !== undefined)
          updates.description = validatedArgs.description;
        if (validatedArgs.location !== undefined) updates.location = validatedArgs.location;
        if (validatedArgs.startDateTime || validatedArgs.startDate) {
          updates.start = {
            dateTime: validatedArgs.startDateTime ?? "",
            date: validatedArgs.startDate ?? "",
            timeZone: validatedArgs.timeZone ?? "",
          };
        }
        if (validatedArgs.endDateTime || validatedArgs.endDate) {
          updates.end = {
            dateTime: validatedArgs.endDateTime ?? "",
            date: validatedArgs.endDate ?? "",
            timeZone: validatedArgs.timeZone ?? "",
          };
        }

        const event = yield* calendarService.updateEvent(
          validatedArgs.calendarId,
          validatedArgs.eventId,
          updates,
          { sendNotifications: validatedArgs.sendNotifications },
        );

        return { success: true, result: formatEventForDisplay(event) };
      }),
  });
}

// Execute update calendar event (internal)
export function createExecuteUpdateCalendarEventTool(): Tool<CalendarService> {
  const parameters = z
    .object({
      calendarId: z.string().optional().default("primary"),
      eventId: z.string().min(1),
      summary: z.string().optional(),
      description: z.string().optional(),
      location: z.string().optional(),
      startDateTime: z.string().optional(),
      startDate: z.string().optional(),
      endDateTime: z.string().optional(),
      endDate: z.string().optional(),
      timeZone: z.string().optional(),
      sendNotifications: z.boolean().optional().default(true),
    })
    .strict();

  type ExecuteUpdateCalendarEventArgs = z.infer<typeof parameters>;
  return defineTool<CalendarService, ExecuteUpdateCalendarEventArgs>({
    name: "execute_update_calendar_event",
    description:
      "🔧 EXECUTION TOOL: Performs the actual calendar event update after user approval of update_calendar_event. Updates an existing event's properties in Google Calendar. This tool should only be called after update_calendar_event receives user approval.",
    hidden: true,
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (validatedArgs) =>
      Effect.gen(function* () {
        const calendarService = yield* CalendarServiceTag;

        const updates = {
          ...(validatedArgs.summary && { summary: validatedArgs.summary }),
          ...(validatedArgs.description !== undefined && {
            description: validatedArgs.description,
          }),
          ...(validatedArgs.location !== undefined && { location: validatedArgs.location }),
          ...(validatedArgs.startDateTime || validatedArgs.startDate
            ? {
                start: {
                  ...(validatedArgs.startDateTime && { dateTime: validatedArgs.startDateTime }),
                  ...(validatedArgs.startDate && { date: validatedArgs.startDate }),
                  ...(validatedArgs.timeZone && { timeZone: validatedArgs.timeZone }),
                },
              }
            : {}),
          ...(validatedArgs.endDateTime || validatedArgs.endDate
            ? {
                end: {
                  ...(validatedArgs.endDateTime && { dateTime: validatedArgs.endDateTime }),
                  ...(validatedArgs.endDate && { date: validatedArgs.endDate }),
                  ...(validatedArgs.timeZone && { timeZone: validatedArgs.timeZone }),
                },
              }
            : {}),
        };

        const event = yield* calendarService.updateEvent(
          validatedArgs.calendarId,
          validatedArgs.eventId,
          updates,
          { sendNotifications: validatedArgs.sendNotifications },
        );

        return { success: true, result: formatEventForDisplay(event) };
      }),
  });
}

// Delete calendar event tool
export function createDeleteCalendarEventTool(): Tool<CalendarService> {
  const parameters = z
    .object({
      calendarId: z.string().optional().default("primary"),
      eventId: z.string().min(1).describe("ID of the event to delete"),
      sendNotifications: z.boolean().optional().default(true),
    })
    .strict();

  type DeleteCalendarEventArgs = z.infer<typeof parameters>;
  return defineTool<CalendarService, DeleteCalendarEventArgs>({
    name: "delete_calendar_event",
    description:
      "⚠️ APPROVAL REQUIRED: Permanently delete a calendar event. This action cannot be undone. Use to remove cancelled or incorrect events from the calendar. This tool requests user approval and does NOT perform the deletion directly. After the user confirms, you MUST call execute_delete_calendar_event with the exact arguments provided in the approval response.",
    tags: ["calendar", "delete"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args) =>
        Effect.gen(function* () {
          const calendarService = yield* CalendarServiceTag;
          try {
            const event = yield* calendarService.getEvent(
              args.calendarId || "primary",
              args.eventId,
            );
            return (
              `About to PERMANENTLY DELETE calendar event:\\n\\n` +
              formatEventForDisplay(event) +
              `\\n\\n⚠️  This action cannot be undone!\\n\\nIf the user confirms, call execute_delete_calendar_event with the same arguments.`
            );
          } catch {
            return `About to permanently delete event ${args.eventId}. This cannot be undone! If the user confirms, call execute_delete_calendar_event with the same arguments.`;
          }
        }),
      execute: {
        toolName: "execute_delete_calendar_event",
        buildArgs: (args) => args,
      },
    },
    handler: (validatedArgs) =>
      Effect.gen(function* () {
        const calendarService = yield* CalendarServiceTag;
        yield* calendarService.deleteEvent(
          validatedArgs.calendarId,
          validatedArgs.eventId,
          validatedArgs.sendNotifications,
        );
        return { success: true, result: `Event ${validatedArgs.eventId} deleted successfully` };
      }),
  });
}

// Execute delete calendar event (internal)
export function createExecuteDeleteCalendarEventTool(): Tool<CalendarService> {
  const parameters = z
    .object({
      calendarId: z.string().optional().default("primary"),
      eventId: z.string().min(1),
      sendNotifications: z.boolean().optional().default(true),
    })
    .strict();

  type ExecuteDeleteCalendarEventArgs = z.infer<typeof parameters>;
  return defineTool<CalendarService, ExecuteDeleteCalendarEventArgs>({
    name: "execute_delete_calendar_event",
    description:
      "🔧 EXECUTION TOOL: Performs the actual calendar event deletion after user approval of delete_calendar_event. Permanently deletes an event from Google Calendar. This tool should only be called after delete_calendar_event receives user approval.",
    hidden: true,
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (validatedArgs) =>
      Effect.gen(function* () {
        const calendarService = yield* CalendarServiceTag;
        yield* calendarService.deleteEvent(
          validatedArgs.calendarId,
          validatedArgs.eventId,
          validatedArgs.sendNotifications,
        );
        return { success: true, result: `Event ${validatedArgs.eventId} deleted successfully` };
      }),
  });
}

// Search calendar events tool
export function createSearchCalendarEventsTool(): Tool<CalendarService> {
  const parameters = z
    .object({
      query: z.string().min(1).describe("Search query to find events"),
      maxResults: z.number().int().min(1).max(100).optional().describe("Maximum events to return"),
      timeMin: z.string().optional().describe("Start of time range (RFC3339)"),
      timeMax: z.string().optional().describe("End of time range (RFC3339)"),
    })
    .strict();

  type SearchCalendarEventsArgs = z.infer<typeof parameters>;
  return defineTool<CalendarService, SearchCalendarEventsArgs>({
    name: "search_calendar_events",
    description:
      "Search for events across the primary calendar using free text search. Searches event titles, descriptions, locations, and attendee names. Optionally filter by time range. Returns matching events with full details.",
    tags: ["calendar", "search"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (validatedArgs) =>
      Effect.gen(function* () {
        const calendarService = yield* CalendarServiceTag;
        const events = yield* calendarService.searchEvents(validatedArgs.query, {
          ...(validatedArgs.maxResults && { maxResults: validatedArgs.maxResults }),
          ...(validatedArgs.timeMin && { timeMin: validatedArgs.timeMin }),
          ...(validatedArgs.timeMax && { timeMax: validatedArgs.timeMax }),
        });
        return { success: true, result: formatEventsForDisplay(events) };
      }),
  });
}

// List calendars tool
export function createListCalendarsTool(): Tool<CalendarService> {
  const parameters = z.object({}).strict();

  type ListCalendarsArgs = z.infer<typeof parameters>;
  return defineTool<CalendarService, ListCalendarsArgs>({
    name: "list_calendars",
    description:
      "List all calendars accessible to the user including the primary calendar and any subscribed calendars. Returns calendar details including ID, name, timezone, and access permissions. Use to discover available calendars before accessing events.",
    tags: ["calendar", "list"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data as unknown as Record<string, never> } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: () =>
      Effect.gen(function* () {
        const calendarService = yield* CalendarServiceTag;
        const calendars = yield* calendarService.listCalendars();
        return { success: true, result: formatCalendarsForDisplay(calendars) };
      }),
  });
}

// Quick add event tool (natural language)
export function createQuickAddCalendarEventTool(): Tool<CalendarService> {
  const parameters = z
    .object({
      calendarId: z.string().optional().default("primary"),
      text: z
        .string()
        .min(1)
        .describe(
          "Natural language description of the event (e.g., 'Meeting with John tomorrow at 3pm')",
        ),
      sendNotifications: z.boolean().optional().default(true),
    })
    .strict();

  type QuickAddCalendarEventArgs = z.infer<typeof parameters>;
  return defineTool<CalendarService, QuickAddCalendarEventArgs>({
    name: "quick_add_calendar_event",
    description:
      "⚠️ APPROVAL REQUIRED: Create a calendar event from natural language text using Google's quick add feature. Automatically parses date, time, and title from text like 'Lunch with Sarah tomorrow at noon' or 'Team meeting Friday 2pm-3pm'. Convenient for simple events without detailed parameters. This tool requests user approval and does NOT perform the event creation directly. After the user confirms, you MUST call execute_quick_add_calendar_event with the exact arguments provided in the approval response.",
    tags: ["calendar", "create", "quick"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args) =>
        Effect.succeed(
          `About to create calendar event from text:\\n\\n"${args.text}"\\n\\nIf the user confirms, call execute_quick_add_calendar_event with the same arguments.`,
        ),
      execute: {
        toolName: "execute_quick_add_calendar_event",
        buildArgs: (args) => args,
      },
    },
    handler: (validatedArgs) =>
      Effect.gen(function* () {
        const calendarService = yield* CalendarServiceTag;
        const event = yield* calendarService.quickAddEvent(
          validatedArgs.calendarId,
          validatedArgs.text,
          validatedArgs.sendNotifications,
        );
        return { success: true, result: formatEventForDisplay(event) };
      }),
  });
}

// Execute quick add (internal)
export function createExecuteQuickAddCalendarEventTool(): Tool<CalendarService> {
  const parameters = z
    .object({
      calendarId: z.string().optional().default("primary"),
      text: z.string().min(1),
      sendNotifications: z.boolean().optional().default(true),
    })
    .strict();

  type ExecuteQuickAddCalendarEventArgs = z.infer<typeof parameters>;
  return defineTool<CalendarService, ExecuteQuickAddCalendarEventArgs>({
    name: "execute_quick_add_calendar_event",
    description:
      "🔧 EXECUTION TOOL: Performs the actual calendar event creation from natural language after user approval of quick_add_calendar_event. Creates an event using Google's quick add feature. This tool should only be called after quick_add_calendar_event receives user approval.",
    hidden: true,
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (validatedArgs) =>
      Effect.gen(function* () {
        const calendarService = yield* CalendarServiceTag;
        const event = yield* calendarService.quickAddEvent(
          validatedArgs.calendarId,
          validatedArgs.text,
          validatedArgs.sendNotifications,
        );
        return { success: true, result: formatEventForDisplay(event) };
      }),
  });
}

// Get upcoming events helper tool
export function createGetUpcomingEventsTool(): Tool<CalendarService> {
  const parameters = z
    .object({
      calendarId: z.string().optional().default("primary"),
      count: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Number of upcoming events to return"),
    })
    .strict();

  type GetUpcomingEventsArgs = z.infer<typeof parameters>;
  return defineTool<CalendarService, GetUpcomingEventsArgs>({
    name: "get_upcoming_events",
    description:
      "Get the next N upcoming events from the calendar, starting from now. Convenient shortcut for seeing what's coming up without specifying time ranges. Returns events in chronological order.",
    tags: ["calendar", "list", "upcoming"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: (validatedArgs) =>
      Effect.gen(function* () {
        const calendarService = yield* CalendarServiceTag;
        const now = new Date().toISOString();
        const events = yield* calendarService.listEvents(validatedArgs.calendarId, {
          timeMin: now,
          maxResults: validatedArgs.count,
          singleEvents: true,
          orderBy: "startTime",
        });
        return { success: true, result: formatEventsForDisplay(events) };
      }),
  });
}

/**
 * Export all calendar tools
 */
export const calendarTools = [
  createListCalendarEventsTool(),
  createGetCalendarEventTool(),
  createCreateCalendarEventTool(),
  createExecuteCreateCalendarEventTool(),
  createUpdateCalendarEventTool(),
  createExecuteUpdateCalendarEventTool(),
  createDeleteCalendarEventTool(),
  createExecuteDeleteCalendarEventTool(),
  createSearchCalendarEventsTool(),
  createListCalendarsTool(),
  createQuickAddCalendarEventTool(),
  createExecuteQuickAddCalendarEventTool(),
  createGetUpcomingEventsTool(),
];
