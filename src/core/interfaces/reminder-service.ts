import { FileSystem } from "@effect/platform";
import { Context, Effect } from "effect";

export interface ReminderRecord {
  readonly id: string;
  /** Epoch ms at which this reminder should fire. */
  readonly fireAt: number;
  readonly text: string;
  readonly createdAt: number;
}

export type AddReminderOutcome =
  | { readonly success: true; readonly reminder: ReminderRecord }
  | { readonly success: false; readonly message: string };

export type CancelReminderOutcome = { readonly success: boolean; readonly message: string };

/**
 * Per-agent reminders the agent itself schedules via tool calls, swept and
 * delivered by whichever surface hosts the agent (e.g. the Telegram bridge).
 */
export interface ReminderService {
  readonly add: (
    agentId: string,
    when: string,
    text: string,
    timezone: string,
  ) => Effect.Effect<AddReminderOutcome, Error, FileSystem.FileSystem>;

  readonly list: (
    agentId: string,
  ) => Effect.Effect<readonly ReminderRecord[], Error, FileSystem.FileSystem>;

  readonly cancel: (
    agentId: string,
    id: string,
  ) => Effect.Effect<CancelReminderOutcome, Error, FileSystem.FileSystem>;
}

export const ReminderServiceTag = Context.GenericTag<ReminderService>("ReminderService");
