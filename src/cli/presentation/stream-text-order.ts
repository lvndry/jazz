/**
 * Pure logic for applying text_chunk events in order.
 * Extracted so we can unit test streaming order behavior without the full renderer.
 *
 * Fast streaming can deliver events out of order; we only apply a chunk when
 * its sequence is newer than what we've already shown.
 */

export interface TextChunkState {
  liveText: string;
  lastAppliedSequence: number;
}

export interface TextChunkEvent {
  sequence: number;
  accumulated: string;
}

/**
 * Compute new liveText and lastAppliedSequence from a text_chunk event.
 * Only applies the chunk when event.sequence > lastAppliedSequence (ignores stale chunks).
 */
export function applyTextChunkOrdered(
  state: TextChunkState,
  event: TextChunkEvent,
): TextChunkState {
  if (event.sequence > state.lastAppliedSequence) {
    return {
      liveText: event.accumulated,
      lastAppliedSequence: event.sequence,
    };
  }
  return state;
}
