import { FileSystem } from "@effect/platform";
import { Context, Effect } from "effect";

export interface ReminderRecord {
  readonly id: string;
  /** Epoch ms at which this reminder should fire. */
  readonly fireAt: number;
  readonly text: string;
  readonly createdAt: number;
  /**
   * The host scheduler's own job id for this reminder, when one was created (`at` on Linux).
   * Needed to `atrm` the job on cancel; not needed for launchd, whose plist path is derivable
   * from agentId+id alone. Left undefined for tg_/dc_-prefixed agents, which never get an OS
   * job — see `reminder-service.ts`.
   */
  readonly osSchedulerJobId?: string;
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
