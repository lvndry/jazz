/**
 * The named textarea trade: the composer is a pure buffer, not an OpenTUI
 * editor. Undo, redo and a selection range live here so `InputModel` can stay
 * the authority and the frame stays a function of data.
 */

export interface ComposerBuffer {
  readonly text: string;
  readonly caret: number;
  readonly anchor: number;
}

export const EMPTY_COMPOSER: ComposerBuffer = { text: "", caret: 0, anchor: 0 };

export function composerFromText(text: string): ComposerBuffer {
  const caret = [...text].length;
  return { text, caret, anchor: caret };
}

export function clampOffset(offset: number, length: number): number {
  return Math.max(0, Math.min(offset, length));
}

export function normalizeBuffer(buffer: ComposerBuffer): ComposerBuffer {
  const length = [...buffer.text].length;
  return {
    text: buffer.text,
    caret: clampOffset(buffer.caret, length),
    anchor: clampOffset(buffer.anchor, length),
  };
}

export function selectionRange(buffer: ComposerBuffer): {
  readonly start: number;
  readonly end: number;
} {
  const current = normalizeBuffer(buffer);
  return {
    start: Math.min(current.caret, current.anchor),
    end: Math.max(current.caret, current.anchor),
  };
}

export function hasSelection(buffer: ComposerBuffer): boolean {
  const { start, end } = selectionRange(buffer);
  return start !== end;
}

export function selectedText(buffer: ComposerBuffer): string {
  const { start, end } = selectionRange(buffer);
  return [...buffer.text].slice(start, end).join("");
}

export function moveCaret(buffer: ComposerBuffer, caret: number, extend = false): ComposerBuffer {
  const current = normalizeBuffer(buffer);
  const next = clampOffset(caret, [...current.text].length);
  return { text: current.text, caret: next, anchor: extend ? current.anchor : next };
}

export function selectAll(buffer: ComposerBuffer): ComposerBuffer {
  const length = [...buffer.text].length;
  return { text: buffer.text, caret: length, anchor: 0 };
}

export function replaceRange(
  buffer: ComposerBuffer,
  start: number,
  end: number,
  text: string,
): ComposerBuffer {
  const characters = [...buffer.text];
  const from = clampOffset(start, characters.length);
  const to = clampOffset(end, characters.length);
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  const caret = low + [...text].length;
  return {
    text: [...characters.slice(0, low), ...text, ...characters.slice(high)].join(""),
    caret,
    anchor: caret,
  };
}

export function insertText(buffer: ComposerBuffer, text: string): ComposerBuffer {
  if (hasSelection(buffer)) {
    const { start, end } = selectionRange(buffer);
    return replaceRange(buffer, start, end, text);
  }
  const current = normalizeBuffer(buffer);
  return replaceRange(current, current.caret, current.caret, text);
}

export function deleteBackward(buffer: ComposerBuffer): ComposerBuffer {
  if (hasSelection(buffer)) {
    const { start, end } = selectionRange(buffer);
    return replaceRange(buffer, start, end, "");
  }
  const current = normalizeBuffer(buffer);
  if (current.caret === 0) return current;
  return replaceRange(current, current.caret - 1, current.caret, "");
}

export function deleteForward(buffer: ComposerBuffer): ComposerBuffer {
  if (hasSelection(buffer)) {
    const { start, end } = selectionRange(buffer);
    return replaceRange(buffer, start, end, "");
  }
  const current = normalizeBuffer(buffer);
  if (current.caret >= [...current.text].length) return current;
  return replaceRange(current, current.caret, current.caret + 1, "");
}

export function deleteRange(buffer: ComposerBuffer, start: number, end: number): ComposerBuffer {
  if (hasSelection(buffer)) {
    const range = selectionRange(buffer);
    return replaceRange(buffer, range.start, range.end, "");
  }
  return replaceRange(buffer, start, end, "");
}

export interface ComposerHistory {
  readonly past: readonly ComposerBuffer[];
  readonly present: ComposerBuffer;
  readonly future: readonly ComposerBuffer[];
}

export const EMPTY_HISTORY: ComposerHistory = {
  past: [],
  present: EMPTY_COMPOSER,
  future: [],
};

const HISTORY_CAP = 50;

function sameBuffer(left: ComposerBuffer, right: ComposerBuffer): boolean {
  return left.text === right.text && left.caret === right.caret && left.anchor === right.anchor;
}

export function commit(history: ComposerHistory, next: ComposerBuffer): ComposerHistory {
  const present = normalizeBuffer(history.present);
  const incoming = normalizeBuffer(next);
  if (sameBuffer(present, incoming)) return history;
  if (present.text === incoming.text) {
    return { past: history.past, present: incoming, future: history.future };
  }
  const past = [...history.past, present];
  return {
    past: past.length > HISTORY_CAP ? past.slice(past.length - HISTORY_CAP) : past,
    present: incoming,
    future: [],
  };
}

export function undo(history: ComposerHistory): ComposerHistory {
  const previous = history.past.at(-1);
  if (previous === undefined) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redo(history: ComposerHistory): ComposerHistory {
  const next = history.future[0];
  if (next === undefined) return history;
  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
  };
}
