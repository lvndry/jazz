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
  'When to fire, e.g. a relative duration ("30m", "2h", "1h30m", "90s", "1d"), a 24h clock ' +
  'time ("18:00" — next occurrence of that time), or "tomorrow HH:MM".';

function formatFireAt(reminder: ReminderRecord): string {
  return new Date(reminder.fireAt).toISOString();
}

const addReminderParameters = z
  .object({
    when: z.string().min(1).describe(WHEN_DESCRIPTION),
    text: z.string().min(1).describe("What to remind about — kept concise."),
  })
  .strict();

type AddReminderArgs = z.infer<typeof addReminderParameters>;

export function createAddReminderTool(): Tool<ReminderToolDeps> {
  return defineTool<ReminderToolDeps, AddReminderArgs>({
    name: "add_reminder",
    description:
      "Schedule a reminder that will be delivered back to this person later. " +
      `${WHEN_DESCRIPTION} Use this whenever someone asks to be reminded, pinged, or ` +
      "notified about something at a future time — do not try to fire notifications any " +
      "other way. This is an out-of-band ping to a human (chat surfaces), not a todo and not task_state.",
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
    id: z.string().min(1).describe("The id of the reminder to cancel, from list_reminders."),
  })
  .strict();

type CancelReminderArgs = z.infer<typeof cancelReminderParameters>;

export function createCancelReminderTool(): Tool<ReminderToolDeps> {
  return defineTool<ReminderToolDeps, CancelReminderArgs>({
    name: "cancel_reminder",
    description: "Cancel a pending reminder by id (get the id from list_reminders first).",
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
