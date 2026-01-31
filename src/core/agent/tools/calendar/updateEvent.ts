import { Effect } from "effect";
import { z } from "zod";
import { CalendarServiceTag, type CalendarService } from "@/core/interfaces/calendar";
import type { CalendarEvent } from "@/core/types/calendar";
import type { ToolExecutionContext } from "@/core/types";
import { defineApprovalTool, type ApprovalToolConfig, type ApprovalToolPair } from "../base-tool";
import { formatEventForDisplay } from "./utils";

/**
 * Update calendar event tools (approval + execution)
 */

type UpdateCalendarEventArgs = {
  calendarId: string;
  eventId: string;
  summary?: string;
  description?: string;
  location?: string;
  startDateTime?: string;
  startDate?: string;
  endDateTime?: string;
  endDate?: string;
  timeZone?: string;
  sendNotifications: boolean;
};

const updateEventParameters = z
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

export function createUpdateCalendarEventTools(): ApprovalToolPair<CalendarService> {
  const config: ApprovalToolConfig<CalendarService, UpdateCalendarEventArgs> = {
    name: "update_calendar_event",
    description:
      "Update an existing calendar event's properties. Can modify title, description, location, time, or timezone. Only provided fields will be updated; others remain unchanged. Use to reschedule events or update event details.",
    tags: ["calendar", "update"],
    parameters: updateEventParameters,
    validate: (args) => {
      const params = updateEventParameters.safeParse(args);
      return params.success
        ? { valid: true, value: params.data as UpdateCalendarEventArgs }
        : { valid: false, errors: params.error.issues.map((i) => i.message) };
    },

    approvalMessage: (args: UpdateCalendarEventArgs, _context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const calendarService = yield* CalendarServiceTag;
        try {
          const event = yield* calendarService.getEvent(args.calendarId || "primary", args.eventId);
          return (
            `Current: ${event.summary}\n` +
            `${args.summary ? `New title: ${args.summary}\n` : ""}` +
            `${args.description !== undefined ? `New description: ${args.description}\n` : ""}` +
            `${args.location !== undefined ? `New location: ${args.location}\n` : ""}` +
            `${args.startDateTime || args.startDate ? `New start: ${args.startDateTime || args.startDate}\n` : ""}` +
            `${args.endDateTime || args.endDate ? `New end: ${args.endDateTime || args.endDate}\n` : ""}`
          );
        } catch {
          return `Updating event ${args.eventId}`;
        }
      }),

    approvalErrorMessage: "Calendar event update requires user approval.",

    handler: (args: UpdateCalendarEventArgs, _context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const calendarService = yield* CalendarServiceTag;

        const updates: Partial<Omit<CalendarEvent, "id" | "created" | "updated" | "htmlLink">> = {};
        if (args.summary) updates.summary = args.summary;
        if (args.description !== undefined) updates.description = args.description;
        if (args.location !== undefined) updates.location = args.location;
        if (args.startDateTime || args.startDate) {
          updates.start = {
            dateTime: args.startDateTime ?? "",
            date: args.startDate ?? "",
            timeZone: args.timeZone ?? "",
          };
        }
        if (args.endDateTime || args.endDate) {
          updates.end = {
            dateTime: args.endDateTime ?? "",
            date: args.endDate ?? "",
            timeZone: args.timeZone ?? "",
          };
        }

        const event = yield* calendarService.updateEvent(args.calendarId, args.eventId, updates, {
          sendNotifications: args.sendNotifications,
        });

        return { success: true, result: formatEventForDisplay(event) };
      }),
  };

  return defineApprovalTool<CalendarService, UpdateCalendarEventArgs>(config);
}
