import { FileSystem } from "@effect/platform";
import { Context, Effect } from "effect";

export interface WakeTriggerRecord {
  readonly id: string;
  /** Epoch ms at which this trigger should fire. */
  readonly fireAt: number;
  /** Conversation to resume when it fires — this is what makes it a wake-up, not a reminder. */
  readonly conversationId: string;
  /** What to run when it fires, fed to `AgentRunner.run` as the next turn's input. */
  readonly prompt: string;
  /** Why the agent registered this, for a human reading `list_triggers` — not sent to the model. */
  readonly reason: string;
  readonly createdAt: number;
  /**
   * The host scheduler's own job id for this trigger, when one was created (`at` on Linux).
   * Needed to `atrm` the job on cancel; not needed for launchd, whose plist path is derivable
   * from agentId+id alone.
   */
  readonly osSchedulerJobId?: string;
}

export type AddWakeTriggerOutcome =
  | { readonly success: true; readonly trigger: WakeTriggerRecord }
  | { readonly success: false; readonly message: string };

export type CancelWakeTriggerOutcome = { readonly success: boolean; readonly message: string };

/**
 * Per-agent wake-ups the agent schedules for *itself*, to resume its own conversation later —
 * distinct from {@link ReminderService}, which delivers a note to a person and never re-enters
 * the agent loop. Swept and fired by whatever process hosts the agent unattended (the daemon).
 */
export interface WakeTriggerService {
  readonly add: (
    agentId: string,
    conversationId: string,
    when: string,
    prompt: string,
    reason: string,
    timezone: string,
  ) => Effect.Effect<AddWakeTriggerOutcome, Error, FileSystem.FileSystem>;

  readonly list: (
    agentId: string,
  ) => Effect.Effect<readonly WakeTriggerRecord[], Error, FileSystem.FileSystem>;

  readonly cancel: (
    agentId: string,
    id: string,
  ) => Effect.Effect<CancelWakeTriggerOutcome, Error, FileSystem.FileSystem>;
}

export const WakeTriggerServiceTag = Context.GenericTag<WakeTriggerService>("WakeTriggerService");
