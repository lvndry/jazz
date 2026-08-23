/**
 * @fileoverview Records a run's lifecycle around the effect that performs it.
 *
 * Kept apart from the runner because the runner is already the busiest file in the agent
 * core, and because the recording is genuinely optional: no `RunStore` in the layer means
 * every function here is a pass-through. That is the terminal's configuration — it holds
 * one process open for the whole run and has nobody to answer a question from outside.
 */

import { Effect, Option } from "effect";
import { RunStoreTag } from "@/core/interfaces/run-store";
import { GenerationInterruptedError } from "@/core/types/errors";
import type { AgentResponse } from "../types";
import { isRunParkRequested, type RunParkRequested } from "./park-signal";
import { DEFAULT_PARK_TTL_MS, createRunRecord } from "./run-record";
import type { RunState } from "./run-state";

export interface RunRecordingInput {
  readonly runId: string;
  readonly agentId: string;
  readonly conversationId: string;
  readonly userInput: string;
  /** Sub-agent runs are steps inside their parent's run, not runs of their own. */
  readonly internal: boolean;
  readonly parkTtlMs?: number;
}

function parkedState(signal: RunParkRequested, expiresAt: string): RunState {
  return {
    kind: "input-required",
    pending: signal.pending,
    snapshot: {
      messages: signal.messages ?? [],
      iteration: signal.iteration ?? 0,
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
  const message = error instanceof Error ? error.message : String(error);
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

    const record = createRunRecord({
      runId: input.runId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      input: input.userInput,
      now: new Date(),
    });
    yield* store.save(record);

    const moveTo = (state: RunState) =>
      store.transition(input.runId, state).pipe(Effect.asVoid, Effect.ignore);

    yield* moveTo({ kind: "working", iteration: 0 });

    return yield* effect.pipe(
      Effect.tap((response) => moveTo(completedState(response))),
      Effect.catchAll((error) => {
        if (!isRunParkRequested(error)) {
          return moveTo(failureState(error)).pipe(Effect.zipRight(Effect.fail(error)));
        }
        const expiresAt = new Date(
          Date.now() + (input.parkTtlMs ?? DEFAULT_PARK_TTL_MS),
        ).toISOString();
        return store.transition(input.runId, parkedState(error, expiresAt)).pipe(
          Effect.zipRight(Effect.fail(error as E | Error)),
          Effect.catchIf(
            (failure) => !isRunParkRequested(failure),
            (failure) =>
              moveTo(failureState(failure)).pipe(
                Effect.zipRight(
                  Effect.fail(
                    new Error(
                      `The run needed an approval nobody could answer, and could not be saved for later: ${
                        failure instanceof Error ? failure.message : String(failure)
                      }`,
                    ),
                  ),
                ),
              ),
          ),
        );
      }),
    );
  });
}
