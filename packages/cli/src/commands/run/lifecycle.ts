/**
 * @fileoverview `jazz runs` — inspect and answer runs that are still going.
 *
 * The counterpart to `--park`. A run that stopped for an approval is invisible without
 * this: it is not in the terminal, it is not in a log tail, and the process that started
 * it has exited. These commands are how a person finds it and answers it.
 */

import { resumeOwnedRun } from "@jazz/adapters/daemon/resume-owned-run";
import { makeFileGoalStoreLayer } from "@jazz/adapters/storage/goal-store";
import { makeFileLoopStoreLayer } from "@jazz/adapters/storage/loop-store";
import { makeFileRunStoreLayer } from "@jazz/adapters/storage/run-store";
import { answerGrantsSomething, type ResumeRunOptions } from "@jazz/core/agent/run/resume";
import type { RunRecord } from "@jazz/core/agent/run/run-record";
import { isParked } from "@jazz/core/agent/run/run-state";
import { RunStoreTag } from "@jazz/core/interfaces/run-store";
import { readConcealedLine } from "@jazz/core/presentation/concealed-line";
import { getErrorMessage } from "@jazz/core/presentation/error-handler";
import { makeOneShotPresentationServiceLayer } from "@jazz/core/presentation/oneshot-presentation-service";
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
        : state.pending.kind === "secret"
          ? "waiting on a secret (jazz runs secret)"
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
 * Why a Jazz agent may not approve or answer a parked run: it would be granting itself the
 * step the run stopped to ask the user about. Rejecting grants nothing, so it stays allowed.
 */
export const AGENT_ANSWER_REFUSAL =
  "Approving or answering a parked run is your decision; this command was started by a Jazz agent, so it was refused. Run it yourself.";

/**
 * Answer a parked run and let it finish.
 *
 * The answer and the work happen in this process, so the command blocks for as long as the
 * rest of the run takes. It can park again — a run that needed two approvals reports the
 * second one the same way the first was reported.
 */
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
  return resumeWithAnswer(options.runId, outcome, options.json);
}

/** Resume `runId` with `outcome` in this process and report how it ended. */
function resumeWithAnswer(runId: string, outcome: ResumeRunOptions["outcome"], json: boolean) {
  const fail = (message: string) => Effect.sync(() => failEnvelope(json, message));
  return Effect.gen(function* () {
    if (answerGrantsSomething(outcome) && isAgentStartedProcess()) {
      return yield* fail(AGENT_ANSWER_REFUSAL);
    }
    const result = yield* resumeOwnedRun({ runId, outcome });
    if (result.kind === "blocked") {
      return yield* fail(result.reason);
    }
    const settled =
      result.kind === "unowned"
        ? { kind: "finished" as const, response: result.response }
        : result.outcome;
    if (settled.kind === "parked") {
      return yield* fail(getErrorMessage(settled.park));
    }
    if (settled.kind === "failed") {
      return yield* fail(settled.error);
    }
    emitEnvelope(
      json,
      { ok: true, runId, answer: settled.response.content },
      settled.response.content,
    );
  }).pipe(
    Effect.catchAll((error) => fail(getErrorMessage(error))),
    Effect.provide(makeFileRunStoreLayer()),
    Effect.provide(makeFileGoalStoreLayer()),
    Effect.provide(makeFileLoopStoreLayer()),
    // The resumed run renders like `jazz run`: stdout carries only the result (one envelope
    // with --json), never the agent's progress.
    Effect.provide(makeOneShotPresentationServiceLayer(new Set())),
  );
}

/**
 * Type the secret a parked run asked for and let it finish.
 *
 * The value is read with a bullet drawn per character (or as the first line of a piped stdin)
 * and handed to the resumed run in this process's memory; it is never stored, logged or put on
 * a command line. Submitting nothing, or Esc, declines.
 */
export function answerRunSecretCommand(options: {
  readonly runId: string;
  readonly json: boolean;
  /** Reads the secret after showing `prompt`; the terminal by default. */
  readonly readSecret?: (prompt: string) => Promise<string | undefined>;
}) {
  return Effect.gen(function* () {
    const store = yield* RunStoreTag;
    const record = yield* store.get(options.runId);
    if (record === undefined) {
      return failEnvelope(options.json, `No run with id "${options.runId}".`);
    }
    const pending = record.state.kind === "input-required" ? record.state.pending : undefined;
    if (pending?.kind !== "secret") {
      return failEnvelope(options.json, `Run ${options.runId} is not waiting for a secret.`);
    }
    if (isAgentStartedProcess()) {
      return failEnvelope(options.json, AGENT_ANSWER_REFUSAL);
    }
    const readSecret = options.readSecret ?? ((prompt: string) => readConcealedLine(prompt));
    const value = yield* Effect.promise(() =>
      readSecret(`🔒 ${pending.request.prompt}\nType it (hidden; Esc to decline): `),
    );
    const outcome: ResumeRunOptions["outcome"] = {
      kind: "secret",
      value:
        value === undefined || value.length === 0
          ? { kind: "declined" }
          : { kind: "provided", value },
    };
    return yield* resumeWithAnswer(options.runId, outcome, options.json);
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => failEnvelope(options.json, getErrorMessage(error))),
    ),
    Effect.provide(makeFileRunStoreLayer()),
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
