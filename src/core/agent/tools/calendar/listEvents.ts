import { Effect } from "effect";
import { z } from "zod";
import { CalendarServiceTag, type CalendarService } from "@/core/interfaces/calendar";
import type { Tool } from "@/core/interfaces/tool-registry";
import { defineTool } from "../base-tool";
import { formatEventsForDisplay } from "./utils";

/**
 * List calendar events tool
 */

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
