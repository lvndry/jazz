/**
 * @fileoverview The `jazz run` output contract.
 *
 * What a caller parses: the single JSON object on stdout, the plain-text shape, and the
 * exit code that tells them apart. It lives away from the command because it is not the
 * command's private business — `jazz workflow run` prints the same envelope, and every
 * bridge and script outside this repo is written against it. A change here is a change to
 * a published promise, and it should read as one in a diff.
 *
 * Pure by construction: no Effect, no runner, no I/O. Producing the values is the
 * command's job; saying what they look like on the wire is this file's.
 */

import { isTruncated, type AnswerFailureCode } from "@jazz/core/agent/run/answer-outcome";
import { describeArtifact, type GeneratedArtifact } from "@jazz/core/types/artifact";
import type { FinishReason } from "@jazz/core/types/chat";
import type { ChatMessage } from "@jazz/core/types/message";
import type { StoppedToolCall } from "@jazz/core/types/tools";
import { SIGNAL_EXIT_CODE, type ShutdownSignal } from "@jazz/core/utils/process";

export interface OneShotTokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  /** Share of promptTokens served from the provider's prompt cache. */
  readonly cacheReadTokens?: number;
}

export interface OneShotToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/**
 * Structured result of a `create_composition` tool call, surfaced alongside
 * the text answer so callers can deliver it as an image or interactive link
 * without parsing it out of `answer`.
 */
export interface OneShotComposition {
  readonly id: string;
  readonly mode: "static" | "interactive";
  readonly title: string;
  readonly sessionId: string;
  readonly filename: string;
  readonly htmlPath: string;
  readonly imagePath?: string;
}

export interface OneShotSuccess {
  readonly answer: string;
  readonly costUSD: number;
  /** Whether costUSD is based on pricing metadata rather than an unknown-price fallback. */
  readonly costKnown: boolean;
  /** True when the run stopped early because it hit a configured --max-cost-usd cap. */
  readonly costCapped?: boolean;
  /** True when the run stopped early because it hit a configured --max-tokens cap. */
  readonly tokenCapped?: boolean;
  /** True when the run stopped early because it hit a configured --max-duration-ms budget. */
  readonly durationCapped?: boolean;
  /** True when the run used every allowed iteration without a final answer. */
  readonly iterationLimited?: boolean;
  /** Why the model stopped writing the final answer. */
  readonly finishReason?: FinishReason;
  /** True when the answer was cut off at the model's output limit (`finishReason: "length"`). */
  readonly truncated?: boolean;
  /**
   * True when the agent has tools but none were sent, because Jazz does not
   * know the model supports tool calling. The answer came from a model that
   * could only talk.
   */
  readonly toolsDisabled?: boolean;
  /** True when the run was stopped for repeating the same tool calls without progress. */
  readonly stalled?: boolean;
  /** The calls of a tool batch the run stopped part-way, and what became of each. */
  readonly stoppedToolCalls?: readonly StoppedToolCall[];
  readonly tokenUsage: OneShotTokenUsage;
  readonly toolCalls: readonly OneShotToolCall[];
  readonly composition?: OneShotComposition;
  /**
   * Files this run produced, in the order they were made.
   *
   * Supersedes `composition` for anything that only needs "a file appeared, here is where and what
   * kind" — a script or bridge reads this instead of learning each producing tool by name.
   * `composition` stays because its interactive mode carries a URL-bearing shape no generic artifact
   * can express.
   */
  readonly artifacts?: readonly GeneratedArtifact[];
  /**
   * Full message transcript for this run, included only for `--ephemeral`
   * calls. Since ephemeral runs never load/save `--conversation` history on
   * disk, any caller that wants multi-turn context (a webhook bridge, a
   * script — this is generic to `jazz run`, not tied to any one integration)
   * round-trips this array back in as the `--input-stdin` frame's `history`
   * on the next call instead. The conversation lives in the caller's own memory, never on
   * disk.
   */
  readonly messages?: readonly ChatMessage[];
}

type OutcomeFields = Pick<
  OneShotSuccess,
  "iterationLimited" | "finishReason" | "truncated" | "toolsDisabled"
>;

/**
 * The success-envelope fields that say how complete the answer is, from the
 * run's response. Shared by `jazz run` and `jazz workflow run --json` so both
 * report the same flags.
 */
export function answerOutcomeFields(response: {
  readonly iterationLimited?: boolean;
  readonly finishReason?: FinishReason;
  readonly toolsDisabled?: boolean;
}): OutcomeFields {
  return {
    ...(response.iterationLimited === true ? { iterationLimited: true } : {}),
    ...(response.finishReason !== undefined ? { finishReason: response.finishReason } : {}),
    ...(isTruncated(response.finishReason) ? { truncated: true } : {}),
    ...(response.toolsDisabled === true ? { toolsDisabled: true } : {}),
  };
}

export interface OneShotOutputOptions {
  readonly json: boolean;
}

/**
 * Format a successful run for stdout.
 *
 * Plain mode returns just the trimmed answer (raw markdown, ready to be
 * translated to Slack mrkdwn / Google Chat formatting downstream). JSON mode
 * returns exactly one single-line envelope.
 */
export function formatOneShotResult(result: OneShotSuccess, options: OneShotOutputOptions): string {
  if (!options.json) {
    const answer = result.answer.trim();
    const artifacts = result.artifacts ?? [];
    if (artifacts.length === 0) return `${answer}\n`;

    // Paths go below the answer whether or not the model mentioned them. A run that writes a
    // file and does not say where is a run the user has to go hunting after, and models are
    // inconsistent about repeating a path they already saw in a tool result.
    const lines = artifacts.map((artifact) => `  ${describeArtifact(artifact)}`).join("\n");
    return `${answer}\n\n${lines}\n`;
  }

  return `${JSON.stringify({
    ok: true,
    answer: result.answer,
    costUSD: result.costUSD,
    costKnown: result.costKnown,
    ...(result.costCapped ? { costCapped: true } : {}),
    ...(result.tokenCapped ? { tokenCapped: true } : {}),
    ...(result.durationCapped ? { durationCapped: true } : {}),
    ...(result.iterationLimited ? { iterationLimited: true } : {}),
    ...(result.finishReason !== undefined ? { finishReason: result.finishReason } : {}),
    ...(result.truncated ? { truncated: true } : {}),
    ...(result.toolsDisabled ? { toolsDisabled: true } : {}),
    ...(result.stalled ? { stalled: true } : {}),
    ...(result.stoppedToolCalls ? { stoppedToolCalls: result.stoppedToolCalls } : {}),
    tokenUsage: result.tokenUsage,
    toolCalls: result.toolCalls,
    ...(result.composition ? { composition: result.composition } : {}),
    ...(result.artifacts && result.artifacts.length > 0 ? { artifacts: result.artifacts } : {}),
    ...(result.messages ? { messages: result.messages } : {}),
  })}\n`;
}

/**
 * Format a run that stopped to wait for a person.
 *
 * Neither success nor failure: no answer was produced, but nothing went wrong and the work
 * is still there to finish. Callers that only branch on `ok` treat it as a failure, which
 * is the safe reading; callers that know about parking read `state` and `runId` and come
 * back with `jazz runs approve`.
 */
export function formatOneShotParked(
  parked: {
    readonly runId: string;
    readonly expiresAt: string;
    readonly toolName: string;
    readonly toolCallId: string;
    readonly message: string;
  },
  options: OneShotOutputOptions,
  costUSD = 0,
): string {
  if (options.json) {
    return `${JSON.stringify({
      ok: false,
      state: "input-required",
      runId: parked.runId,
      expiresAt: parked.expiresAt,
      pending: {
        kind: "tool-approval",
        toolName: parked.toolName,
        toolCallId: parked.toolCallId,
        message: parked.message,
      },
      costUSD,
    })}\n`;
  }
  return (
    `Waiting for approval: ${parked.message}\n` +
    `Run ${parked.runId} is parked until ${parked.expiresAt}.\n` +
    `Approve it with: jazz runs approve ${parked.runId}\n`
  );
}

/**
 * Machine-readable failure reasons in the `code` field of a failure envelope.
 *
 * - `failed`: the run errored (provider, tool, configuration, timeout).
 * - `empty_response`, `no_answer`, `content_filtered`: the run finished but
 *   produced no usable answer (see `judgeAnswer`).
 * - `interrupted`: SIGINT or SIGTERM stopped the run.
 */
export type OneShotErrorCode = "failed" | "interrupted" | AnswerFailureCode;

/** Extra fields a failure envelope carries beyond its message and cost. */
export interface OneShotFailureDetails {
  readonly stoppedToolCalls?: readonly StoppedToolCall[];
  readonly code?: OneShotErrorCode;
  readonly finishReason?: FinishReason;
  readonly signal?: ShutdownSignal;
  readonly toolsDisabled?: boolean;
}

/** Format a failure (plain message to stderr, or JSON envelope to stdout in --json mode). */
export function formatOneShotError(
  message: string,
  options: OneShotOutputOptions,
  costUSD = 0,
  details: OneShotFailureDetails = {},
): string {
  if (!options.json) {
    return `${message}\n`;
  }
  return `${JSON.stringify({
    ok: false,
    error: message,
    code: details.code ?? "failed",
    ...(details.stoppedToolCalls !== undefined
      ? { stoppedToolCalls: details.stoppedToolCalls }
      : {}),
    costUSD,
    ...(details.finishReason !== undefined ? { finishReason: details.finishReason } : {}),
    ...(details.signal !== undefined ? { signal: details.signal } : {}),
    ...(details.toolsDisabled ? { toolsDisabled: true } : {}),
  })}\n`;
}

/**
 * The exit codes `jazz run` can give a caller.
 *
 * Named together because they are one contract: a script branching on the exit code needs
 * each to mean something, and `parked` only makes sense as "neither success nor failure".
 * The signal codes follow the shell convention of 128 plus the signal number.
 */
export const ONE_SHOT_EXIT = {
  /** An answer was produced. */
  ok: 0,
  /** The run failed, or finished without a usable answer, and there is nothing to come back to. */
  failed: 1,
  /** The run stopped for a person and can be resumed with `jazz runs approve`. */
  parked: 2,
  /** SIGINT stopped the run. */
  interrupted: SIGNAL_EXIT_CODE.SIGINT,
  /** SIGTERM stopped the run. */
  terminated: SIGNAL_EXIT_CODE.SIGTERM,
} as const;
