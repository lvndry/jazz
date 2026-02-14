import { Effect } from "effect";
import { z } from "zod";
import { CalendarServiceTag, type CalendarService } from "@/core/interfaces/calendar";
import type { Tool } from "@/core/interfaces/tool-registry";
import { defineTool } from "../base-tool";
import { formatEventsForDisplay } from "./utils";

/**
 * Search calendar events tool
 */

export function createSearchCalendarEventsTool(): Tool<CalendarService> {
  const parameters = z
    .object({
      query: z.string().min(1).describe("Search query"),
      maxResults: z.number().int().min(1).max(100).optional().describe("Max events"),
      timeMin: z.string().optional().describe("Start time (RFC3339)"),
      timeMax: z.string().optional().describe("End time (RFC3339)"),
    })
    .strict();

  type SearchCalendarEventsArgs = z.infer<typeof parameters>;
  return defineTool<CalendarService, SearchCalendarEventsArgs>({
    name: "search_calendar_events",
    description: "Search events by text across titles, descriptions, and locations.",
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
