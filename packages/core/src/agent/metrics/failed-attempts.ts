/**
 * @fileoverview What a failed model attempt cost. A retry replaces a failed attempt with a
 * fresh one, and the failed one's streamed output never enters the conversation, so without a
 * record its duration, its output and any usage the provider reported for it vanish.
 *
 * Each failure leaves a compact {@link FailedAttemptRecord}: sizes and flags, never content.
 * The records are bounded per run; the totals in a {@link RetryWasteTally} are not.
 *
 * `wastedUSD` is a lower bound. Only usage the provider reported is priced, and the provider's
 * own report is taken as what it billed, input tokens included. An attempt that produced
 * output (or stalled mid-generation) yet reported no usage may have billed for it; that
 * attempt is counted in `unknownUsageAttempts` and flags the total. An attempt that produced
 * nothing and reported nothing (a refused connection, a 429, a 5xx before generation) is
 * assumed to have billed nothing.
 */

import type { TelemetryErrorCategory } from "@/core/interfaces/telemetry";
import {
  computeUsageCostUSD,
  isUsageCostIncomplete,
  type UsageCostPricing,
  type UsageCostTokens,
} from "@/core/utils/usage-cost";

/** Failed attempts kept per run; further ones only add to the totals. */
export const MAX_FAILED_ATTEMPT_RECORDS = 20;

/**
 * Streamed characters, thinking included, after which a retry is counted as having followed
 * substantial output. About 500 tokens at 4 characters per token: enough that re-generating it
 * is a visible cost rather than a blip.
 */
export const SUBSTANTIAL_STREAMED_CHARS = 2_000;

export type FailedAttemptReason =
  TelemetryErrorCategory | "empty_response" | "stream_stalled" | "unreadable_response";

export type AttemptMode = "streaming" | "non_streaming";

export interface FailedAttemptRecord {
  /** 1-based position among this run's failed attempts. */
  readonly index: number;
  readonly reason: FailedAttemptReason;
  readonly statusCode?: number;
  readonly mode: AttemptMode;
  readonly provider: string;
  readonly model: string;
  readonly durationMs: number;
  /** Characters of text and thinking that had streamed; the content itself is never kept. */
  readonly streamedChars: number;
  readonly toolCallStarted: boolean;
  /** Usage the provider reported for this attempt. */
  readonly usage?: UsageCostTokens;
}

/** What the executor observed about one failed attempt. */
export interface FailedAttemptObservation {
  readonly reason: FailedAttemptReason;
  /** The failure, read only for its HTTP status code. */
  readonly error: unknown;
  readonly mode: AttemptMode;
  readonly provider: string;
  readonly model: string;
  readonly durationMs: number;
  readonly streamedChars: number;
  readonly toolCallStarted: boolean;
  readonly usage?: UsageCostTokens | undefined;
}

export interface RetryWasteTally {
  readonly records: FailedAttemptRecord[];
  failedAttempts: number;
  /** Failures the retry loop will attempt again, as opposed to ones that end the step. */
  retryableFailures: number;
  /** Failed attempts after substantial streamed output; the measurement behind any billing-aware retry guard. */
  retriesAfterSubstantialOutput: number;
  /** Attempts whose usage the provider reported. */
  reportedUsageAttempts: number;
  /** Attempts that may have billed output but reported no usage. */
  unknownUsageAttempts: number;
  /** Token totals of the reporting attempts that carried no billed price. */
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Provider-billed USD of the attempts that reported one; their tokens are not added to the totals above. */
  billedCostUSD: number;
}

export function createRetryWasteTally(): RetryWasteTally {
  return {
    records: [],
    failedAttempts: 0,
    retryableFailures: 0,
    retriesAfterSubstantialOutput: 0,
    reportedUsageAttempts: 0,
    unknownUsageAttempts: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    billedCostUSD: 0,
  };
}

function statusCodeOf(error: unknown): number | undefined {
  if (error !== null && typeof error === "object") {
    const { statusCode } = error as { readonly statusCode?: unknown };
    if (typeof statusCode === "number" && Number.isFinite(statusCode)) {
      return statusCode;
    }
  }
  return undefined;
}

/** Whether an attempt may have billed output it never reported usage for. */
function mayHaveBilledUnreportedOutput(
  reason: FailedAttemptReason,
  streamedChars: number,
  toolCallStarted: boolean,
): boolean {
  return (
    streamedChars > 0 ||
    toolCallStarted ||
    reason === "stream_stalled" ||
    reason === "unreadable_response"
  );
}

export function isSubstantialOutput(streamedChars: number, toolCallStarted: boolean): boolean {
  return toolCallStarted || streamedChars >= SUBSTANTIAL_STREAMED_CHARS;
}

function foldAttemptUsage(
  tally: RetryWasteTally,
  usage: UsageCostTokens | undefined,
  mayHaveBilledUnreportedOutput: boolean,
): void {
  if (usage === undefined) {
    if (mayHaveBilledUnreportedOutput) {
      tally.unknownUsageAttempts += 1;
    }
    return;
  }
  tally.reportedUsageAttempts += 1;
  if (usage.billedCostUSD !== undefined) {
    tally.billedCostUSD += usage.billedCostUSD;
    return;
  }
  tally.promptTokens += usage.promptTokens;
  tally.completionTokens += usage.completionTokens;
  tally.cacheReadTokens += usage.cacheReadTokens ?? 0;
  tally.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
}

/**
 * Fold a retried attempt a renderer heard about into its own tally, which prices a turn's
 * receipt. The run's tally is fed from the full observation; this one only has what the
 * `llm_attempt_failed` event carries.
 */
export function addRetriedAttempt(
  tally: RetryWasteTally,
  usage: UsageCostTokens | undefined,
  usageUnknown: boolean,
): void {
  tally.failedAttempts += 1;
  tally.retryableFailures += 1;
  foldAttemptUsage(tally, usage, usageUnknown);
}

/**
 * Fold a failed attempt into the tally and return its record. The record list stops growing at
 * {@link MAX_FAILED_ATTEMPT_RECORDS}; the counters and token totals keep counting.
 */
export function addFailedAttempt(
  tally: RetryWasteTally,
  observation: FailedAttemptObservation,
  willRetry: boolean,
): FailedAttemptRecord {
  const { reason } = observation;
  const statusCode = statusCodeOf(observation.error);
  const usage = observation.usage;
  tally.failedAttempts += 1;
  if (willRetry) {
    tally.retryableFailures += 1;
  }
  if (isSubstantialOutput(observation.streamedChars, observation.toolCallStarted)) {
    tally.retriesAfterSubstantialOutput += 1;
  }
  foldAttemptUsage(
    tally,
    usage,
    mayHaveBilledUnreportedOutput(reason, observation.streamedChars, observation.toolCallStarted),
  );
  const record: FailedAttemptRecord = {
    index: tally.failedAttempts,
    reason,
    ...(statusCode !== undefined ? { statusCode } : {}),
    mode: observation.mode,
    provider: observation.provider,
    model: observation.model,
    durationMs: Math.max(0, Math.round(observation.durationMs)),
    streamedChars: observation.streamedChars,
    toolCallStarted: observation.toolCallStarted,
    ...(usage !== undefined ? { usage } : {}),
  };
  if (tally.records.length < MAX_FAILED_ATTEMPT_RECORDS) {
    tally.records.push(record);
  }
  return record;
}

/** What a run's failed attempts cost, as a figure a reader can trust to be no larger than the truth. */
export interface RetryWaste {
  /** Failed attempts that were retried. */
  readonly retries: number;
  /** Priced from reported usage; undefined while nothing reported could be priced. */
  readonly wastedUSD: number | undefined;
  /** True when the real figure may be higher: unreported usage, or usage that could not be priced. */
  readonly lowerBound: boolean;
  /**
   * True when usage the provider did report could not be fully priced, so `wastedUSD`
   * understates spend that is known to exist. Unlike unreported usage, this makes a run's
   * `costUSD` incomplete.
   */
  readonly unpriced: boolean;
}

/**
 * Price the tally. A free local model wastes no dollars. Reported tokens without pricing, or
 * cache writes priced at the plain input rate, leave the figure a lower bound.
 */
export function computeRetryWaste(
  tally: RetryWasteTally,
  pricing: UsageCostPricing | undefined,
  freeLocalModel: boolean,
): RetryWaste {
  const retries = tally.retryableFailures;
  if (freeLocalModel) {
    return { retries, wastedUSD: 0, lowerBound: false, unpriced: false };
  }
  const tokens: UsageCostTokens = {
    promptTokens: tally.promptTokens,
    completionTokens: tally.completionTokens,
    cacheReadTokens: tally.cacheReadTokens,
    cacheWriteTokens: tally.cacheWriteTokens,
  };
  const reportedTokens = tally.promptTokens + tally.completionTokens;
  const tokenCostUSD = computeUsageCostUSD(tokens, pricing);
  const pricedAnything = tokenCostUSD !== null || tally.billedCostUSD > 0;
  const wastedUSD = pricedAnything
    ? parseFloat(((tokenCostUSD ?? 0) + tally.billedCostUSD).toFixed(8))
    : undefined;
  const unpriced =
    (tokenCostUSD === null && reportedTokens > 0) || isUsageCostIncomplete(tokens, pricing);
  return {
    retries,
    wastedUSD,
    lowerBound: tally.unknownUsageAttempts > 0 || unpriced,
    unpriced,
  };
}

/**
 * `retries: 2, wasted >= $0.03`, or undefined when nothing was retried. `formatAmount` renders
 * dollars the way the surface renders every other cost.
 */
export function formatRetryWaste(
  waste: RetryWaste,
  formatAmount: (usd: number) => string,
): string | undefined {
  if (waste.retries <= 0) {
    return undefined;
  }
  const retries = `retries: ${String(waste.retries)}`;
  if (waste.wastedUSD !== undefined && waste.wastedUSD > 0) {
    const comparator = waste.lowerBound ? ">= " : "";
    return `${retries}, wasted ${comparator}${formatAmount(waste.wastedUSD)}`;
  }
  return waste.lowerBound ? `${retries}, wasted unknown` : retries;
}
