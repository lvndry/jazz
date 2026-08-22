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

export type KeyAction =
  | { readonly type: "close-overlay" }
  | { readonly type: "close-search" }
  | { readonly type: "dismiss-completion" }
  | { readonly type: "interrupt" }
  | { readonly type: "arm-interrupt" }
  | { readonly type: "stash-draft" }
  | { readonly type: "focus-transcript" }
  | { readonly type: "focus-input" }
  | { readonly type: "noop" };

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

const ESC = "\x1b";

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
    if (isPrintable(key)) return { type: "focus-input" };
    return { type: "noop" };
  }
  // Scroll keys that only exist on the transcript implicitly move focus there,
  // so PgUp works without first pressing a key whose only job is changing focus.
  if (key === "pageup" || key === "pagedown") return { type: "focus-transcript" };
  return { type: "noop" };
}

function isPrintable(key: string): boolean {
  if ([...key].length !== 1) return false;
  const code = key.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f;
}

/**
 * Hints for the footer, resolved from focus so the footer only ever advertises
 * what is actually pressable right now.
 *
 * Key names are spelled out in ASCII rather than drawn as symbols. `⏎` lives in
 * Miscellaneous Technical and the arrows in Arrows — 7/256 and 11/112 coverage
 * respectively in SF Mono — so both would be fallback glyphs on a very common
 * setup. A word is always available, and in a hint it reads better anyway.
 */
export function hintsFor(focus: Focus, runActive: boolean): readonly string[] {
  if (focus === "transcript") {
    return ["pgup scroll", "y copy", "/ search", "i type"];
  }
  return runActive
    ? ["esc esc interrupt", "^o expand", "^r reasoning"]
    : ["enter send", "^k palette", "/ search"];
}
