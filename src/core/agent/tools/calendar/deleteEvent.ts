import { Effect } from "effect";
import { z } from "zod";
import { CalendarServiceTag, type CalendarService } from "@/core/interfaces/calendar";
import type { ToolExecutionContext } from "@/core/types";
import { defineApprovalTool, type ApprovalToolConfig, type ApprovalToolPair } from "../base-tool";
import { formatEventForDisplay } from "./utils";

/**
 * Delete calendar event tools (approval + execution)
 */

type DeleteCalendarEventArgs = {
  calendarId: string;
  eventId: string;
  sendNotifications: boolean;
};

const deleteEventParameters = z
  .object({
    calendarId: z.string().optional().default("primary"),
    eventId: z.string().min(1).describe("ID of the event to delete"),
    sendNotifications: z.boolean().optional().default(true),
  })
  .strict();

export function createDeleteCalendarEventTools(): ApprovalToolPair<CalendarService> {
  const config: ApprovalToolConfig<CalendarService, DeleteCalendarEventArgs> = {
    name: "delete_calendar_event",
    description:
      "Permanently delete a calendar event. This action cannot be undone. Use to remove cancelled or incorrect events from the calendar.",
    tags: ["calendar", "delete"],
    parameters: deleteEventParameters,
    validate: (args) => {
      const params = deleteEventParameters.safeParse(args);
      return params.success
        ? { valid: true, value: params.data as DeleteCalendarEventArgs }
        : { valid: false, errors: params.error.issues.map((i) => i.message) };
    },

    approvalMessage: (args: DeleteCalendarEventArgs, _context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const calendarService = yield* CalendarServiceTag;
        try {
          const event = yield* calendarService.getEvent(args.calendarId || "primary", args.eventId);
          return (
            formatEventForDisplay(event) + `\n\n⚠️  This action cannot be undone!`
          );
        } catch {
          return `Deleting event ${args.eventId}. This cannot be undone!`;
        }
      }),

    approvalErrorMessage: "Calendar event deletion requires user approval.",

    handler: (args: DeleteCalendarEventArgs, _context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const calendarService = yield* CalendarServiceTag;
        yield* calendarService.deleteEvent(
          args.calendarId,
          args.eventId,
          args.sendNotifications,
        );
        return { success: true, result: `Event ${args.eventId} deleted successfully` };
      }),
  };

  return defineApprovalTool<CalendarService, DeleteCalendarEventArgs>(config);
}
