import { Effect } from "effect";
import { z } from "zod";
import { CalendarServiceTag, type CalendarService } from "../../../interfaces/calendar";
import type { Tool } from "../../../interfaces/tool-registry";
import type { CalendarEventAttendee } from "../../../types/calendar";
import {
  defineTool,
  formatApprovalRequiredDescription,
  formatExecutionToolDescription,
} from "../base-tool";
import { formatEventForDisplay } from "./utils";

/**
 * Create calendar event tool
 */

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
    description: formatApprovalRequiredDescription(
      "Create a new event in Google Calendar with specified details. Supports both timed events (using startDateTime/endDateTime) and all-day events (using startDate/endDate). Can specify title, description, location, attendees, and notifications. This tool requests user approval and does NOT perform the event creation directly. After the user confirms, you MUST call execute_create_calendar_event with the exact arguments provided in the approval response.",
    ),
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
    description: formatExecutionToolDescription(
      "Performs the actual calendar event creation after user approval of create_calendar_event. Creates a new event in Google Calendar with the specified details. This tool should only be called after create_calendar_event receives user approval.",
    ),
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
