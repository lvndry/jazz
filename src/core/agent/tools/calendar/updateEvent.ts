import { Effect } from "effect";
import { z } from "zod";
import { CalendarServiceTag, type CalendarService } from "@/core/interfaces/calendar";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { CalendarEvent } from "@/core/types/calendar";
import {
  defineTool,
  formatApprovalRequiredDescription,
  formatExecutionToolDescription,
} from "../base-tool";
import { formatEventForDisplay } from "./utils";

/**
 * Update calendar event tool
 */

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
    description: formatApprovalRequiredDescription(
      "Update an existing calendar event's properties. Can modify title, description, location, time, or timezone. Only provided fields will be updated; others remain unchanged. Use to reschedule events or update event details. This tool requests user approval and does NOT perform the update directly. After the user confirms, you MUST call execute_update_calendar_event with the exact arguments provided in the approval response.",
    ),
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
    description: formatExecutionToolDescription(
      "Performs the actual calendar event update after user approval of update_calendar_event. Updates an existing event's properties in Google Calendar. This tool should only be called after update_calendar_event receives user approval.",
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
