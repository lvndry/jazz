import { Effect } from "effect";
import { z } from "zod";
import { CalendarServiceTag, type CalendarService } from "@/core/interfaces/calendar";
import type { ToolExecutionContext } from "@/core/types";
import { defineApprovalTool, type ApprovalToolConfig, type ApprovalToolPair } from "../base-tool";
import { formatEventForDisplay } from "./utils";

/**
 * Quick add calendar event tools (approval + execution)
 */

type QuickAddCalendarEventArgs = {
  calendarId: string;
  text: string;
  sendNotifications: boolean;
};

const quickAddParameters = z
  .object({
    calendarId: z.string().optional().default("primary"),
    text: z
      .string()
      .min(1)
      .describe(
        "Natural language description of the event (e.g., 'Meeting with John tomorrow at 3pm')",
      ),
    sendNotifications: z.boolean().optional().default(true),
  })
  .strict();

export function createQuickAddCalendarEventTools(): ApprovalToolPair<CalendarService> {
  const config: ApprovalToolConfig<CalendarService, QuickAddCalendarEventArgs> = {
    name: "quick_add_calendar_event",
    description:
      "Create a calendar event from natural language text using Google's quick add feature. Automatically parses date, time, and title from text like 'Lunch with Sarah tomorrow at noon' or 'Team meeting Friday 2pm-3pm'. Convenient for simple events without detailed parameters.",
    tags: ["calendar", "create", "quick"],
    parameters: quickAddParameters,
    validate: (args) => {
      const params = quickAddParameters.safeParse(args);
      return params.success
        ? { valid: true, value: params.data as QuickAddCalendarEventArgs }
        : { valid: false, errors: params.error.issues.map((i) => i.message) };
    },

    approvalMessage: (args: QuickAddCalendarEventArgs, _context: ToolExecutionContext) =>
      Effect.succeed(`Creating event from: "${args.text}"`),

    approvalErrorMessage: "Calendar quick add requires user approval.",

    handler: (args: QuickAddCalendarEventArgs, _context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const calendarService = yield* CalendarServiceTag;
        const event = yield* calendarService.quickAddEvent(
          args.calendarId,
          args.text,
          args.sendNotifications,
        );
        return { success: true, result: formatEventForDisplay(event) };
      }),
  };

  return defineApprovalTool<CalendarService, QuickAddCalendarEventArgs>(config);
}
