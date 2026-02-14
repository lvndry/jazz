import { Effect } from "effect";
import { z } from "zod";
import { CalendarServiceTag, type CalendarService } from "@/core/interfaces/calendar";
import type { Tool } from "@/core/interfaces/tool-registry";
import { defineTool } from "../base-tool";
import { formatCalendarsForDisplay } from "./utils";

/**
 * List calendars tool
 */

export function createListCalendarsTool(): Tool<CalendarService> {
  const parameters = z.object({}).strict();

  type ListCalendarsArgs = z.infer<typeof parameters>;
  return defineTool<CalendarService, ListCalendarsArgs>({
    name: "list_calendars",
    description: "List all accessible calendars with IDs and metadata.",
    tags: ["calendar", "list"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data as unknown as Record<string, never> } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: () =>
      Effect.gen(function* () {
        const calendarService = yield* CalendarServiceTag;
        const calendars = yield* calendarService.listCalendars();
        return { success: true, result: formatCalendarsForDisplay(calendars) };
      }),
  });
}
