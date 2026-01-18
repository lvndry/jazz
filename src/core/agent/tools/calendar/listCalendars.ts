import { Effect } from "effect";
import { z } from "zod";
import { CalendarServiceTag, type CalendarService } from "../../../interfaces/calendar";
import type { Tool } from "../../../interfaces/tool-registry";
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
    description:
      "List all calendars accessible to the user including the primary calendar and any subscribed calendars. Returns calendar details including ID, name, timezone, and access permissions. Use to discover available calendars before accessing events.",
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
