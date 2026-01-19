import { Effect } from "effect";
import { z } from "zod";
import { CalendarServiceTag, type CalendarService } from "@/core/interfaces/calendar";
import type { Tool } from "@/core/interfaces/tool-registry";
import { defineTool } from "../base-tool";
import { formatEventForDisplay } from "./utils";

/**
 * Get calendar event tool
 */

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
