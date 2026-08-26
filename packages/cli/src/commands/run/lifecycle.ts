/**
 * @fileoverview `jazz runs` — inspect and answer runs that are still going.
 *
 * The counterpart to `--park`. A run that stopped for an approval is invisible without
 * this: it is not in the terminal, it is not in a log tail, and the process that started
 * it has exited. These commands are how a person finds it and answers it.
 */

import { makeFileRunStoreLayer } from "@jazz/adapters/storage/run-store";
import { resumeRun } from "@jazz/core/agent/run/resume";
import type { RunRecord } from "@jazz/core/agent/run/run-record";
import { isParked } from "@jazz/core/agent/run/run-state";
import { RunStoreTag } from "@jazz/core/interfaces/run-store";
import { getErrorMessage } from "@jazz/core/presentation/error-handler";
import { Effect } from "effect";

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

    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, runs })}\n`);
      return;
    }
    if (runs.length === 0) {
      process.stdout.write(options.all === true ? "No runs on record.\n" : "No runs in flight.\n");
      return;
    }
    for (const record of runs) {
      const cost = record.costUSD !== undefined ? `  $${record.costUSD.toFixed(6)}` : "";
      process.stdout.write(
        `${record.runId}  ${record.agentId}  ${describeState(record)}${cost}  ${shortInput(record.input)}\n`,
      );
    }
  }).pipe(Effect.provide(makeFileRunStoreLayer()));
}

export function showRunCommand(options: { readonly runId: string; readonly json: boolean }) {
  return Effect.gen(function* () {
    const store = yield* RunStoreTag;
    const record = yield* store.get(options.runId);

    if (record === undefined) {
      const message = `No run with id "${options.runId}".`;
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
      } else {
        process.stderr.write(`${message}\n`);
      }
      process.exitCode = 1;
      return;
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, run: record })}\n`);
      return;
    }

    process.stdout.write(
      `${record.runId}\n` +
        `  agent    ${record.agentId}\n` +
        `  state    ${describeState(record)}\n` +
        `  started  ${record.createdAt}\n` +
        `  updated  ${record.updatedAt}\n` +
        `  prompt   ${shortInput(record.input)}\n`,
    );
    if (record.state.kind === "input-required" && record.state.pending.kind === "tool-approval") {
      process.stdout.write(
        `  waiting  ${record.state.pending.request.message}\n` +
          `  expires  ${record.state.expiresAt}\n`,
      );
    }
  }).pipe(Effect.provide(makeFileRunStoreLayer()));
}

/**
 * Answer a parked run and let it finish.
 *
 * The answer and the work happen in this process, so the command blocks for as long as the
 * rest of the run takes. It can park again — a run that needed two approvals reports the
 * second one the same way the first was reported.
 */
export function answerRunCommand(options: {
  readonly runId: string;
  readonly approved: boolean;
  readonly note?: string;
  readonly json: boolean;
}) {
  return resumeRun({
    runId: options.runId,
    outcome: options.approved
      ? { approved: true }
      : { approved: false, ...(options.note !== undefined ? { userMessage: options.note } : {}) },
  }).pipe(
    Effect.tap((response) =>
      Effect.sync(() => {
        if (options.json) {
          process.stdout.write(
            `${JSON.stringify({ ok: true, runId: options.runId, answer: response.content })}\n`,
          );
        } else {
          process.stdout.write(`${response.content}\n`);
        }
      }),
    ),
    Effect.asVoid,
    Effect.catchAll((error) =>
      Effect.sync(() => {
        const message = getErrorMessage(error);
        if (options.json) {
          process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
        } else {
          process.stderr.write(`${message}\n`);
        }
        process.exitCode = 1;
      }),
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
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: problem })}\n`);
      } else {
        process.stderr.write(`${problem}\n`);
      }
      process.exitCode = 1;
      return;
    }

    yield* store.transition(options.runId, { kind: "canceled", at: "parked" });
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, runId: options.runId })}\n`);
    } else {
      process.stdout.write(`Cancelled run ${options.runId}.\n`);
    }
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        process.stderr.write(`${getErrorMessage(error)}\n`);
        process.exitCode = 1;
      }),
    ),
    Effect.provide(makeFileRunStoreLayer()),
  );
}
