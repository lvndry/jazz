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
        .describe("Calendar ID (default: 'primary')"),
      maxResults: z.number().int().min(1).max(100).optional().describe("Max events"),
      timeMin: z.string().optional().describe("Start of time range (RFC3339)"),
      timeMax: z.string().optional().describe("End of time range (RFC3339)"),
      query: z.string().optional().describe("Text search query"),
    })
    .strict();

  type ListCalendarEventsArgs = z.infer<typeof parameters>;
  return defineTool<CalendarService, ListCalendarEventsArgs>({
    name: "list_calendar_events",
    description: "List events from a calendar with optional time range and search.",
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
