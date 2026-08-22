import { describe, expect, it } from "bun:test";
import {
  hintsFor,
  INTERRUPT_WINDOW_MS,
  isComposerNewline,
  isCopyChord,
  isCtrlLetter,
  isInterruptChord,
  isPrintableSequence,
  normalizeKey,
  resolveEscape,
  resolveEscapeChunk,
  resolveFocusKey,
  resolveScrollKey,
  type EscapeContext,
} from "./keymap";

const IDLE: EscapeContext = {
  overlayOpen: false,
  searchActive: false,
  completionOpen: false,
  runActive: false,
  inputEmpty: true,
  focus: "input",
};

describe("escape ladder", () => {
  it("closes an overlay before anything else", () => {
    // Even mid-run with a draft: the overlay is the most recent thing opened.
    const context = { ...IDLE, overlayOpen: true, runActive: true, inputEmpty: false };
    expect(resolveEscape(context, 0)).toEqual({ type: "close-overlay" });
  });

  it("closes search before dismissing a completion", () => {
    const context = { ...IDLE, searchActive: true, completionOpen: true };
    expect(resolveEscape(context, 0)).toEqual({ type: "close-search" });
  });

  it("dismisses a completion popup before touching the run", () => {
    const context = { ...IDLE, completionOpen: true, runActive: true };
    expect(resolveEscape(context, 0)).toEqual({ type: "dismiss-completion" });
  });

  it("arms on the first escape during a run, and says so rather than acting", () => {
    expect(resolveEscape({ ...IDLE, runActive: true }, 1_000)).toEqual({ type: "arm-interrupt" });
  });

  it("interrupts on a second escape inside the window", () => {
    const context = { ...IDLE, runActive: true, interruptArmedAt: 1_000 };
    expect(resolveEscape(context, 1_000 + INTERRUPT_WINDOW_MS)).toEqual({ type: "interrupt" });
  });

  it("re-arms rather than interrupting once the window has passed", () => {
    const context = { ...IDLE, runActive: true, interruptArmedAt: 1_000 };
    expect(resolveEscape(context, 1_000 + INTERRUPT_WINDOW_MS + 1)).toEqual({
      type: "arm-interrupt",
    });
  });

  it("stashes a draft rather than discarding it", () => {
    expect(resolveEscape({ ...IDLE, inputEmpty: false }, 0)).toEqual({ type: "stash-draft" });
  });

  it("moves focus to the transcript from an empty input", () => {
    expect(resolveEscape(IDLE, 0)).toEqual({ type: "focus-transcript" });
  });

  it("does nothing when already on the transcript with nothing to dismiss", () => {
    expect(resolveEscape({ ...IDLE, focus: "transcript" }, 0)).toEqual({ type: "noop" });
  });

  it("never interrupts when no run is active, whatever the timing", () => {
    const context = { ...IDLE, interruptArmedAt: 0 };
    expect(resolveEscape(context, 10)).not.toEqual({ type: "interrupt" });
  });
});

describe("coalesced escapes over a slow link", () => {
  const chunk = "\x1b\x1b";

  it("interrupts on a doubled escape in one chunk, ignoring the window", () => {
    // Two keystrokes arriving in a single read is common over SSH. Resolving it
    // through the timing ladder would see one Esc and refuse to interrupt.
    const context = { ...IDLE, runActive: true };
    expect(resolveEscapeChunk(chunk, context, 0)).toEqual({ type: "interrupt" });
  });

  it("does not interrupt a doubled escape when nothing is running", () => {
    expect(resolveEscapeChunk(chunk, IDLE, 0)).toEqual({ type: "focus-transcript" });
  });

  it("falls through to the ladder for a single escape", () => {
    expect(resolveEscapeChunk("\x1b", { ...IDLE, runActive: true }, 0)).toEqual({
      type: "arm-interrupt",
    });
  });

  it("is not fooled by an empty chunk", () => {
    // A bug worth a test: `includes("")` is always true, which would turn every
    // keystroke into an interrupt.
    expect(resolveEscapeChunk("", { ...IDLE, runActive: true }, 0)).toEqual({
      type: "arm-interrupt",
    });
  });
});

describe("focus by intent", () => {
  it("returns to the input on i, enter or q", () => {
    for (const key of ["i", "\r", "\n", "q"]) {
      expect(resolveFocusKey(key, "transcript")).toEqual({ type: "focus-input" });
    }
  });

  it("returns to the input when a printable character is typed", () => {
    expect(resolveFocusKey("h", "transcript")).toEqual({ type: "focus-input" });
    expect(resolveFocusKey("?", "transcript")).toEqual({ type: "focus-input" });
  });

  it("accepts printable grapheme and paste sequences but rejects terminal controls", () => {
    expect(isPrintableSequence("👨‍👩‍👧‍👦")).toBe(true);
    expect(isPrintableSequence("e\u0301")).toBe(true);
    expect(isPrintableSequence("pasted text")).toBe(true);
    expect(isPrintableSequence("\u001b[A")).toBe(false);
    expect(isPrintableSequence("\u0002")).toBe(false);
  });

  it("ignores non-printable keys on the transcript", () => {
    expect(resolveFocusKey("pageup", "transcript")).toEqual({ type: "noop" });
  });

  it("lets a scroll key move focus from the input, so PgUp needs no prelude", () => {
    expect(resolveFocusKey("pageup", "input")).toEqual({ type: "focus-transcript" });
    expect(resolveFocusKey("pagedown", "input")).toEqual({ type: "focus-transcript" });
  });

  it("leaves ordinary typing in the input alone", () => {
    expect(resolveFocusKey("h", "input")).toEqual({ type: "noop" });
  });
});

describe("normalizeKey", () => {
  it("reads arrows from CSI, SS3, aliases, and empty-name sequences", () => {
    expect(normalizeKey("\x1b[A").name).toBe("up");
    expect(normalizeKey("\x1bOB").name).toBe("down");
    expect(normalizeKey({ name: "arrowup", sequence: "" }).name).toBe("up");
    expect(normalizeKey({ name: "", sequence: "\x1b[5~" }).name).toBe("pageup");
  });

  it("treats a control byte as ctrl plus the letter, even with no flags", () => {
    const key = normalizeKey("\x12");
    expect(key.name).toBe("r");
    expect(key.ctrl).toBe(true);
    expect(normalizeKey({ name: "r", ctrl: true, sequence: "\x12" }).ctrl).toBe(true);
  });

  it("reads Ctrl+R from kitty CSI-u, modifyOtherKeys, and the live letter+flag shape", () => {
    expect(normalizeKey("\x1b[114;5u")).toMatchObject({ name: "r", ctrl: true });
    expect(normalizeKey("\x1b[18u")).toMatchObject({ name: "r", ctrl: true });
    expect(normalizeKey("\x1b[27;5;114~")).toMatchObject({ name: "r", ctrl: true });
    expect(normalizeKey({ name: "r", ctrl: true, sequence: "r" })).toMatchObject({
      name: "r",
      ctrl: true,
    });
    expect(normalizeKey({ name: "", sequence: "\x1b[114;5u" })).toMatchObject({
      name: "r",
      ctrl: true,
    });
    expect(normalizeKey("\x1b[114;5:3u").name).toBe("");
    expect(normalizeKey("\x1b[114;5:3u").ctrl).toBe(false);
  });

  it("matches Ctrl+R from the flag, a control-character name, and a ctrl+r alias", () => {
    expect(isCtrlLetter(normalizeKey({ name: "r", ctrl: true, sequence: "r" }), "r")).toBe(true);
    expect(isCtrlLetter(normalizeKey({ name: "\x12", sequence: "\x12" }), "r")).toBe(true);
    expect(isCtrlLetter({ name: "ctrl+r", ctrl: false }, "r")).toBe(true);
    expect(isCtrlLetter({ name: "r", ctrl: false }, "r")).toBe(false);
    expect(isCtrlLetter(normalizeKey("\x16"), "v")).toBe(true);
    expect(isCtrlLetter(normalizeKey({ name: "v", ctrl: true, sequence: "v" }), "v")).toBe(true);
    expect(isCtrlLetter({ name: "v", ctrl: true, shift: true }, "v")).toBe(true);
    expect(isCtrlLetter({ name: "v", super: true }, "v")).toBe(false);
  });

  it("reads Ctrl+C from the control byte, letter+flag, kitty, and modifyOtherKeys", () => {
    expect(normalizeKey("\x03")).toMatchObject({ name: "c", ctrl: true });
    expect(normalizeKey({ name: "c", ctrl: true, sequence: "c" })).toMatchObject({
      name: "c",
      ctrl: true,
    });
    expect(normalizeKey({ name: "\x03", sequence: "\x03" })).toMatchObject({
      name: "c",
      ctrl: true,
    });
    expect(normalizeKey("\x1b[99;5u")).toMatchObject({ name: "c", ctrl: true, super: false });
    expect(normalizeKey("\x1b[3u")).toMatchObject({ name: "c", ctrl: true });
    expect(normalizeKey("\x1b[27;5;99~")).toMatchObject({ name: "c", ctrl: true });
    expect(normalizeKey("\x1b[99;9u")).toMatchObject({ name: "c", ctrl: false, super: true });
    expect(normalizeKey("\x1b[3;9u")).toMatchObject({ name: "c", ctrl: false, super: true });
    expect(normalizeKey("\x1b[99;6u")).toMatchObject({
      name: "c",
      ctrl: true,
      shift: true,
      super: false,
    });
    expect(normalizeKey("\x1b[27;9;99~")).toMatchObject({ name: "c", ctrl: false, super: true });
    expect(normalizeKey("\x1b[27;6;99~")).toMatchObject({
      name: "c",
      ctrl: true,
      shift: true,
      super: false,
    });
    expect(isCtrlLetter(normalizeKey("\x03"), "c")).toBe(true);
    expect(isCtrlLetter({ name: "c", ctrl: true }, "c")).toBe(true);
    expect(isCtrlLetter({ name: "", ctrl: false, sequence: "\x03" }, "c")).toBe(true);
    expect(isCtrlLetter({ name: "c", ctrl: false }, "c")).toBe(false);
    expect(isCtrlLetter({ name: "c", ctrl: true, super: true }, "c")).toBe(false);
    expect(isCtrlLetter({ name: "c", super: true }, "c")).toBe(false);
  });

  it("treats Cmd+C and Ctrl+Shift+C as copy, never as interrupt", () => {
    expect(isCopyChord({ name: "c", ctrl: false, shift: false, super: true })).toBe(true);
    expect(isCopyChord({ name: "c", ctrl: true, shift: true, super: false })).toBe(true);
    expect(isCopyChord({ name: "super+c", ctrl: false, shift: false, super: false })).toBe(true);
    expect(isCopyChord({ name: "c", ctrl: true, shift: false, super: false })).toBe(false);
    expect(isInterruptChord({ name: "c", ctrl: true, shift: false, super: false })).toBe(true);
    expect(isInterruptChord({ name: "c", ctrl: true, shift: true, super: false })).toBe(false);
    expect(isInterruptChord({ name: "c", ctrl: false, shift: false, super: true })).toBe(false);
    expect(isInterruptChord({ name: "c", ctrl: true, shift: false, super: true })).toBe(false);
    expect(isInterruptChord(normalizeKey("\x03"))).toBe(true);
    expect(isCopyChord(normalizeKey({ name: "c", super: true, sequence: "c" }))).toBe(true);
    expect(isCopyChord(normalizeKey("\x1b[99;9u"))).toBe(true);
    expect(isInterruptChord(normalizeKey("\x1b[99;9u"))).toBe(false);
    expect(isCopyChord(normalizeKey("\x1b[99;6u"))).toBe(true);
    expect(isInterruptChord(normalizeKey("\x1b[99;6u"))).toBe(false);
    expect(isCopyChord(normalizeKey("\x1b[27;6;99~"))).toBe(true);
    expect(isInterruptChord(normalizeKey("\x1b[27;6;99~"))).toBe(false);
    expect(isInterruptChord(normalizeKey("\x1b[99;5u"))).toBe(true);
    expect(isCopyChord(normalizeKey("\x1b[99;5u"))).toBe(false);
  });

  it("does not turn tab, enter or backspace into ctrl chords", () => {
    expect(normalizeKey("\t")).toEqual({
      name: "tab",
      sequence: "\t",
      ctrl: false,
      shift: false,
      meta: false,
      option: false,
      super: false,
    });
    expect(normalizeKey("\r").name).toBe("return");
    expect(normalizeKey("\r").ctrl).toBe(false);
    expect(normalizeKey("\b").name).toBe("backspace");
    expect(normalizeKey("\b").ctrl).toBe(false);
  });
});

describe("scroll keys", () => {
  it("pages from the input and lines only once the transcript has focus", () => {
    expect(resolveScrollKey("pageup", "input")).toEqual({
      type: "scroll-transcript",
      delta: -1,
      unit: "page",
    });
    expect(resolveScrollKey("up", "input")).toBeNull();
    expect(resolveScrollKey("up", "transcript")).toEqual({
      type: "scroll-transcript",
      delta: -1,
      unit: "line",
    });
  });
});

describe("composer newline", () => {
  it("inserts a newline only when enter is modified", () => {
    expect(isComposerNewline({ name: "return", shift: false, option: false, meta: false })).toBe(
      false,
    );
    expect(isComposerNewline({ name: "return", shift: true, option: false, meta: false })).toBe(
      true,
    );
    expect(isComposerNewline({ name: "enter", shift: false, option: true, meta: false })).toBe(
      true,
    );
    expect(isComposerNewline({ name: "enter", shift: false, option: false, meta: true })).toBe(
      true,
    );
  });
});

describe("footer hints", () => {
  it("advertises exactly the implemented bindings for each state", () => {
    expect(hintsFor("transcript", false)).toEqual([
      "up down to scroll",
      "pgup to page",
      "type to input",
      "^f to search",
    ]);
    expect(hintsFor("input", true, true)).toEqual([
      "enter to queue",
      "up to recall",
      "^x to clear",
      "esc esc to interrupt",
    ]);
    expect(hintsFor("input", false)).toEqual([
      "enter to send",
      "up for history",
      "^f to search",
      "^r for reasoning",
    ]);
    expect(hintsFor("input", false, false, "approval")).toEqual([
      "enter to accept",
      "esc to cancel",
    ]);
    expect(hintsFor("input", false, false, "text")).toEqual(["enter to confirm", "esc to go back"]);
    expect(hintsFor("input", true, false, "search")).toEqual([
      "enter to insert",
      "tab to scope",
      "esc to close",
    ]);
    expect(hintsFor("input", false, false, undefined, true)).toEqual([
      "up down to choose",
      "enter to run",
      "tab to complete",
    ]);
  });

  it("offers the interrupt only while a run is active", () => {
    expect(hintsFor("input", true).some((hint) => hint.includes("interrupt"))).toBe(true);
    expect(hintsFor("input", false).some((hint) => hint.includes("interrupt"))).toBe(false);
  });

  it("never advertises actions that do not exist", () => {
    const advertised = [
      ...hintsFor("input", false),
      ...hintsFor("input", true),
      ...hintsFor("transcript", false),
      ...hintsFor("input", false, false, "approval"),
    ].join(" ");
    expect(advertised).not.toMatch(/\bcopy\b/);
    expect(advertised).not.toContain("palette");
    expect(advertised).not.toContain("history search");
  });
});

describe("hints are font-safe", () => {
  it("spells key names in ASCII rather than drawing them as symbols", () => {
    for (const focus of ["input", "transcript"] as const) {
      for (const runActive of [true, false]) {
        for (const overlay of [undefined, "approval", "search"] as const) {
          for (const commandsOpen of [false, true]) {
            for (const hint of hintsFor(focus, runActive, false, overlay, commandsOpen)) {
              for (const character of hint) {
                const codePoint = character.codePointAt(0) ?? 0;
                expect(codePoint).toBeLessThan(128);
              }
            }
          }
        }
      }
    }
  });
});
