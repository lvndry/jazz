import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { WakeTriggerRecord, WakeTriggerService } from "@/core/interfaces/wake-trigger-service";
import { WakeTriggerServiceTag } from "@/core/interfaces/wake-trigger-service";
import type { ToolExecutionResult } from "@/core/types/tools";
import { defineTool, makeZodValidator } from "./base-tool";

type WakeTriggerToolDeps = WakeTriggerService | FileSystem.FileSystem;

function formatFireAt(trigger: WakeTriggerRecord): string {
  return new Date(trigger.fireAt).toISOString();
}

const registerTriggerParameters = z
  .object({
    when: z
      .string()
      .min(1)
      .describe(
        'When to wake, e.g. a relative duration ("30m", "2h", "1h30m", "90s", "1d"), a 24h clock ' +
          'time ("18:00" — next occurrence of that time), "tomorrow HH:MM", a weekday and time ' +
          '("tue 20:00" — next occurrence of that weekday), or an absolute date and time ' +
          '("2026-08-25 20:00").',
      ),
    prompt: z
      .string()
      .min(1)
      .describe(
        "What you should do when you wake up — written as an instruction to your future " +
          "self, e.g. 'Check whether the deploy finished and report the result.' This is " +
          "what runs next, not a note to a person.",
      ),
    reason: z
      .string()
      .min(1)
      .describe("Brief note on why you're scheduling this, shown to the person via list_triggers."),
  })
  .strict();

type RegisterTriggerArgs = z.infer<typeof registerTriggerParameters>;

export function createRegisterTriggerTool(): Tool<WakeTriggerToolDeps> {
  return defineTool<WakeTriggerToolDeps, RegisterTriggerArgs>({
    name: "register_trigger",
    disclosure: "internal",
    summary:
      "Wake yourself up later to check back on something — monitor or watch a build, deploy, " +
      "CI run, GitHub Action, log file or repo over minutes or hours, and keep looking until " +
      "it is done.",
    description:
      "Schedule yourself to wake up later and resume this exact conversation — use this " +
      "when you need to check back on something ('check again in 20 minutes', 'come back " +
      "once the build should be done'), rather than stopping the task entirely. Unlike " +
      "add_reminder (which just delivers a note to a person), this causes you to actually " +
      "run again with the prompt you specify.\n\n" +
      "This is how you watch anything that outlasts a single background job: wake, look, and " +
      "if it is still running register another trigger. Prefer it over enqueue_batch whenever " +
      "the wait could exceed one job's cap, or is open-ended. Each cycle costs a model run, so " +
      "space the checks to match how fast the thing actually changes, and stop once you have " +
      "an answer — the cap is on triggers pending at once, not on how many times you may look.",
    parameters: registerTriggerParameters,
    riskLevel: "low-risk",
    hidden: false,
    validate: makeZodValidator(registerTriggerParameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        if (context.conversationId === undefined) {
          return {
            success: false,
            result: null,
            error: "No conversation to resume — register_trigger is unavailable in this context.",
          } satisfies ToolExecutionResult;
        }

        const wakeTriggerService = yield* WakeTriggerServiceTag;
        const timezone = typeof context.timezone === "string" ? context.timezone : "UTC";
        const outcome = yield* wakeTriggerService.add(
          context.agentId,
          context.conversationId,
          args.when,
          args.prompt,
          args.reason,
          timezone,
        );

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
            id: outcome.trigger.id,
            fireAt: formatFireAt(outcome.trigger),
            prompt: outcome.trigger.prompt,
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
      const data = result.result as { fireAt: string };
      return `Wake trigger set for ${data.fireAt}`;
    },
  });
}

const listTriggersParameters = z.object({}).strict();

type ListTriggersArgs = z.infer<typeof listTriggersParameters>;

export function createListTriggersTool(): Tool<WakeTriggerToolDeps> {
  return defineTool<WakeTriggerToolDeps, ListTriggersArgs>({
    name: "list_triggers",
    disclosure: "internal",
    description: "List this agent's pending self-scheduled wake triggers.",
    parameters: listTriggersParameters,
    riskLevel: "read-only",
    hidden: false,
    validate: makeZodValidator(listTriggersParameters),
    handler: (_args, context) =>
      Effect.gen(function* () {
        const wakeTriggerService = yield* WakeTriggerServiceTag;
        const triggers = yield* wakeTriggerService.list(context.agentId);
        const sorted = [...triggers].sort((left, right) => left.fireAt - right.fireAt);

        return {
          success: true,
          result: {
            triggers: sorted.map((trigger) => ({
              id: trigger.id,
              fireAt: formatFireAt(trigger),
              prompt: trigger.prompt,
              reason: trigger.reason,
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
      const data = result.result as { triggers: readonly unknown[] };
      return `Listed wake triggers (${data.triggers.length})`;
    },
  });
}

const cancelTriggerParameters = z
  .object({
    id: z.string().min(1).describe("The id of the wake trigger to cancel, from list_triggers."),
  })
  .strict();

type CancelTriggerArgs = z.infer<typeof cancelTriggerParameters>;

export function createCancelTriggerTool(): Tool<WakeTriggerToolDeps> {
  return defineTool<WakeTriggerToolDeps, CancelTriggerArgs>({
    name: "cancel_trigger",
    disclosure: "internal",
    description: "Cancel a pending wake trigger by id (get the id from list_triggers first).",
    parameters: cancelTriggerParameters,
    riskLevel: "low-risk",
    hidden: false,
    validate: makeZodValidator(cancelTriggerParameters),
    handler: (args, context) =>
      Effect.gen(function* () {
        const wakeTriggerService = yield* WakeTriggerServiceTag;
        const outcome = yield* wakeTriggerService.cancel(context.agentId, args.id);

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
