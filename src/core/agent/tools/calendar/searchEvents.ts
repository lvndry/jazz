import { Effect } from "effect";
import { z } from "zod";
import { CalendarServiceTag, type CalendarService } from "../../../interfaces/calendar";
import type { Tool } from "../../../interfaces/tool-registry";
import { defineTool } from "../base-tool";
import { formatEventsForDisplay } from "./utils";

/**
 * Search calendar events tool
 */

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
