import { Effect } from "effect";
import { z } from "zod";
import { CalendarServiceTag, type CalendarService } from "@/core/interfaces/calendar";
import type { Tool } from "@/core/interfaces/tool-registry";
import {
  defineTool,
  formatApprovalRequiredDescription,
  formatExecutionToolDescription,
} from "../base-tool";
import { formatEventForDisplay } from "./utils";

/**
 * Quick add calendar event tool (natural language)
 */

export function createQuickAddCalendarEventTool(): Tool<CalendarService> {
  const parameters = z
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

  type QuickAddCalendarEventArgs = z.infer<typeof parameters>;
  return defineTool<CalendarService, QuickAddCalendarEventArgs>({
    name: "quick_add_calendar_event",
    description: formatApprovalRequiredDescription(
      "Create a calendar event from natural language text using Google's quick add feature. Automatically parses date, time, and title from text like 'Lunch with Sarah tomorrow at noon' or 'Team meeting Friday 2pm-3pm'. Convenient for simple events without detailed parameters. This tool requests user approval and does NOT perform the event creation directly. After the user confirms, you MUST call execute_quick_add_calendar_event with the exact arguments provided in the approval response.",
    ),
    tags: ["calendar", "create", "quick"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    approval: {
      message: (args) =>
        Effect.succeed(
          `About to create calendar event from text:\\n\\n"${args.text}"\\n\\nIf the user confirms, call execute_quick_add_calendar_event with the same arguments.`,
        ),
      execute: {
        toolName: "execute_quick_add_calendar_event",
        buildArgs: (args) => args,
      },
    },
    handler: (validatedArgs) =>
      Effect.gen(function* () {
        const calendarService = yield* CalendarServiceTag;
        const event = yield* calendarService.quickAddEvent(
          validatedArgs.calendarId,
          validatedArgs.text,
          validatedArgs.sendNotifications,
        );
        return { success: true, result: formatEventForDisplay(event) };
      }),
  });
}

export function createExecuteQuickAddCalendarEventTool(): Tool<CalendarService> {
  const parameters = z
    .object({
      calendarId: z.string().optional().default("primary"),
      text: z.string().min(1),
      sendNotifications: z.boolean().optional().default(true),
    })
    .strict();

  type ExecuteQuickAddCalendarEventArgs = z.infer<typeof parameters>;
  return defineTool<CalendarService, ExecuteQuickAddCalendarEventArgs>({
    name: "execute_quick_add_calendar_event",
    description: formatExecutionToolDescription(
      "Performs the actual calendar event creation from natural language after user approval of quick_add_calendar_event. Creates an event using Google's quick add feature. This tool should only be called after quick_add_calendar_event receives user approval.",
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
        const event = yield* calendarService.quickAddEvent(
          validatedArgs.calendarId,
          validatedArgs.text,
          validatedArgs.sendNotifications,
        );
        return { success: true, result: formatEventForDisplay(event) };
      }),
  });
}
