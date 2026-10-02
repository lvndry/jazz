/**
 * @fileoverview Records a run's lifecycle around the effect that performs it.
 *
 * Kept apart from the runner because the runner is already the busiest file in the agent
 * core, and because the recording is genuinely optional: no `RunStore` in the layer means
 * every function here is a pass-through. That is the terminal's configuration — it holds
 * one process open for the whole run and has nobody to answer a question from outside.
 *
 * Alongside the store, the recorder keeps the shared occupancy file fresh: a heartbeat fiber
 * writes this run's entry every few seconds for the run's lifetime, and one final entry goes
 * out on every exit path. Other jazz processes on the machine read that file to answer
 * "is someone working in this directory right now" — a question the run store cannot answer
 * across terminals, because each terminal's store is its own.
 */

import { Duration, Effect, Fiber, Option } from "effect";
import { OccupancyServiceTag } from "@/core/interfaces/occupancy";
import { RunStoreTag } from "@/core/interfaces/run-store";
import { GenerationInterruptedError } from "@/core/types/errors";
import type { OccupancyRunState } from "@/core/types/occupancy";
import type { AutoApprovePolicy } from "@/core/types/tools";
import { toError } from "@/core/utils/errors";
import { currentProcessOwner } from "@/core/utils/process";
import type { AgentResponse } from "../types";
import { RunParkRequested, isRunParkRequested } from "./park-signal";
import {
  DEFAULT_PARK_TTL_MS,
  createRunRecord,
  type RunRecord,
  type RunRecordBoundary,
} from "./run-record";
import type { RunState } from "./run-state";
import type { ToolActivityTracker } from "./tool-activity";

export interface RunRecordingInput {
  readonly runId: string;
  readonly agentId: string;
  readonly conversationId: string;
  readonly userInput: string;
  /** Sub-agent runs are steps inside their parent's run, not runs of their own. */
  readonly internal: boolean;
  readonly parkTtlMs?: number;
  /** Reads the run's spend so far. Called at every terminal or parked transition. */
  readonly costSoFarUSD?: () => number | undefined;
  /** Reads prompt plus completion tokens so a goal can reconcile a cycle after restart. */
  readonly totalTokensSoFar?: () => number;
  readonly approvalPolicy?: AutoApprovePolicy;
  readonly autoApprovedTools?: readonly string[];
  readonly maxIterations?: number;
  readonly maxSubagentIterations?: number;
  readonly workingDirectory?: string;
  /** The agent's display name, for occupancy entries a person reads. */
  readonly agentName?: string;
  /** Fed by the tool executor; the heartbeat folds it into occupancy entries. */
  readonly toolActivity?: ToolActivityTracker | undefined;
  readonly boundary?: RunRecordBoundary;
}

/** How often the occupancy heartbeat writes. */
export const OCCUPANCY_HEARTBEAT_MS = 30_000;

/**
 * How long after the last write an entry may go before a reader treats its owner as gone.
 * Three intervals, not one: a single skipped tick (GC pause, a slow disk lock) must not make
 * a live agent vanish from a collision check.
 */
export const OCCUPANCY_FRESH_WINDOW_MS = 3 * OCCUPANCY_HEARTBEAT_MS;

/** A mutating call within this window makes an occupant "writing"; older means "wrote, idle". */
export const OCCUPANCY_WRITING_WINDOW_MS = 2 * 60_000;

/** The run's prompt, shortened: a title for the report, not a transcript. */
export const OCCUPANCY_PROMPT_EXCERPT_CHARS = 200;

function parkedState(signal: RunParkRequested, expiresAt: string): RunState {
  return {
    kind: "input-required",
    pending: signal.pending,
    snapshot: {
      messages: signal.messages ?? [],
      iteration: signal.iteration ?? 0,
      ...(signal.pendingTurnAnswers !== undefined
        ? { pendingTurnAnswers: signal.pendingTurnAnswers }
        : {}),
    },
    expiresAt,
  };
}

function completedState(response: AgentResponse): RunState {
  return {
    kind: "completed",
    content: response.content,
    ...(response.artifacts !== undefined && response.artifacts.length > 0
      ? { artifacts: response.artifacts }
      : {}),
  };
}

function failureState(error: unknown): RunState {
  if (error instanceof GenerationInterruptedError) {
    return { kind: "canceled", at: "working" };
  }
  const message = toError(error).message;
  return {
    kind: "failed",
    cause: message.toLowerCase().includes("timeout") ? "timeout" : "error",
    error: message,
  };
}

/**
 * Wrap a run so its lifecycle reaches the store.
 *
 * A store write must never be the reason a run fails, so every transition is best-effort:
 * losing the record of a completed run is a gap in an audit trail, while failing the run
 * over it would throw away work that already succeeded. The one place that is not true is
 * parking, where the record *is* the run — so a park that cannot be persisted is
 * converted back into an ordinary failure rather than reported as resumable.
 *
 * The occupancy heartbeat follows the same rule end to end: a heartbeat that cannot land is
 * a stale report, never a failed run.
 */
export function withRunRecording<E, R>(
  input: RunRecordingInput,
  effect: Effect.Effect<AgentResponse, E, R>,
): Effect.Effect<AgentResponse, E | Error, R> {
  return Effect.gen(function* () {
    const storeOption = yield* Effect.serviceOption(RunStoreTag);
    if (input.internal || Option.isNone(storeOption)) {
      return yield* effect;
    }
    const store = storeOption.value;
    const activeStartedAt = Date.now();

    // --- Occupancy heartbeat ---------------------------------------------------------
    //
    // The run store above is process-private; the occupancy file is the machine's. Every
    // few seconds this process says "agent X is in directory Y, last touched Z with tool
    // T"; readers on other terminals judge presence by heartbeat freshness and a live
    // pid, so a finished or crashed run stops being present within a minute.
    //
    // Absent service means nobody can be told, so the whole block is skipped rather than
    // demanding a service the layer does not provide.
    const occupancyOption = yield* Effect.serviceOption(OccupancyServiceTag);
    const occupancyService = Option.isSome(occupancyOption) ? occupancyOption.value : undefined;

    const heartbeatState: { state: OccupancyRunState } = { state: "working" };

    const writeOccupancy = (): Effect.Effect<void, never> => {
      if (occupancyService === undefined) return Effect.void;
      const activity = input.toolActivity?.snapshot();
      const entry = {
        runId: input.runId,
        agentId: input.agentId,
        agentName: input.agentName ?? input.agentId,
        conversationId: input.conversationId,
        workingDirectory: input.workingDirectory ?? process.cwd(),
        ...(input.userInput.trim().length > 0
          ? {
              promptExcerpt: input.userInput.trim().slice(0, OCCUPANCY_PROMPT_EXCERPT_CHARS),
            }
          : {}),
        state: heartbeatState.state,
        pid: process.pid,
        host: currentProcessOwner().host,
        updatedAt: new Date().toISOString(),
        ...(activity !== undefined && activity.lastMutatingAt !== ""
          ? {
              lastMutatingAt: activity.lastMutatingAt,
              lastMutatingTool: activity.lastMutatingTool,
            }
          : {}),
        ...(activity !== undefined && activity.lastMutatingPath !== ""
          ? { lastMutatingPath: activity.lastMutatingPath }
          : {}),
        ...(activity !== undefined && activity.lastReadAt !== ""
          ? { lastReadAt: activity.lastReadAt }
          : {}),
      };
      return occupancyService.record(entry).pipe(Effect.ignore);
    };

    // One immediate write, then one per interval for the run's lifetime. `fork` keeps the
    // loop out of the run's error channel; the `ensuring` at the end interrupts it on every
    // exit path, completed or not.
    let stopHeartbeat: Effect.Effect<void, never> = Effect.void;
    if (occupancyService !== undefined) {
      const heartbeat = yield* writeOccupancy().pipe(
        Effect.zipRight(
          Effect.fork(
            Effect.forever(
              Effect.sleep(Duration.millis(OCCUPANCY_HEARTBEAT_MS)).pipe(
                Effect.zipRight(writeOccupancy()),
              ),
            ),
          ),
        ),
      );
      stopHeartbeat = Fiber.interrupt(heartbeat).pipe(Effect.ignore);
    }

    const writeFinalOccupancy = (state: OccupancyRunState) => {
      heartbeatState.state = state;
      return writeOccupancy();
    };

    const withCost = (record: RunRecord): RunRecord => {
      const costUSD = input.costSoFarUSD?.();
      const totalTokens = input.totalTokensSoFar?.();
      return {
        ...record,
        ...(costUSD !== undefined ? { costUSD: (record.costUSD ?? 0) + costUSD } : {}),
        ...(totalTokens !== undefined
          ? { totalTokens: (record.totalTokens ?? 0) + totalTokens }
          : {}),
        activeDurationMs:
          (record.activeDurationMs ?? 0) + Math.max(0, Date.now() - activeStartedAt),
      };
    };

    const moveTo = (state: RunState, includeMetrics = true) =>
      store
        .transition(input.runId, state, includeMetrics ? withCost : undefined)
        .pipe(Effect.ignore);

    // A resumed run already has a record, and `resumeRun` has already claimed it by moving
    // it to `working`. Creating a second one here would leave the original parked forever
    // under an id its approver is still holding.
    const existing = yield* store.get(input.runId);
    if (existing === undefined) {
      yield* store.save(
        createRunRecord({
          runId: input.runId,
          agentId: input.agentId,
          conversationId: input.conversationId,
          input: input.userInput,
          now: new Date(),
          ...(input.approvalPolicy !== undefined ? { approvalPolicy: input.approvalPolicy } : {}),
          ...(input.autoApprovedTools !== undefined
            ? { autoApprovedTools: input.autoApprovedTools }
            : {}),
          ...(input.maxIterations !== undefined ? { maxIterations: input.maxIterations } : {}),
          ...(input.workingDirectory !== undefined
            ? { workingDirectory: input.workingDirectory }
            : {}),
          ...(input.boundary !== undefined ? { boundary: input.boundary } : {}),
        }),
      );
      yield* moveTo(
        {
          kind: "working",
          iteration: 0,
          owner: currentProcessOwner(),
        },
        false,
      );
    }

    return yield* effect.pipe(
      Effect.tap((response) =>
        moveTo(completedState(response)).pipe(Effect.zipRight(writeFinalOccupancy("completed"))),
      ),
      Effect.catchAll((error) => {
        if (!isRunParkRequested(error)) {
          return moveTo(failureState(error))
            .pipe(Effect.zipRight(writeFinalOccupancy("failed")))
            .pipe(Effect.zipRight(Effect.fail(error)));
        }
        const expiresAt = new Date(
          Date.now() + (input.parkTtlMs ?? DEFAULT_PARK_TTL_MS),
        ).toISOString();
        return store.transition(input.runId, parkedState(error, expiresAt)).pipe(
          Effect.tap((updated) => store.save(withCost(updated))),
          Effect.zipRight(writeFinalOccupancy("input-required")),
          Effect.zipRight(
            Effect.fail(
              new RunParkRequested({
                pending: error.pending,
                ...(error.pendingTurnAnswers !== undefined
                  ? { pendingTurnAnswers: error.pendingTurnAnswers }
                  : {}),
                ...(error.messages !== undefined ? { messages: error.messages } : {}),
                ...(error.iteration !== undefined ? { iteration: error.iteration } : {}),
                runId: input.runId,
                expiresAt,
                ...(input.costSoFarUSD?.() !== undefined
                  ? { costUSD: input.costSoFarUSD() as number }
                  : {}),
              }) as E | Error,
            ),
          ),
          Effect.catchIf(
            (failure) => !isRunParkRequested(failure),
            (failure) =>
              moveTo(failureState(failure)).pipe(
                Effect.zipRight(
                  Effect.fail(
                    new Error(
                      `The run needed an approval nobody could answer, and could not be saved for later: ${
                        toError(failure).message
                      }`,
                    ),
                  ),
                ),
              ),
          ),
        );
      }),
      Effect.ensuring(stopHeartbeat),
    );
  });
}
