/**
 * The retry band: what the live zone says while a model call waits to be tried again.
 *
 * It holds the three facts a person needs while nothing seems to happen: who failed and
 * how, how long until the next try, and that the conversation is intact. The countdown is
 * computed from the wall-clock time the retry will be sent, so it stays true however
 * often the frame redraws.
 */

import { formatProviderDisplayName } from "@jazz/core/utils/provider-model";
import type { RetryNotice } from "../store";

export interface RetryBand {
  readonly title: string;
  /** `OpenAI returned 429.` or the provider's own message. */
  readonly cause: string;
  readonly secondsLeft: number;
  readonly attempt: string;
}

/** Rows the band takes in the live zone: title, cause and countdown, then the keys. */
export const RETRY_BAND_ROWS = 3;

function titleFor(reason: string): string {
  if (reason === "rate limit") return "The model provider is rate limiting";
  if (reason === "network issue") return "Can't reach the model provider";
  if (reason.startsWith("server error")) return "The model provider is having trouble";
  return "The model call failed";
}

export function retryBand(notice: RetryNotice, now: number): RetryBand {
  const provider =
    notice.provider === undefined ? "The provider" : formatProviderDisplayName(notice.provider);
  const cause =
    notice.statusCode !== undefined
      ? `${provider} returned ${String(notice.statusCode)}.`
      : notice.detail.length > 0
        ? `${provider}: ${notice.detail}.`
        : `${provider} did not answer.`;
  return {
    title: titleFor(notice.reason),
    cause,
    secondsLeft: Math.max(0, Math.ceil((notice.retryAt - now) / 1000)),
    attempt: `attempt ${String(notice.attempt)} of ${String(notice.maxAttempts)}`,
  };
}
