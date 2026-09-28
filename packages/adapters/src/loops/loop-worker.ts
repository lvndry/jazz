/**
 * Runs due loops from the daemon tick.
 *
 * Each tick settles runs claimed earlier and starts the loops that are due. A loop has at most
 * one run in flight: its claim is written before the run starts and cleared when the run's
 * outcome is folded in, so a run waiting for an approval holds the loop until it is answered.
 * A run started here settles itself when it ends; one that finished elsewhere (answered from
 * another process) or whose process died is settled from its run record on a later tick.
 */

import { randomUUID } from "node:crypto";
import { AgentRunner } from "@jazz/core/agent/agent-runner";
import {
  claimLoopRun,
  endLoopRequest,
  isLoopDue,
  loopRunCaps,
  loopRunPrompt,
  settleLoopRun,
  stopAtLimit,
  type LoopRunEnd,
} from "@jazz/core/agent/loop/loop-lifecycle";
import {
  withoutRun,
  type LoopRecord,
  type LoopRecordInput,
} from "@jazz/core/agent/loop/loop-record";
import { runToOutcome, type RunOutcome } from "@jazz/core/agent/run/park-signal";
import { resumeRun, type ResumeRunOptions } from "@jazz/core/agent/run/resume";
import { runSpend } from "@jazz/core/agent/run/run-spend";
import type { AgentResponse } from "@jazz/core/agent/types";
import { AgentConfigServiceTag } from "@jazz/core/interfaces/agent-config";
import { AgentServiceTag } from "@jazz/core/interfaces/agent-service";
import { FileSystemContextServiceTag } from "@jazz/core/interfaces/fs";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import { LoopStoreTag } from "@jazz/core/interfaces/loop-store";
import { RunStoreTag } from "@jazz/core/interfaces/run-store";
import { nextCycleBlockedBySpend } from "@jazz/core/spend/run-accounting";
import type { ChatMessage } from "@jazz/core/types/message";
import { getJazzInstanceId } from "@jazz/core/utils/instance-id";
import { currentProcessOwner } from "@jazz/core/utils/process";
import { Cause, Effect, Fiber } from "effect";
import { claimOwnerStatus, inFlight } from "@/adapters/runs/runs-in-flight";
import {
  loadConversationOrNull,
  saveRunTranscript,
  type Conversation,
} from "@jazz/adapters/history/conversation-history-service";

/** Compare-and-set a loop, logging a refused write instead of failing the tick. */
function writeLoop(loop: LoopRecord, next: LoopRecordInput, purpose: string) {
  return Effect.gen(function* () {
    const loops = yield* LoopStoreTag;
    const logger = yield* LoggerServiceTag;
    return yield* loops.compareAndSet(loop.loopId, loop.version, next).pipe(
      Effect.map((saved): LoopRecord | undefined => saved),
      Effect.catchAll((error) =>
        logger
          .warn(`Could not update loop to ${purpose}`, {
            loopId: loop.loopId,
            error: error.message,
          })
          .pipe(Effect.as(undefined)),
      ),
    );
  });
}

/** Fold the claimed run's end into the loop, reading the loop fresh so no control is lost. */
function settle(loopId: string, runId: string, end: LoopRunEnd) {
  return Effect.gen(function* () {
    const loops = yield* LoopStoreTag;
    const loop = yield* loops.get(loopId);
    if (loop?.run?.runId !== runId) {
      return;
    }
    yield* writeLoop(loop, settleLoopRun(loop, end, new Date()), "settle its run");
  });
}

function spendOf(runId: string) {
  return Effect.gen(function* () {
    const runs = yield* RunStoreTag;
    const record = yield* runs.get(runId);
    return record === undefined ? undefined : runSpend(record);
  });
}

function runLoop(loop: LoopRecord, runId: string) {
  return Effect.gen(function* () {
    const agents = yield* AgentServiceTag;
    const agent = yield* agents.getAgent(loop.agentId).pipe(Effect.either);
    if (agent._tag === "Left") {
      yield* settle(loop.loopId, runId, {
        outcome: "failed",
        text: `Its agent ${loop.agentId} no longer exists.`,
      });
      return;
    }
    const fileSystemContext = yield* FileSystemContextServiceTag;
    const placed = yield* fileSystemContext
      .setCwd({ agentId: loop.agentId, conversationId: loop.conversationId }, loop.workingDirectory)
      .pipe(Effect.either);
    if (placed._tag === "Left") {
      yield* settle(loop.loopId, runId, {
        outcome: "failed",
        text: `Its directory, ${loop.workingDirectory}, is gone or unreadable.`,
      });
      return;
    }
    const caps = loopRunCaps(loop);
    if (caps.kind === "limit") {
      yield* settle(loop.loopId, runId, {
        outcome: "failed",
        text: `Its ${caps.limit} budget was used up before the run started.`,
      });
      return;
    }
    const prior = yield* loadConversationOrNull(loop.agentId, loop.conversationId);
    const outcome = yield* runToOutcome(
      AgentRunner.run({
        agent: agent.right,
        runId,
        userInput: loopRunPrompt(loop),
        conversationId: loop.conversationId,
        conversationHistory: [...(prior?.messages ?? [])],
        ...caps.caps,
        ...(loop.approvalPolicy !== undefined ? { autoApprovePolicy: loop.approvalPolicy } : {}),
        parkWhenUnattended: true,
        startedBy: "loop",
        origin: { source: "loop", name: loop.name },
      }),
    );
    yield* finishLoopRun(loop, runId, prior, outcome);
  });
}

/**
 * Fold a run's outcome into its loop: nothing yet when it parked, its error when it failed, and
 * when it finished, its transcript saved to the loop's conversation and any `end_loop` it made.
 */
function finishLoopRun(
  loop: LoopRecord,
  runId: string,
  prior: Conversation | null,
  outcome: RunOutcome<AgentResponse>,
) {
  return Effect.gen(function* () {
    const logger = yield* LoggerServiceTag;
    if (outcome.kind === "parked") {
      return;
    }
    if (outcome.kind === "failed") {
      yield* settle(loop.loopId, runId, {
        outcome: "failed",
        text: outcome.error,
        ...(yield* spendOrNothing(runId)),
      });
      return;
    }
    const messages: readonly ChatMessage[] = outcome.response.messages ?? [];
    yield* saveRunTranscript({
      agentId: loop.agentId,
      conversationId: loop.conversationId,
      prior,
      fallbackTitle: `loop: ${loop.name}`,
      messages,
    }).pipe(
      Effect.catchAll((error) =>
        logger.warn("Could not save the loop transcript", {
          loopId: loop.loopId,
          error: error.message,
        }),
      ),
    );
    const endRequested = endLoopRequest(messages);
    yield* settle(loop.loopId, runId, {
      outcome: "completed",
      text: outcome.response.content,
      ...(yield* spendOrNothing(runId)),
      ...(endRequested !== undefined ? { endRequested } : {}),
    });
  });
}

function spendOrNothing(runId: string) {
  return spendOf(runId).pipe(Effect.map((spend) => (spend === undefined ? {} : { spend })));
}

/** Settle a claim whose run is no longer being executed by the process that took it. */
function settleClaim(loop: LoopRecord) {
  return Effect.gen(function* () {
    const claim = loop.run;
    if (claim === undefined) {
      return;
    }
    const runs = yield* RunStoreTag;
    const run = yield* runs.get(claim.runId);
    const runOwner = run?.state.kind === "working" ? run.state.owner : undefined;
    const status = claimOwnerStatus(runOwner ?? claim.owner, claim.runId);
    if (status === "alive") {
      return;
    }
    if (status === "unverifiable") {
      yield* writeLoop(
        loop,
        {
          ...withoutRun(loop),
          state: {
            kind: "failed",
            reason:
              "Jazz cannot tell whether the process running its last run is still working (it ran on another host, or its process cannot be inspected); check for side effects before resuming.",
          },
        },
        "stop a loop whose run cannot be verified",
      );
      return;
    }
    if (run === undefined || run.state.kind === "submitted") {
      yield* settle(loop.loopId, claim.runId, { outcome: "missing" });
      return;
    }
    const spend = runSpend(run);
    switch (run.state.kind) {
      case "input-required":
        if (claim.stopAfter !== undefined) {
          yield* dropParkedRun(loop, run.runId);
        }
        return;
      case "working":
        yield* runs
          .transition(run.runId, {
            kind: "failed",
            cause: "interrupted",
            error: "the process running it stopped",
          })
          .pipe(Effect.catchAll(() => Effect.void));
        yield* settle(loop.loopId, claim.runId, { outcome: "interrupted", spend });
        return;
      case "completed":
        yield* settle(loop.loopId, claim.runId, {
          outcome: "completed",
          spend,
          text: run.state.content,
        });
        return;
      case "failed":
        yield* settle(loop.loopId, claim.runId, {
          outcome: run.state.cause === "interrupted" ? "interrupted" : "failed",
          spend,
          text: run.state.error,
        });
        return;
      case "canceled":
        yield* settle(loop.loopId, claim.runId, { outcome: "canceled", spend });
        return;
    }
  });
}

/** Cancel a loop's parked run and settle the loop without it, counting what it spent. */
function dropParkedRun(loop: LoopRecord, runId: string) {
  return Effect.gen(function* () {
    const runs = yield* RunStoreTag;
    yield* runs
      .transition(runId, { kind: "canceled", at: "parked" })
      .pipe(Effect.catchAll(() => Effect.void));
    yield* settle(loop.loopId, runId, { outcome: "canceled", ...(yield* spendOrNothing(runId)) });
  });
}

/**
 * Answer a parked run that belongs to a loop and fold the result into the loop, under what the
 * loop's budget has left. Undefined when no loop owns the run; `resumeOwnedRun` is what answer
 * surfaces call.
 */
export function resumeLoopRun(options: ResumeRunOptions) {
  return Effect.gen(function* () {
    const loops = yield* LoopStoreTag;
    const runs = yield* RunStoreTag;
    const active = yield* loops.list({ ownerInstanceId: getJazzInstanceId(), states: ["active"] });
    const loop = active.find((candidate) => candidate.run?.runId === options.runId);
    if (loop === undefined) {
      return undefined;
    }
    if (loop.run?.stopAfter !== undefined) {
      return {
        kind: "blocked",
        reason: `Loop ${loop.name} was asked to ${loop.run.stopAfter}; its waiting run is dropped instead of answered.`,
      } as const;
    }
    const run = yield* runs.get(options.runId);
    const caps = loopRunCaps(loop, run === undefined ? undefined : runSpend(run));
    if (caps.kind === "limit") {
      yield* dropParkedRun(loop, options.runId);
      return {
        kind: "blocked",
        reason: `Loop ${loop.name} reached its ${caps.limit} budget while waiting, so its run was dropped; \`jazz loop resume ${loop.name}\` extends the budget.`,
      } as const;
    }
    const prior = yield* loadConversationOrNull(loop.agentId, loop.conversationId);
    const outcome = yield* inFlight(
      options.runId,
      Effect.gen(function* () {
        const settled = yield* runToOutcome(
          resumeRun({ ...options, ...caps.caps, startedBy: "loop" }),
        );
        yield* finishLoopRun(loop, options.runId, prior, settled);
        return settled;
      }),
    );
    return { kind: "resumed", owner: { loopId: loop.loopId }, outcome } as const;
  });
}

/**
 * One daemon tick for loops: settle claims whose runs have moved on, then start every loop that
 * is due. Started runs run on their own fibers, returned for callers that want to wait on them.
 * With `startNew` false (the daemon is paused) runs in flight are still settled, but none starts.
 */
export function runDueLoops(options: { readonly startNew?: boolean } = {}) {
  return Effect.gen(function* () {
    const loops = yield* LoopStoreTag;
    const logger = yield* LoggerServiceTag;
    const started: Fiber.RuntimeFiber<void, never>[] = [];
    const candidates = yield* loops.list({
      ownerInstanceId: getJazzInstanceId(),
      states: ["active"],
    });
    const now = new Date();
    for (const loop of candidates) {
      if (loop.run !== undefined) {
        yield* settleClaim(loop);
        continue;
      }
      if (!isLoopDue(loop, now) || options.startNew === false) {
        continue;
      }
      const stopped = stopAtLimit(loop);
      if (stopped !== undefined) {
        yield* writeLoop(loop, stopped, "stop it at a limit it reached");
        continue;
      }
      // A spend cap holds the run back without stopping the loop: it runs again on the
      // first tick after the cap clears, and the notify targets hear about it once.
      const spendBlock = yield* nextCycleBlockedBySpend({
        agentId: loop.agentId,
        origin: { source: "loop", name: loop.name },
        appConfig: yield* (yield* AgentConfigServiceTag).appConfig,
      });
      if (spendBlock !== undefined) {
        continue;
      }
      const runId = randomUUID();
      const claimed = yield* writeLoop(
        loop,
        claimLoopRun(loop, runId, currentProcessOwner(), now),
        "claim a run",
      );
      if (claimed === undefined) {
        continue;
      }
      started.push(
        yield* inFlight(runId, runLoop(claimed, runId)).pipe(
          Effect.catchAllCause((cause) =>
            logger.warn("Loop run failed to settle", {
              loopId: loop.loopId,
              error: Cause.pretty(cause),
            }),
          ),
          Effect.forkDaemon,
        ),
      );
    }
    return started;
  });
}
