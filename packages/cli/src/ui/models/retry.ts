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
import { wrapTerminalCells } from "../text/terminal-cells";

export interface RetryBand {
  readonly title: string;
  /** `OpenAI returned 429.` or the provider's own message. */
  readonly cause: string;
  readonly secondsLeft: number;
  readonly attempt: string;
}

/** The one sentence the countdown row says, so the wrapped height and the painted rows agree. */
export function retryCountdownText(band: RetryBand): string {
  return `${band.cause} Retrying in ${String(band.secondsLeft)}s. Nothing is lost.`;
}

/**
 * The rows the band takes at `width`: the title, the wrapped countdown (a cause can carry a
 * long URL and must not run off the edge), and the keys. One cell is left past the two-cell
 * error bar, matching how the band paints its rows.
 */
export function retryBandHeight(band: RetryBand, width: number): number {
  const budget = Math.max(1, width - 3);
  return 1 + Math.max(1, wrapTerminalCells(retryCountdownText(band), budget).length) + 1;
}

function titleFor(reason: string): string {
  if (reason === "rate limit") return "The model provider is rate limiting";
  if (reason === "network issue") return "Can't reach the model provider";
  if (reason === "unreadable response") {
    return "The model provider sent a response Jazz couldn't read";
  }
  if (reason.startsWith("server error")) return "The model provider is having trouble";
  return "The model call failed";
}

/** The band as one line, for a renderer that prints text: the same words, counted down once. */
export function retryLine(notice: RetryNotice, now: number): string {
  const band = retryBand(notice, now);
  return `${band.title} (${band.attempt}). ${band.cause} Retrying in ${String(band.secondsLeft)}s. Nothing is lost.`;
}

/**
 * What the transcript keeps once a retry went through. The live band disappears when output
 * resumes, so without this line the failure leaves no trace in the conversation.
 */
export function retryRecoveredLine(notice: RetryNotice): string {
  const band = retryBand(notice, notice.retryAt);
  return `Recovered after a retry: ${band.title} (${band.attempt}). ${band.cause}`;
}

/** The provider's detail as one sentence, ended with a period only when it has no ending yet. */
function asSentence(detail: string): string {
  return /[.!?]$/.test(detail) ? detail : `${detail}.`;
}

export function retryBand(notice: RetryNotice, now: number): RetryBand {
  const provider =
    notice.provider === undefined ? "The provider" : formatProviderDisplayName(notice.provider);
  const cause =
    notice.statusCode !== undefined
      ? `${provider} returned ${String(notice.statusCode)}.`
      : notice.detail.length > 0
        ? `${provider}: ${asSentence(notice.detail)}`
        : `${provider} did not answer.`;
  return {
    title: titleFor(notice.reason),
    cause,
    secondsLeft: Math.max(0, Math.ceil((notice.retryAt - now) / 1000)),
    attempt: `attempt ${String(notice.attempt)} of ${String(notice.maxAttempts)}`,
  };
}
