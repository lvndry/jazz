/**
 * @fileoverview The chat `/waits` command: list this conversation's pending waits and queued
 * jobs, and cancel one. The list under the composer does the same in fullscreen; this is the
 * way in everywhere else.
 */

import { JobQueueServiceTag } from "@jazz/core/interfaces/job-queue-service";
import { TerminalServiceTag } from "@jazz/core/interfaces/terminal";
import { Effect, Option } from "effect";
import {
  backgroundItems,
  describeBackgroundCheck,
  describeBackgroundTiming,
  type BackgroundItem,
} from "@/cli/ui/models/background-work";
import { builtinUsage } from "./constants";
import type { CommandContext } from "./types";

/** An item by its 1-based number in `/waits list`, or by a prefix of its batch id. */
export function resolveBackgroundItem(
  items: readonly BackgroundItem[],
  handle: string,
): BackgroundItem | undefined {
  const position = Number(handle);
  if (Number.isInteger(position) && position >= 1) {
    return items[position - 1];
  }
  const matches = items.filter((item) => item.batchId.startsWith(handle));
  return matches.length === 1 ? matches[0] : undefined;
}

export function formatBackgroundItem(item: BackgroundItem, position: number, now: number): string {
  return `${String(position)}. ${item.description}\n   ${describeBackgroundCheck(item)} · ${describeBackgroundTiming(item, now)}`;
}

export function handleWaitsCommand(context: CommandContext, args: readonly string[]) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const jobQueueOption = yield* Effect.serviceOption(JobQueueServiceTag);
    if (Option.isNone(jobQueueOption)) {
      yield* terminal.warn("Background waits are not available in this session.");
      return { shouldContinue: true };
    }
    const jobQueue = jobQueueOption.value;
    const batches = yield* jobQueue
      .listActiveBatches(context.agent.id)
      .pipe(Effect.catchAll(() => Effect.succeed([])));
    const items = backgroundItems(batches, context.conversationId);
    const [subcommand, handle] = args;

    if (subcommand === undefined || subcommand.toLowerCase() === "list") {
      if (items.length === 0) {
        yield* terminal.info("Nothing is waiting in the background.");
        return { shouldContinue: true };
      }
      const now = Date.now();
      for (const [index, item] of items.entries()) {
        yield* terminal.log(formatBackgroundItem(item, index + 1, now));
      }
      return { shouldContinue: true };
    }

    if (subcommand.toLowerCase() === "cancel") {
      const chosen = handle === undefined ? undefined : resolveBackgroundItem(items, handle);
      if (chosen === undefined) {
        yield* terminal.warn("Usage: /waits cancel <number from /waits list>");
        return { shouldContinue: true };
      }
      const outcome = yield* jobQueue
        .cancelBatch(context.agent.id, chosen.batchId)
        .pipe(
          Effect.catchAll((error) => Effect.succeed({ success: false, message: error.message })),
        );
      yield* outcome.success ? terminal.success(outcome.message) : terminal.warn(outcome.message);
      return { shouldContinue: true };
    }

    yield* terminal.log(builtinUsage("waits") ?? "");
    return { shouldContinue: true };
  });
}
