/**
 * Whether a finished run actually produced an answer a caller can use.
 *
 * A run can end without an error and still have nothing to hand back: the
 * provider returned an empty, zero-token completion, stopped for a reason other
 * than `stop` before writing anything, or withheld the answer behind a content
 * filter. Unattended callers (`jazz run`, workflows, bots) must report those as
 * failures, never as `ok`. `judgeAnswer` is the one place that rule lives.
 *
 * ```ts
 * const verdict = judgeAnswer(response);
 * if (verdict.kind === "failed") {
 *   fail(verdict.code, verdict.message);
 * } else if (verdict.truncated) {
 *   warn("the answer was cut off");
 * }
 * ```
 */

import type { AgentResponse } from "@/core/agent/types";
import type { FinishReason } from "@/core/types/chat";

/** Machine-readable reason a finished run has no usable answer. */
export type AnswerFailureCode = "empty_response" | "no_answer" | "content_filtered";

export type AnswerVerdict =
  | {
      readonly kind: "answered";
      /** The model hit its output limit (`finishReason: "length"`), so the answer is cut off. */
      readonly truncated: boolean;
    }
  | {
      readonly kind: "failed";
      readonly code: AnswerFailureCode;
      readonly message: string;
    };

type JudgedResponse = Pick<
  AgentResponse,
  | "content"
  | "artifacts"
  | "finishReason"
  | "emptyCompletion"
  | "interrupted"
  | "iterationLimited"
  | "costCapped"
  | "tokenCapped"
  | "durationCapped"
>;

/**
 * Whether a model call answered with nothing: no visible text and zero
 * completion tokens (a missing usage report counts as zero).
 */
export function isEmptyCompletion(
  visibleText: string,
  usage: { readonly completionTokens: number } | undefined,
): boolean {
  return visibleText.trim().length === 0 && (usage?.completionTokens ?? 0) === 0;
}

/** An answer is cut off when the model stopped at its output limit. */
export function isTruncated(finishReason: FinishReason | undefined): boolean {
  return finishReason === "length";
}

/**
 * A finished run that produced no usable answer, raised by callers that route
 * it through their ordinary failure path (run history, exit code, envelope).
 */
export class NoUsableAnswerError extends Error {
  readonly code: AnswerFailureCode;

  constructor(verdict: Extract<AnswerVerdict, { kind: "failed" }>) {
    super(verdict.message);
    this.name = "NoUsableAnswerError";
    this.code = verdict.code;
  }
}

/**
 * Judge a run's final response.
 *
 * Runs stopped by a budget, the iteration limit or the user are partial by
 * design and are left to their own flags. Everything else fails when the
 * provider filtered the answer, or when there is no answer and either the
 * completion was empty with zero tokens or the model stopped for a reason other
 * than `stop`.
 */
export function judgeAnswer(response: JudgedResponse): AnswerVerdict {
  const stoppedEarly =
    response.interrupted === true ||
    response.iterationLimited === true ||
    response.costCapped === true ||
    response.tokenCapped === true ||
    response.durationCapped === true;
  if (stoppedEarly) {
    return { kind: "answered", truncated: false };
  }

  const finishReason = response.finishReason;
  if (finishReason === "content-filter") {
    return {
      kind: "failed",
      code: "content_filtered",
      message: "The provider's content filter withheld the model's answer.",
    };
  }

  const hasAnswer = response.content.trim().length > 0 || (response.artifacts?.length ?? 0) > 0;
  if (!hasAnswer && finishReason !== undefined && finishReason !== "stop") {
    return {
      kind: "failed",
      code: "no_answer",
      message: `The model stopped without answering (finish reason: ${finishReason}).`,
    };
  }
  if (!hasAnswer && response.emptyCompletion === true) {
    return {
      kind: "failed",
      code: "empty_response",
      message:
        "The model returned an empty response with zero completion tokens. The provider or model may be misconfigured or overloaded.",
    };
  }

  return { kind: "answered", truncated: isTruncated(finishReason) };
}
