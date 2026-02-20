/**
 * Pure logic for applying text_chunk events in order.
 * Extracted so we can unit test streaming order behavior without the full renderer.
 *
 * Fast streaming can deliver events out of order; we only apply a chunk when
 * its sequence is newer than what we've already shown.
 */

import { getVisualWidth, truncateTailAnsiSafe } from "../utils/string-utils";

export interface TextChunkState {
  liveText: string;
  lastAppliedSequence: number;
}

export interface TextChunkEvent {
  sequence: number;
  accumulated: string;
}

export const MAX_LIVE_TEXT_CHARS = 1_000_000;

/**
 * Compute new liveText and lastAppliedSequence from a text_chunk event.
 * Only applies the chunk when event.sequence > lastAppliedSequence (ignores stale chunks).
 *
 * Uses ANSI-safe truncation to avoid splitting escape sequences or multi-byte
 * graphemes when the accumulated text exceeds MAX_LIVE_TEXT_CHARS.
 */
export function applyTextChunkOrdered(
  state: TextChunkState,
  event: TextChunkEvent,
): TextChunkState {
  if (event.sequence > state.lastAppliedSequence) {
    const visibleLength = getVisualWidth(event.accumulated);
    const boundedLiveText =
      visibleLength > MAX_LIVE_TEXT_CHARS
        ? truncateTailAnsiSafe(event.accumulated, MAX_LIVE_TEXT_CHARS)
        : event.accumulated;
    return {
      liveText: boundedLiveText,
      lastAppliedSequence: event.sequence,
    };
  }
  return state;
}
