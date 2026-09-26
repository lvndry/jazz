import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import type { ReminderRecord, ReminderService } from "@/core/interfaces/reminder-service";
import { ReminderServiceTag } from "@/core/interfaces/reminder-service";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { ToolExecutionResult } from "@/core/types/tools";
import { defineTool, makeZodValidator } from "./base-tool";

type ReminderToolDeps = ReminderService | FileSystem.FileSystem;

const WHEN_DESCRIPTION =
  'Relative ("30m", "1h30m", "1d"), 24h clock ("18:00"), "tomorrow HH:MM", weekday ' +
  '("tue 20:00") or absolute ("2026-08-25 20:00"). For an event on a known date, use the ' +
  "weekday or absolute form so it cannot land after the event.";

function formatFireAt(reminder: ReminderRecord): string {
  return new Date(reminder.fireAt).toISOString();
}

const addReminderParameters = z
  .object({
    when: z.string().min(1).describe(WHEN_DESCRIPTION),
    text: z.string().min(1).describe("What to remind about, kept concise."),
  })
  .strict();

type AddReminderArgs = z.infer<typeof addReminderParameters>;

export function createAddReminderTool(): Tool<ReminderToolDeps> {
  return defineTool<ReminderToolDeps, AddReminderArgs>({
    name: "add_reminder",
    disclosure: "public",
    summary:
      "Schedule a reminder that will be delivered back to this person later: remind, ping or notify.",
    description:
      "Schedule a reminder delivered back to this person later, when they ask to be reminded, " +
      "pinged or notified. This is the only way to fire a future notification. It pings a human; " +
      "it is not a todo or work state.",
    parameters: addReminderParameters,
    riskLevel: "low-risk",
    hidden: false,
    validate: makeZodValidator(addReminderParameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        const reminderService = yield* ReminderServiceTag;
        const timezone = typeof context.timezone === "string" ? context.timezone : "UTC";
        const outcome = yield* reminderService.add(context.agentId, args.when, args.text, timezone);

        if (!outcome.success) {
          return {
            success: false,
            result: null,
            error: outcome.message,
          } satisfies ToolExecutionResult;
        }

        return {
          success: true,
          result: {
            id: outcome.reminder.id,
            fireAt: formatFireAt(outcome.reminder),
            text: outcome.reminder.text,
          },
        } satisfies ToolExecutionResult;
      }).pipe(
        Effect.catchAll((error) =>
          Effect.succeed({
            success: false,
            result: null,
            error: error instanceof Error ? error.message : String(error),
          } satisfies ToolExecutionResult),
        ),
      ),
    createSummary: (result) => {
      if (!result.success) return undefined;
      const data = result.result as { fireAt: string; text: string };
      return `Reminder set for ${data.fireAt}`;
    },
  });
}

const listRemindersParameters = z.object({}).strict();

type ListRemindersArgs = z.infer<typeof listRemindersParameters>;

export function createListRemindersTool(): Tool<ReminderToolDeps> {
  return defineTool<ReminderToolDeps, ListRemindersArgs>({
    name: "list_reminders",
    disclosure: "private",
    description: "List this person's pending reminders, including their id, fire time, and text.",
    parameters: listRemindersParameters,
    riskLevel: "read-only",
    hidden: false,
    validate: makeZodValidator(listRemindersParameters),
    handler: (_args, context) =>
      Effect.gen(function* () {
        const reminderService = yield* ReminderServiceTag;
        const reminders = yield* reminderService.list(context.agentId);
        const sorted = [...reminders].sort((left, right) => left.fireAt - right.fireAt);

        return {
          success: true,
          result: {
            reminders: sorted.map((reminder) => ({
              id: reminder.id,
              fireAt: formatFireAt(reminder),
              text: reminder.text,
            })),
          },
        } satisfies ToolExecutionResult;
      }).pipe(
        Effect.catchAll((error) =>
          Effect.succeed({
            success: false,
            result: null,
            error: error instanceof Error ? error.message : String(error),
          } satisfies ToolExecutionResult),
        ),
      ),
    createSummary: (result) => {
      if (!result.success) return undefined;
      const data = result.result as { reminders: readonly unknown[] };
      return `Listed reminders (${data.reminders.length})`;
    },
  });
}

const cancelReminderParameters = z
  .object({
    id: z.string().min(1).describe("Reminder id from list_reminders."),
  })
  .strict();

type CancelReminderArgs = z.infer<typeof cancelReminderParameters>;

export function createCancelReminderTool(): Tool<ReminderToolDeps> {
  return defineTool<ReminderToolDeps, CancelReminderArgs>({
    name: "cancel_reminder",
    disclosure: "private",
    summary: "Cancel a pending reminder by id (get the id from list_reminders first).",
    description: "Cancel a pending reminder.",
    parameters: cancelReminderParameters,
    riskLevel: "low-risk",
    hidden: false,
    validate: makeZodValidator(cancelReminderParameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        const reminderService = yield* ReminderServiceTag;
        const outcome = yield* reminderService.cancel(context.agentId, args.id);

        return {
          success: outcome.success,
          result: outcome.success ? { message: outcome.message } : null,
          ...(outcome.success ? {} : { error: outcome.message }),
        } satisfies ToolExecutionResult;
      }).pipe(
        Effect.catchAll((error) =>
          Effect.succeed({
            success: false,
            result: null,
            error: error instanceof Error ? error.message : String(error),
          } satisfies ToolExecutionResult),
        ),
      ),
    createSummary: (result) => {
      if (!result.success) return undefined;
      const data = result.result as { message: string };
      return data.message;
    },
  });
}
