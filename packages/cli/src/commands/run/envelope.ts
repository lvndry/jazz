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

import { isZeroCostLocalModel } from "@jazz/core/constants/local-providers";
import { describeArtifact, type GeneratedArtifact } from "@jazz/core/types/artifact";
import type { ChatMessage } from "@jazz/core/types/message";

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
 * Structured result of a `create_web_app` tool call, surfaced alongside the
 * text answer so callers (e.g. the Telegram bridge) can deliver it as an
 * image or a Web App button without having to parse it out of `answer`.
 */
export interface OneShotWebApp {
  readonly id: string;
  readonly mode: "static" | "interactive";
  readonly title: string;
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
  readonly tokenUsage: OneShotTokenUsage;
  readonly toolCalls: readonly OneShotToolCall[];
  readonly webApp?: OneShotWebApp;
  /**
   * Files this run produced, in the order they were made.
   *
   * Supersedes `webApp` for anything that only needs "a file appeared, here is where and what
   * kind" — a script or bridge reads this instead of learning each producing tool by name.
   * `webApp` stays because its interactive mode carries a URL-bearing shape no generic artifact
   * can express.
   */
  readonly artifacts?: readonly GeneratedArtifact[];
  /**
   * Full message transcript for this run, included only for `--ephemeral`
   * calls. Since ephemeral runs never load/save `--conversation` history on
   * disk, any caller that wants multi-turn context (a webhook bridge, a
   * script — this is generic to `jazz run`, not tied to any one integration)
   * round-trips this array back in as `--history-json` on the next call
   * instead. The conversation lives in the caller's own memory, never on
   * disk.
   */
  readonly messages?: readonly ChatMessage[];
}

export interface OneShotOutputOptions {
  readonly json: boolean;
}

/**
 * Distinguish unavailable remote pricing from providers that run on the user's
 * machine. `costIncomplete` comes from the run itself and wins over a defined
 * costUSD: a total that omits unpriced parent or sub-agent spend is not known.
 */
export function isRunCostKnown(
  costUSD: number | undefined,
  provider: string,
  modelId: string,
  costIncomplete = false,
): boolean {
  if (costIncomplete) return false;
  if (costUSD !== undefined) return true;
  return isZeroCostLocalModel(provider, modelId);
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
    tokenUsage: result.tokenUsage,
    toolCalls: result.toolCalls,
    ...(result.webApp ? { webApp: result.webApp } : {}),
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

/** Format a failure (plain message to stderr, or JSON envelope to stdout in --json mode). */
export function formatOneShotError(
  message: string,
  options: OneShotOutputOptions,
  costUSD = 0,
): string {
  return options.json
    ? `${JSON.stringify({ ok: false, error: message, costUSD })}\n`
    : `${message}\n`;
}

/**
 * The three answers `jazz run` can give a caller.
 *
 * Named together because they are one contract: a script branching on the exit code needs
 * all three to mean something, and `parked` only makes sense as "neither of the other
 * two". Previously 0 and 1 were bare literals at their call sites, which is how you end up
 * with a fourth one nobody documented.
 */
export const ONE_SHOT_EXIT = {
  /** An answer was produced. */
  ok: 0,
  /** The run failed and there is nothing to come back to. */
  failed: 1,
  /** The run stopped for a person and can be resumed with `jazz runs approve`. */
  parked: 2,
} as const;
