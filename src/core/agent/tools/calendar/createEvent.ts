import { Effect } from "effect";
import { z } from "zod";
import { CalendarServiceTag, type CalendarService } from "@/core/interfaces/calendar";
import type { ToolExecutionContext } from "@/core/types";
import type { CalendarEventAttendee } from "@/core/types/calendar";
import { defineApprovalTool, type ApprovalToolConfig, type ApprovalToolPair } from "../base-tool";
import { formatEventForDisplay } from "./utils";

/**
 * Create calendar event tools (approval + execution)
 */

type CreateCalendarEventArgs = {
  calendarId: string;
  summary: string;
  description?: string;
  location?: string;
  startDateTime?: string;
  startDate?: string;
  endDateTime?: string;
  endDate?: string;
  timeZone?: string;
  attendees?: Array<{
    email: string;
    displayName?: string;
    optional?: boolean;
  }>;
  sendNotifications: boolean;
};

const createEventParameters = z
  .object({
    calendarId: z
      .string()
      .optional()
      .default("primary")
      .describe("Calendar ID (default: 'primary')"),
    summary: z.string().min(1).describe("Event title/summary"),
    description: z.string().optional().describe("Event description"),
    location: z.string().optional().describe("Event location"),
    startDateTime: z.string().optional().describe("Start date-time (RFC3339)"),
    startDate: z.string().optional().describe("All-day start date (YYYY-MM-DD)"),
    endDateTime: z.string().optional().describe("End date-time (RFC3339)"),
    endDate: z.string().optional().describe("All-day end date (YYYY-MM-DD)"),
    timeZone: z.string().optional().describe("Timezone (e.g. 'America/Los_Angeles')"),
    attendees: z
      .array(
        z.object({
          email: z.string().email().describe("Email address"),
          displayName: z.string().optional().describe("Display name"),
          optional: z.boolean().optional().describe("Optional attendance"),
        }),
      )
      .optional()
      .describe("Attendees"),
    sendNotifications: z
      .boolean()
      .optional()
      .default(true)
      .describe("Send notifications (default: true)"),
  })
  .strict()
  .refine((data) => (data.startDateTime && data.endDateTime) || (data.startDate && data.endDate), {
    message: "Must provide either startDateTime+endDateTime OR startDate+endDate",
  });

export function createCalendarEventTools(): ApprovalToolPair<CalendarService> {
  const config: ApprovalToolConfig<CalendarService, CreateCalendarEventArgs> = {
    name: "create_calendar_event",
    description: "Create a calendar event. Supports timed and all-day events.",
    tags: ["calendar", "create"],
    parameters: createEventParameters,
    validate: (args) => {
      const params = createEventParameters.safeParse(args);
      return params.success
        ? { valid: true, value: params.data as CreateCalendarEventArgs }
        : { valid: false, errors: params.error.issues.map((i) => i.message) };
    },

    approvalMessage: (args: CreateCalendarEventArgs, _context: ToolExecutionContext) =>
      Effect.succeed(
        `📅 ${args.summary}\n` +
          `${args.description ? `📝 ${args.description}\n` : ""}` +
          `${args.location ? `📍 ${args.location}\n` : ""}` +
          `⏰ ${args.startDateTime || args.startDate} → ${args.endDateTime || args.endDate}\n` +
          `${args.attendees ? `👥 ${args.attendees.length} attendee(s)\n` : ""}`,
      ),

    approvalErrorMessage: "Calendar event creation requires user approval.",

    handler: (args: CreateCalendarEventArgs, _context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const calendarService = yield* CalendarServiceTag;

        const event = yield* calendarService.createEvent(
          args.calendarId,
          {
            summary: args.summary,
            ...(args.description && { description: args.description }),
            ...(args.location && { location: args.location }),
            start: {
              ...(args.startDateTime && { dateTime: args.startDateTime }),
              ...(args.startDate && { date: args.startDate }),
              ...(args.timeZone && { timeZone: args.timeZone }),
            },
            end: {
              ...(args.endDateTime && { dateTime: args.endDateTime }),
              ...(args.endDate && { date: args.endDate }),
              ...(args.timeZone && { timeZone: args.timeZone }),
            },
            ...(args.attendees && {
              attendees: args.attendees as CalendarEventAttendee[],
            }),
          },
          { sendNotifications: args.sendNotifications },
        );

        return { success: true, result: formatEventForDisplay(event) };
      }),
  };

  return defineApprovalTool<CalendarService, CreateCalendarEventArgs>(config);
}
