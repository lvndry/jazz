/**
 * Single-line text-field editing, shared by every overlay field that is not
 * the chat composer: the text/password prompt, the AskUserQuestion custom
 * answer, the select/search filter box, the file-picker filter, and the
 * transcript search query.
 *
 * The composer earned its own richer buffer (`composer-edit.ts`) because it is
 * multi-line and carries undo/redo/selection. These fields are flat strings
 * with a caret and nothing else, so one pure function covers all of them
 * instead of every overlay hand-rolling append-and-backspace-from-the-end.
 */

import { isCtrlLetter } from "./keymap";

export interface FieldState {
  readonly value: string;
  readonly caret: number;
}

export interface FieldKeyChord {
  readonly name: string;
  readonly sequence: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly option: boolean;
  readonly super: boolean;
}

/** Start of the word before `at`: skip whitespace, then the run before it. */
export function wordStartBefore(characters: readonly string[], at: number): number {
  let index = Math.max(0, Math.min(at, characters.length));
  while (index > 0 && /\s/.test(characters[index - 1] as string)) index -= 1;
  while (index > 0 && !/\s/.test(characters[index - 1] as string)) index -= 1;
  return index;
}

/** End of the word after `at`: skip whitespace, then the run after it. */
export function wordEndAfter(characters: readonly string[], at: number): number {
  const limit = characters.length;
  let index = Math.max(0, Math.min(at, limit));
  while (index < limit && /\s/.test(characters[index] as string)) index += 1;
  while (index < limit && !/\s/.test(characters[index] as string)) index += 1;
  return index;
}

/**
 * Applies one key to a single-line field, mirroring the composer's bindings
 * (Option word-jump/word-delete, Cmd/Ctrl+U delete-to-start, Home/End,
 * Ctrl+A/E) without the composer's line-wrap or undo/redo concerns. Returns
 * `null` when the key is not a text-editing key, so the caller falls through
 * to whatever else it does with that key (list navigation, submit, cancel).
 */
export function applyTextFieldKey(field: FieldState, key: FieldKeyChord): FieldState | null {
  const { name, sequence, ctrl, meta, option, super: superKey } = key;
  const characters = [...field.value];
  const caret = Math.max(0, Math.min(field.caret, characters.length));

  // Cmd+Backspace and the classic readline Ctrl+U both mean "delete to the
  // start of the line" — checked first since Cmd is reported via `super`,
  // not `meta`/`option`, so it must not fall into the word-delete branch.
  if ((name === "backspace" && superKey) || isCtrlLetter({ name, ctrl }, "u")) {
    return { value: characters.slice(caret).join(""), caret: 0 };
  }
  // Option+Backspace on macOS and Ctrl+Backspace elsewhere both mean "delete
  // the previous word". This keyboard library reports Option as `meta`, not
  // `option`, so both are checked alongside `ctrl`.
  if (name === "backspace" && (meta || option || ctrl)) {
    const boundary = wordStartBefore(characters, caret);
    return {
      value: [...characters.slice(0, boundary), ...characters.slice(caret)].join(""),
      caret: boundary,
    };
  }
  if (name === "backspace") {
    if (caret === 0) return field;
    return {
      value: [...characters.slice(0, caret - 1), ...characters.slice(caret)].join(""),
      caret: caret - 1,
    };
  }
  if (name === "delete") {
    if (caret >= characters.length) return field;
    return {
      value: [...characters.slice(0, caret), ...characters.slice(caret + 1)].join(""),
      caret,
    };
  }

  // Caret motion, widest jump to narrowest: Cmd goes to the edge of the line,
  // Option/Ctrl move by word, Home/End and Ctrl+A/E work everywhere else.
  const wordJump = meta || option || ctrl;
  if (name === "left" && superKey) return { value: field.value, caret: 0 };
  if (name === "right" && superKey) return { value: field.value, caret: characters.length };
  if (name === "left" && wordJump) {
    return { value: field.value, caret: wordStartBefore(characters, caret) };
  }
  if (name === "right" && wordJump) {
    return { value: field.value, caret: wordEndAfter(characters, caret) };
  }
  if (name === "home" || isCtrlLetter({ name, ctrl }, "a")) {
    return { value: field.value, caret: 0 };
  }
  if (name === "end" || isCtrlLetter({ name, ctrl }, "e")) {
    return { value: field.value, caret: characters.length };
  }
  if (name === "left") return { value: field.value, caret: Math.max(0, caret - 1) };
  if (name === "right")
    return { value: field.value, caret: Math.min(characters.length, caret + 1) };

  // Typing, from the sequence the terminal actually sent — see the composer's
  // identical check for why `name` cannot be used to compose text.
  if (!ctrl && !superKey && [...sequence].length === 1) {
    const code = sequence.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) {
      return {
        value: [...characters.slice(0, caret), sequence, ...characters.slice(caret)].join(""),
        caret: caret + [...sequence].length,
      };
    }
  }

  return null;
}
