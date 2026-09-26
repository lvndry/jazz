/**
 * @fileoverview `jazz runs` — inspect and answer runs that are still going.
 *
 * The counterpart to `--park`. A run that stopped for an approval is invisible without
 * this: it is not in the terminal, it is not in a log tail, and the process that started
 * it has exited. These commands are how a person finds it and answers it.
 */

import { resumeGoalAwareRun } from "@jazz/adapters/daemon/goal-worker";
import { makeFileGoalStoreLayer } from "@jazz/adapters/storage/goal-store";
import { makeFileRunStoreLayer } from "@jazz/adapters/storage/run-store";
import type { ResumeRunOptions } from "@jazz/core/agent/run/resume";
import type { RunRecord } from "@jazz/core/agent/run/run-record";
import { isParked } from "@jazz/core/agent/run/run-state";
import { RunStoreTag } from "@jazz/core/interfaces/run-store";
import { getErrorMessage } from "@jazz/core/presentation/error-handler";
import { isAgentStartedProcess } from "@jazz/core/utils/env";
import { Effect } from "effect";
import { emitEnvelope, failEnvelope } from "@/cli/helpers/json-output";

/** Terminal records are kept a week: long enough to answer "what did last night do?". */
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function describeState(record: RunRecord): string {
  const { state } = record;
  switch (state.kind) {
    case "input-required":
      return state.pending.kind === "tool-approval"
        ? `waiting on approval: ${state.pending.request.toolName}`
        : "waiting on an answer";
    case "working":
      return "working";
    case "submitted":
      return "queued";
    case "completed":
      return "completed";
    case "failed":
      return `failed (${state.cause})`;
    case "canceled":
      return "canceled";
  }
}

function shortInput(input: string): string {
  const collapsed = input.replace(/\s+/g, " ").trim();
  return collapsed.length > 60 ? `${collapsed.slice(0, 57)}...` : collapsed;
}

export function listRunsCommand(options: {
  readonly json: boolean;
  readonly agentId?: string;
  readonly conversationId?: string;
  readonly all?: boolean;
}) {
  return Effect.gen(function* () {
    const store = yield* RunStoreTag;
    yield* store.prune({ now: new Date(), maxTerminalAgeMs: TERMINAL_RETENTION_MS });
    const runs = yield* store.list({
      ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
      ...(options.conversationId !== undefined ? { conversationId: options.conversationId } : {}),
      ...(options.all === true ? { includeTerminal: true } : {}),
    });

    const rows = runs.map((record) => {
      const cost = record.costUSD !== undefined ? `  $${record.costUSD.toFixed(6)}` : "";
      return `${record.runId}  ${record.agentId}  ${describeState(record)}${cost}  ${shortInput(record.input)}`;
    });
    const empty = options.all === true ? "No runs on record." : "No runs in flight.";
    emitEnvelope(options.json, { ok: true, runs }, rows.length === 0 ? empty : rows.join("\n"));
  }).pipe(Effect.provide(makeFileRunStoreLayer()));
}

export function showRunCommand(options: { readonly runId: string; readonly json: boolean }) {
  return Effect.gen(function* () {
    const store = yield* RunStoreTag;
    const record = yield* store.get(options.runId);

    if (record === undefined) {
      failEnvelope(options.json, `No run with id "${options.runId}".`);
      return;
    }

    const waiting =
      record.state.kind === "input-required" && record.state.pending.kind === "tool-approval"
        ? [
            `  waiting  ${record.state.pending.request.message}`,
            `  expires  ${record.state.expiresAt}`,
          ]
        : [];
    emitEnvelope(
      options.json,
      { ok: true, run: record },
      [
        record.runId,
        `  agent    ${record.agentId}`,
        `  state    ${describeState(record)}`,
        `  started  ${record.createdAt}`,
        `  updated  ${record.updatedAt}`,
        `  prompt   ${shortInput(record.input)}`,
        ...waiting,
      ].join("\n"),
    );
  }).pipe(Effect.provide(makeFileRunStoreLayer()));
}

/**
 * Answer a parked run and let it finish.
 *
 * The answer and the work happen in this process, so the command blocks for as long as the
 * rest of the run takes. It can park again — a run that needed two approvals reports the
 * second one the same way the first was reported.
 */
function grantsSomething(outcome: ResumeRunOptions["outcome"]): boolean {
  return outcome.kind !== "approval" || outcome.value.approved;
}

/**
 * Why a Jazz agent may not approve or answer a parked run: it would be granting itself the
 * step the run stopped to ask the user about. Rejecting grants nothing, so it stays allowed.
 */
export const AGENT_ANSWER_REFUSAL =
  "Approving or answering a parked run is your decision; this command was started by a Jazz agent, so it was refused. Run it yourself.";

export function answerRunCommand(options: {
  readonly runId: string;
  /** Unused when `response` or `filePath` answers a question or file picker instead. */
  readonly approved?: boolean;
  readonly note?: string;
  readonly response?: string;
  readonly filePath?: string;
  readonly json: boolean;
}) {
  const outcome: ResumeRunOptions["outcome"] =
    options.response !== undefined
      ? {
          kind: "question",
          value:
            options.response.length > 0
              ? { kind: "answered", response: options.response }
              : { kind: "declined" },
        }
      : options.filePath !== undefined
        ? {
            kind: "file-picker",
            value:
              options.filePath.length > 0
                ? { kind: "selected", path: options.filePath }
                : { kind: "cancelled" },
          }
        : {
            kind: "approval",
            value:
              options.approved === true
                ? { approved: true }
                : {
                    approved: false,
                    ...(options.note !== undefined ? { userMessage: options.note } : {}),
                  },
          };
  const fail = (message: string) => Effect.sync(() => failEnvelope(options.json, message));
  return Effect.gen(function* () {
    if (grantsSomething(outcome) && isAgentStartedProcess()) {
      return yield* fail(AGENT_ANSWER_REFUSAL);
    }
    const result = yield* resumeGoalAwareRun({ runId: options.runId, outcome });
    if (result.kind === "blocked") {
      return yield* fail(result.reason);
    }
    const settled =
      result.kind === "not-goal"
        ? { kind: "finished" as const, response: result.response }
        : result.outcome;
    if (settled.kind === "parked") {
      return yield* fail(getErrorMessage(settled.park));
    }
    if (settled.kind === "failed") {
      return yield* fail(settled.error);
    }
    emitEnvelope(
      options.json,
      { ok: true, runId: options.runId, answer: settled.response.content },
      settled.response.content,
    );
  }).pipe(
    Effect.catchAll((error) => fail(getErrorMessage(error))),
    Effect.provide(makeFileRunStoreLayer()),
    Effect.provide(makeFileGoalStoreLayer()),
  );
}

export function cancelRunCommand(options: { readonly runId: string; readonly json: boolean }) {
  return Effect.gen(function* () {
    const store = yield* RunStoreTag;
    const record = yield* store.get(options.runId);

    // Cancelling reaches a parked run, which is inert and simply stops being resumable. It
    // does not reach a run that is mid-flight in another process — that one owns its own
    // interrupt, and claiming otherwise here would be a lie.
    const problem =
      record === undefined
        ? `No run with id "${options.runId}".`
        : !isParked(record.state)
          ? `Run ${options.runId} is ${record.state.kind}. Only a parked run can be cancelled from here.`
          : undefined;

    if (problem !== undefined) {
      failEnvelope(options.json, problem);
      return;
    }

    yield* store.transition(options.runId, { kind: "canceled", at: "parked" });
    emitEnvelope(
      options.json,
      { ok: true, runId: options.runId },
      `Cancelled run ${options.runId}.`,
    );
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => failEnvelope(options.json, getErrorMessage(error))),
    ),
    Effect.provide(makeFileRunStoreLayer()),
  );
}
