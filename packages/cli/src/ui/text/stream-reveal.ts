/**
 * Paces streamed prose so it lands as a steady flow instead of in the bursts
 * the provider and the stream buffer deliver it in.
 *
 * The revealed length chases the full text with a time constant: every frame
 * it closes `1 / DRAIN_MS` of the remaining gap per millisecond, so a burst
 * drains fast at first and eases in, and a model that streams at a steady rate
 * is followed about `DRAIN_MS` behind. Two floors keep it honest:
 *
 * - `MIN_CHARS_PER_SECOND` stops the last few characters of a burst from
 *   crawling, which reads as the model hesitating when it has not.
 * - `MAX_LAG_MS` is a hard bound: any character that arrived that long ago is
 *   shown now, whatever the curve says, so the display is never meaningfully
 *   behind the model.
 *
 * The cut point then moves forward to the end of the word it landed in, and
 * never stops inside a terminal escape sequence or a surrogate pair — a
 * half-sequence would paint its bytes as cells until the rest arrived.
 *
 * Pure: the caller owns the clock and the frame loop, and the full text stays
 * the source of truth for copy, search and persistence. Only the displayed
 * prefix is paced.
 */

/** Time constant of the chase. Steady-state lag behind a constant-rate stream. */
export const DRAIN_MS = 250;

/** The slowest a non-empty backlog is ever revealed. */
export const MIN_CHARS_PER_SECOND = 90;

/** No character is held back longer than this after it arrived. */
export const MAX_LAG_MS = 500;

/** A cut this close to the end of its word moves to the word's end. */
const WORD_SNAP_CHARS = 12;

const ESCAPE = "\u001b";
const BELL = "\u0007";

interface Arrival {
  /** Target length once this arrival landed. */
  readonly length: number;
  readonly atMs: number;
}

export interface RevealState {
  readonly targetLength: number;
  readonly shown: number;
  /** Sub-character progress carried between frames. */
  readonly carry: number;
  /** Arrivals not yet fully shown, oldest first. */
  readonly arrivals: readonly Arrival[];
  readonly lastStepMs: number;
}

export function initialReveal(nowMs: number): RevealState {
  return { targetLength: 0, shown: 0, carry: 0, arrivals: [], lastStepMs: nowMs };
}

/** Queue growth in an owned source; a shorter source starts a new reveal. */
export function receiveTarget(
  state: RevealState,
  targetLength: number,
  nowMs: number,
): RevealState {
  if (targetLength === state.targetLength) return state;
  if (targetLength < state.targetLength)
    return receiveTarget(initialReveal(nowMs), targetLength, nowMs);
  const idle = state.shown >= state.targetLength;
  return {
    ...state,
    targetLength,
    arrivals: [...state.arrivals, { length: targetLength, atMs: nowMs }],
    lastStepMs: idle ? nowMs : state.lastStepMs,
  };
}

/** Everything shown at once: turn end, interrupt, or anything that must not lag. */
export function flushReveal(state: RevealState, nowMs: number): RevealState {
  return { ...state, shown: state.targetLength, carry: 0, arrivals: [], lastStepMs: nowMs };
}

export function isRevealing(state: RevealState): boolean {
  return state.shown < state.targetLength;
}

/** Advance the revealed prefix to `nowMs`. */
export function stepReveal(state: RevealState, target: string, nowMs: number): RevealState {
  if (state.shown >= target.length) {
    return state.arrivals.length === 0 && state.lastStepMs === nowMs
      ? state
      : { ...state, arrivals: [], carry: 0, lastStepMs: nowMs };
  }
  const elapsed = Math.max(0, nowMs - state.lastStepMs);
  const backlog = target.length - state.shown;
  const perMs = Math.max(backlog / DRAIN_MS, MIN_CHARS_PER_SECOND / 1000);
  const progress = perMs * elapsed + state.carry;
  const whole = Math.floor(progress);
  let next = Math.min(target.length, state.shown + whole);

  let overdue = 0;
  for (const arrival of state.arrivals) {
    if (nowMs - arrival.atMs >= MAX_LAG_MS) {
      overdue = arrival.length;
    }
  }
  next = Math.max(next, overdue);

  if (next > state.shown) {
    next = safeCut(target, next);
  }
  const arrivals = state.arrivals.filter((arrival) => arrival.length > next);
  return {
    targetLength: state.targetLength,
    shown: next,
    carry: next >= target.length ? 0 : progress - whole,
    arrivals,
    lastStepMs: nowMs,
  };
}

export function revealedText(state: RevealState, target: string): string {
  return target.slice(0, state.shown);
}

/**
 * Move a cut forward to a place it is safe and pleasant to stop: out of any
 * escape sequence, off the low half of a surrogate pair, and to the end of the
 * word it fell in when that end is near.
 */
export function safeCut(text: string, cut: number): number {
  let position = Math.min(text.length, cut);
  position = afterEscape(text, position);
  if (isLowSurrogateAt(text, position)) {
    position += 1;
  }
  const wordEnd = endOfWord(text, position);
  if (wordEnd - position <= WORD_SNAP_CHARS) {
    position = afterEscape(text, wordEnd);
  }
  return Math.min(text.length, position);
}

function isLowSurrogateAt(text: string, position: number): boolean {
  if (position <= 0 || position >= text.length) {
    return false;
  }
  const code = text.charCodeAt(position);
  return code >= 0xdc00 && code <= 0xdfff;
}

/** The end of the word `position` falls inside, or `position` itself on a boundary. */
function endOfWord(text: string, position: number): number {
  if (position <= 0 || /\s/.test(text.charAt(position - 1))) {
    return position;
  }
  let index = position;
  while (index < text.length && !/\s/.test(text.charAt(index))) {
    index += 1;
  }
  return index;
}

/** If `position` is inside an escape sequence, the index just past its end. */
function afterEscape(text: string, position: number): number {
  const start = text.lastIndexOf(ESCAPE, position - 1);
  if (start === -1) {
    return position;
  }
  const end = escapeEnd(text, start);
  return end > position ? end : position;
}

function escapeEnd(text: string, start: number): number {
  const kind = text.charAt(start + 1);
  if (kind === "[") {
    for (let index = start + 2; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) {
        return index + 1;
      }
    }
    return text.length;
  }
  if (kind === "]") {
    for (let index = start + 2; index < text.length; index += 1) {
      if (text.charAt(index) === BELL) {
        return index + 1;
      }
      if (text.charAt(index) === ESCAPE && text.charAt(index + 1) === "\\") {
        return index + 2;
      }
    }
    return text.length;
  }
  return Math.min(text.length, start + 2);
}
