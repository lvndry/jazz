/**
 * Key resolution for the fullscreen interface, as pure functions.
 *
 * `Esc` is the hardest key in the app because it has eight plausible meanings at
 * any moment, and getting the order wrong is the difference between "closed the
 * dialog" and "threw away my draft". Keeping the decision as a pure function of
 * an explicit context means the ladder can be tested exhaustively instead of
 * discovered in use.
 */

import type { Focus } from "./types";

export type ScrollUnit = "line" | "page" | "end";

export type KeyAction =
  | { readonly type: "close-overlay" }
  | { readonly type: "close-search" }
  | { readonly type: "dismiss-completion" }
  | { readonly type: "interrupt" }
  | { readonly type: "arm-interrupt" }
  | { readonly type: "stash-draft" }
  | { readonly type: "focus-transcript" }
  | { readonly type: "focus-input" }
  | { readonly type: "scroll-transcript"; readonly delta: number; readonly unit: ScrollUnit }
  | { readonly type: "noop" };

export interface NormalizedKey {
  readonly name: string;
  readonly sequence: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
  readonly option: boolean;
  readonly super: boolean;
}

const SEQUENCE_NAMES: Readonly<Record<string, string>> = {
  "\x1b[A": "up",
  "\x1bOA": "up",
  "\x1b[B": "down",
  "\x1bOB": "down",
  "\x1b[C": "right",
  "\x1bOC": "right",
  "\x1b[D": "left",
  "\x1bOD": "left",
  "\x1b[5~": "pageup",
  "\x1b[6~": "pagedown",
  "\x1b[H": "home",
  "\x1b[1~": "home",
  "\x1bOH": "home",
  "\x1b[F": "end",
  "\x1b[4~": "end",
  "\x1bOF": "end",
  "\r": "return",
  "\n": "return",
  "\t": "tab",
  "\x1b[Z": "tab",
  "\x1b": "escape",
  "\x7f": "backspace",
  "\b": "backspace",
};

const NAME_ALIASES: Readonly<Record<string, string>> = {
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  uparrow: "up",
  downarrow: "down",
  leftarrow: "left",
  rightarrow: "right",
  pgup: "pageup",
  pgdown: "pagedown",
  pageup: "pageup",
  pagedown: "pagedown",
  enter: "return",
  esc: "escape",
  spacebar: "space",
};

const ESC = String.fromCharCode(27);
const KITTY_CSI_U = new RegExp("^" + ESC + String.raw`\[(\d+)(?::[^;]*)?(?:;(\d+)(?::(\d+))?)?u$`);
const MODIFY_OTHER_KEYS = new RegExp("^" + ESC + String.raw`\[27;(\d+);(\d+)~$`);

function fieldString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function flagOn(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return value === true || value === 1;
}

function foldName(name: string): string {
  const folded = name.toLowerCase().replace(/[_-]/g, "");
  const aliased = NAME_ALIASES[folded];
  if (aliased !== undefined) return aliased;
  return folded.startsWith("arrow") ? folded.slice("arrow".length) : folded;
}

function letterFromCodepoint(codepoint: number): string | undefined {
  if (codepoint >= 1 && codepoint <= 26) return String.fromCharCode(96 + codepoint);
  if (codepoint >= 97 && codepoint <= 122) return String.fromCharCode(codepoint);
  if (codepoint >= 65 && codepoint <= 90) return String.fromCharCode(codepoint + 32);
  return undefined;
}

function applyControlLetterName(name: string): { readonly name: string; readonly ctrl: boolean } {
  if (name.length !== 1) return { name, ctrl: false };
  const code = name.charCodeAt(0);
  if (code < 1 || code > 26) return { name, ctrl: false };
  return { name: String.fromCharCode(96 + code), ctrl: true };
}

/**
 * Collapse whatever OpenTUI (or a raw stdin chunk) handed us into one shape.
 *
 * The library's mock path sets `name` to "up". A live terminal may only set
 * `sequence` to the CSI/SS3 bytes. Ctrl+R may arrive as `{ name: "r", ctrl }`,
 * as the single byte `\x12`, as kitty CSI-u (`\x1b[114;5u`), or with `sequence`
 * rewritten to the letter `"r"` and the ctrl flag set. Matching only one of
 * those is why chords looked implemented and did nothing.
 */
export function normalizeKey(key: unknown): NormalizedKey {
  if (typeof key === "string") {
    return finalizeNormalized({
      name: "",
      sequence: key,
      ctrl: false,
      shift: false,
      meta: false,
      option: false,
      super: false,
    });
  }
  const record = key !== null && typeof key === "object" ? (key as Record<string, unknown>) : {};
  return finalizeNormalized({
    name: fieldString(record, "name"),
    sequence: fieldString(record, "sequence") || fieldString(record, "raw"),
    ctrl: flagOn(record, "ctrl"),
    shift: flagOn(record, "shift"),
    meta: flagOn(record, "meta"),
    option: flagOn(record, "option"),
    super: flagOn(record, "super"),
  });
}

function finalizeNormalized(fields: NormalizedKey): NormalizedKey {
  let { name, ctrl, shift, meta, option, super: superKey } = fields;
  const { sequence } = fields;
  name = foldName(name);

  const fromName = applyControlLetterName(name);
  if (fromName.ctrl) {
    name = fromName.name;
    ctrl = true;
  }

  const fromSequence = SEQUENCE_NAMES[sequence];
  if (fromSequence !== undefined) {
    name = fromSequence;
    if (sequence === "\x1b[Z") shift = true;
    return { ...fields, name, sequence, shift };
  }

  if (sequence.length === 1) {
    const code = sequence.charCodeAt(0);
    if (code >= 1 && code <= 26) {
      ctrl = true;
      const letter = String.fromCharCode(96 + code);
      if (name.length === 0 || name === sequence || applyControlLetterName(name).ctrl) {
        name = letter;
      }
    }
    return { ...fields, name, sequence, ctrl, shift };
  }

  const kitty = KITTY_CSI_U.exec(sequence);
  if (kitty !== null) {
    if (kitty[3] === "3") {
      return { ...fields, name: "", sequence, ctrl: false, shift: false };
    }
    const letter = letterFromCodepoint(Number(kitty[1]));
    const modifier = kitty[2] === undefined ? 1 : Number(kitty[2]);
    const bits = Number.isFinite(modifier) ? modifier - 1 : 0;
    if ((bits & 1) !== 0) shift = true;
    if ((bits & 2) !== 0) {
      meta = true;
      option = true;
    }
    if ((bits & 4) !== 0) ctrl = true;
    if ((bits & 8) !== 0) superKey = true;
    if (letter !== undefined) {
      name = letter;
      if (Number(kitty[1]) <= 26 && !superKey) ctrl = true;
    }
    return { ...fields, name, sequence, ctrl, shift, meta, option, super: superKey };
  }

  const modifyOther = MODIFY_OTHER_KEYS.exec(sequence);
  if (modifyOther !== null) {
    const bits = Number(modifyOther[1]) - 1;
    const letter = letterFromCodepoint(Number(modifyOther[2]));
    if ((bits & 1) !== 0) shift = true;
    if ((bits & 2) !== 0) {
      meta = true;
      option = true;
    }
    if ((bits & 4) !== 0) ctrl = true;
    if ((bits & 8) !== 0) superKey = true;
    if (letter !== undefined) name = letter;
    return { ...fields, name, sequence, ctrl, shift, meta, option, super: superKey };
  }

  return { ...fields, name, sequence, ctrl, shift, meta, option, super: superKey };
}

export function isCtrlLetter(
  key: Pick<NormalizedKey, "name" | "ctrl"> & {
    readonly sequence?: string;
    readonly super?: boolean;
  },
  letter: string,
): boolean {
  if (key.super === true) return false;
  const folded = letter.toLowerCase();
  if (folded.length !== 1) return false;
  if (key.ctrl && key.name === folded) return true;
  if (key.name === `ctrl+${folded}` || key.name === `c+${folded}` || key.name === `ctrl${folded}`) {
    return true;
  }
  const sequence = key.sequence;
  if (sequence !== undefined && sequence.length === 1) {
    const expected = folded.charCodeAt(0) - 96;
    if (expected >= 1 && expected <= 26 && sequence.charCodeAt(0) === expected) return true;
  }
  return false;
}

export function isInterruptChord(
  key: Pick<NormalizedKey, "name" | "ctrl" | "shift" | "super"> & { readonly sequence?: string },
): boolean {
  if (key.super || key.shift) return false;
  return isCtrlLetter(key, "c");
}

export function isUndoChord(
  key: Pick<NormalizedKey, "name" | "ctrl" | "shift" | "super">,
): boolean {
  if (key.shift) return false;
  if (key.name !== "z" && key.name !== "super+z" && key.name !== "cmd+z") return false;
  return key.ctrl || key.super || key.name === "super+z" || key.name === "cmd+z";
}

export function isRedoChord(
  key: Pick<NormalizedKey, "name" | "ctrl" | "shift" | "super">,
): boolean {
  if (key.name === "y" && key.ctrl && !key.super) return true;
  if (key.name !== "z" && key.name !== "super+z" && key.name !== "cmd+z") return false;
  if (!key.shift) return false;
  return key.ctrl || key.super || key.name === "super+z" || key.name === "cmd+z";
}

export function isSelectAllChord(
  key: Pick<NormalizedKey, "name" | "ctrl" | "shift" | "super">,
): boolean {
  if (key.ctrl) return false;
  if (key.name === "super+a" || key.name === "cmd+a") return true;
  return key.name === "a" && key.super;
}

export function isCopyChord(
  key: Pick<NormalizedKey, "name" | "ctrl" | "shift" | "super">,
): boolean {
  const name = key.name.toLowerCase();
  if (name === "super+c" || name === "cmd+c") return true;
  if (name !== "c") return false;
  if (key.super) return true;
  return key.ctrl && key.shift;
}

export function consumeKeyEvent(key: unknown): void {
  if (key === null || typeof key !== "object") return;
  const event = key as { preventDefault?: () => void; stopPropagation?: () => void };
  event.preventDefault?.();
  event.stopPropagation?.();
}

export function isScrollKey(name: string): boolean {
  return (
    name === "up" ||
    name === "down" ||
    name === "pageup" ||
    name === "pagedown" ||
    name === "home" ||
    name === "end"
  );
}

export function resolveScrollKey(
  name: string,
  focus: Focus,
): Extract<KeyAction, { type: "scroll-transcript" }> | null {
  if (name === "pageup") return { type: "scroll-transcript", delta: -1, unit: "page" };
  if (name === "pagedown") return { type: "scroll-transcript", delta: 1, unit: "page" };
  if (focus !== "transcript") return null;
  if (name === "up") return { type: "scroll-transcript", delta: -1, unit: "line" };
  if (name === "down") return { type: "scroll-transcript", delta: 1, unit: "line" };
  if (name === "home") return { type: "scroll-transcript", delta: -1, unit: "end" };
  if (name === "end") return { type: "scroll-transcript", delta: 1, unit: "end" };
  return null;
}

export interface EscapeContext {
  readonly overlayOpen: boolean;
  readonly searchActive: boolean;
  readonly completionOpen: boolean;
  readonly runActive: boolean;
  /** When the first Esc of a potential double-tap was seen. */
  readonly interruptArmedAt?: number;
  readonly inputEmpty: boolean;
  readonly focus: Focus;
}

/**
 * How long a second `Esc` still counts as a double-tap.
 *
 * This window is a hazard over a high-latency link, where two keystrokes can
 * arrive coalesced or seconds apart. `resolveEscapeChunk` handles the coalesced
 * case directly, which is why this can stay short enough not to swallow a
 * deliberate single Esc.
 */
export const INTERRUPT_WINDOW_MS = 750;

/**
 * The ladder. First match wins, and the order is the whole design:
 *
 *  1. an open overlay is the most recent thing the user opened
 *  2. search, likewise, but keeps the scroll position
 *  3. a completion popup is transient chrome
 *  4. a second Esc during a run interrupts
 *  5. a first Esc during a run arms, and says so
 *  6. a non-empty input stashes the draft rather than losing it
 *  7. already on the transcript with nothing to dismiss: nothing
 *  8. otherwise leave the input for the transcript
 */
export function resolveEscape(context: EscapeContext, now: number): KeyAction {
  if (context.overlayOpen) return { type: "close-overlay" };
  if (context.searchActive) return { type: "close-search" };
  if (context.completionOpen) return { type: "dismiss-completion" };

  if (context.runActive) {
    const armedAt = context.interruptArmedAt;
    if (armedAt !== undefined && now - armedAt <= INTERRUPT_WINDOW_MS) {
      return { type: "interrupt" };
    }
    return { type: "arm-interrupt" };
  }

  if (!context.inputEmpty) return { type: "stash-draft" };
  if (context.focus === "transcript") return { type: "noop" };
  return { type: "focus-transcript" };
}

/**
 * Resolve a raw stdin chunk, before the timing ladder sees it.
 *
 * A single chunk containing two escapes means the user pressed Esc twice and the
 * link coalesced them — which is common over SSH and would otherwise be read as
 * one Esc, silently refusing to interrupt. Treat it as an interrupt regardless
 * of the window.
 */
export function resolveEscapeChunk(chunk: string, context: EscapeContext, now: number): KeyAction {
  if (context.runActive && chunk.includes(ESC + ESC)) return { type: "interrupt" };
  return resolveEscape(context, now);
}

/**
 * Focus moves by intent, not by cycling through a ring.
 *
 * There are exactly two focusable regions. A third would need an ordering, a
 * visible ring for each, and a rule for where focus goes on close — in exchange
 * for nothing a keystroke cannot already do. Typing a printable character while
 * the transcript has focus returns to the input *and* keeps the character, which
 * is the behaviour people expect from a chat box.
 */
export function resolveFocusKey(key: string, focus: Focus): KeyAction {
  if (focus === "transcript") {
    if (key === "i" || key === "\r" || key === "\n" || key === "q") return { type: "focus-input" };
    if (["pageup", "pagedown", "up", "down", "left", "right", "home", "end", "tab"].includes(key)) {
      return { type: "noop" };
    }
    if (isPrintableSequence(key)) return { type: "focus-input" };
    return { type: "noop" };
  }
  // Scroll keys that only exist on the transcript implicitly move focus there,
  // so PgUp works without first pressing a key whose only job is changing focus.
  if (key === "pageup" || key === "pagedown") return { type: "focus-transcript" };
  return { type: "noop" };
}

export function isComposerNewline(key: {
  readonly name: string;
  readonly shift: boolean;
  readonly option: boolean;
  readonly meta: boolean;
}): boolean {
  if (key.name !== "return" && key.name !== "enter") return false;
  return key.shift || key.option || key.meta;
}

export function isPrintableSequence(sequence: string, ctrl = false, superKey = false): boolean {
  if (ctrl || superKey || sequence.length === 0) return false;
  return [...sequence].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code === 0x0a || (code >= 0x20 && code !== 0x7f);
  });
}

/**
 * Hints for the footer, resolved from focus so the footer only ever advertises
 * what is actually pressable right now.
 *
 * Key names stay ASCII. `⏎` and `↑` live in Miscellaneous Technical and Arrows
 * — 7/256 and 11/112 in SF Mono — and would shift the cost column.
 */
export function hintsFor(
  focus: Focus,
  runActive: boolean,
  queueing = false,
  overlay?: "approval" | "search" | "question" | "text" | "filepicker",
  commandsOpen = false,
  overlayArmed = true,
): readonly string[] {
  if (overlay === "approval") {
    return overlayArmed ? ["enter to accept", "esc to reject"] : ["esc to reject"];
  }
  if (overlay === "search") return ["enter to insert", "tab to scope", "esc to close"];
  if (overlay === "text") return ["enter to confirm", "esc to go back"];
  if (overlay === "question" || overlay === "filepicker") {
    return ["enter to confirm", "esc to cancel"];
  }
  if (commandsOpen) return ["up down to choose", "enter to run", "tab to complete"];
  if (focus === "transcript") {
    return ["up down to scroll", "pgup to page", "type to input", "^f to search"];
  }
  if (runActive) {
    return queueing
      ? ["enter to queue", "up to recall", "^x to clear", "esc esc to interrupt"]
      : ["esc esc to interrupt", "^r for reasoning", "^o to expand", "^c to stop"];
  }
  return ["enter to send", "up for history", "^f to search", "^r for reasoning"];
}
