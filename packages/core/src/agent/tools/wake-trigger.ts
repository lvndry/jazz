import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import type { Tool } from "@/core/interfaces/tool-registry";
import type { WakeTriggerRecord, WakeTriggerService } from "@/core/interfaces/wake-trigger-service";
import { WakeTriggerServiceTag } from "@/core/interfaces/wake-trigger-service";
import type { ToolExecutionResult } from "@/core/types/tools";
import { toError } from "@/core/utils/errors";
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
        'Relative ("30m", "1h30m", "1d"), 24h clock ("18:00"), "tomorrow HH:MM", weekday ' +
          '("tue 20:00") or absolute ("2026-08-25 20:00").',
      ),
    prompt: z
      .string()
      .min(1)
      .describe(
        "Instruction to your future self, e.g. 'Check whether the deploy finished and report.'",
      ),
    reason: z
      .string()
      .min(1)
      .describe("Why you're scheduling this; shown to the person in list_triggers."),
  })
  .strict();

type RegisterTriggerArgs = z.infer<typeof registerTriggerParameters>;

export function createRegisterTriggerTool(): Tool<WakeTriggerToolDeps> {
  return defineTool<WakeTriggerToolDeps, RegisterTriggerArgs>({
    name: "register_trigger",
    disclosure: "internal",
    summary:
      "Wake yourself up later to check back on anything unfinished — monitor, watch or poll it " +
      "over minutes, hours or days until it is done: a build, deploy, CI run or GitHub Action, a " +
      "log file, a price or restock, tickets going on sale, a package arriving, a reply, a site " +
      "coming back up.",
    description:
      "Wake yourself later and resume this conversation with your prompt, to check back on something. Use it over enqueue_batch when a wait could exceed one job's cap or is open-ended: wake, look, and register another trigger if it is still running. Space wakes to how fast the thing changes and stop once you have the answer.",
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
            error: toError(error).message,
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
            error: toError(error).message,
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
    id: z.string().min(1).describe("Wake trigger id from list_triggers."),
  })
  .strict();

type CancelTriggerArgs = z.infer<typeof cancelTriggerParameters>;

export function createCancelTriggerTool(): Tool<WakeTriggerToolDeps> {
  return defineTool<WakeTriggerToolDeps, CancelTriggerArgs>({
    name: "cancel_trigger",
    disclosure: "internal",
    summary: "Cancel a pending wake trigger by id (get the id from list_triggers first).",
    description: "Cancel a pending wake trigger.",
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
            error: toError(error).message,
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
