import { Effect } from "effect";
import { z } from "zod";
import { CalendarServiceTag, type CalendarService } from "@/core/interfaces/calendar";
import type { Tool } from "@/core/interfaces/tool-registry";
import { defineTool } from "../base-tool";
import { formatEventsForDisplay } from "./utils";

/**
 * Get upcoming events tool
 */

export function createGetUpcomingEventsTool(): Tool<CalendarService> {
  const parameters = z
    .object({
      calendarId: z.string().optional().default("primary"),
      count: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Max events to return"),
    })
    .strict();

  type GetUpcomingEventsArgs = z.infer<typeof parameters>;
  return defineTool<CalendarService, GetUpcomingEventsArgs>({
    name: "get_upcoming_events",
    description: "Get the next N upcoming events from now.",
    tags: ["calendar", "list", "upcoming"],
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
        const now = new Date().toISOString();
        const events = yield* calendarService.listEvents(validatedArgs.calendarId, {
          timeMin: now,
          maxResults: validatedArgs.count,
          singleEvents: true,
          orderBy: "startTime",
        });
        return { success: true, result: formatEventsForDisplay(events) };
      }),
  });
}
