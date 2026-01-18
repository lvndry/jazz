import { Effect } from "effect";
import { z } from "zod";
import { CalendarServiceTag, type CalendarService } from "../../../interfaces/calendar";
import type { Tool } from "../../../interfaces/tool-registry";
import {
  defineTool,
  formatApprovalRequiredDescription,
  formatExecutionToolDescription,
} from "../base-tool";
import { formatEventForDisplay } from "./utils";

/**
 * Delete calendar event tool
 */

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
    description: formatApprovalRequiredDescription(
      "Permanently delete a calendar event. This action cannot be undone. Use to remove cancelled or incorrect events from the calendar. This tool requests user approval and does NOT perform the deletion directly. After the user confirms, you MUST call execute_delete_calendar_event with the exact arguments provided in the approval response.",
    ),
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
    description: formatExecutionToolDescription(
      "Performs the actual calendar event deletion after user approval of delete_calendar_event. Permanently deletes an event from Google Calendar. This tool should only be called after delete_calendar_event receives user approval.",
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
        yield* calendarService.deleteEvent(
          validatedArgs.calendarId,
          validatedArgs.eventId,
          validatedArgs.sendNotifications,
        );
        return { success: true, result: `Event ${validatedArgs.eventId} deleted successfully` };
      }),
  });
}
