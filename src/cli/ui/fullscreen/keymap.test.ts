import { describe, expect, it } from "bun:test";
import {
  hintsFor,
  INTERRUPT_WINDOW_MS,
  resolveEscape,
  resolveEscapeChunk,
  resolveFocusKey,
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

describe("footer hints", () => {
  it("advertises only what is pressable in the current focus", () => {
    const transcript = hintsFor("transcript", false);
    expect(transcript.some((hint) => hint.includes("scroll"))).toBe(true);
    expect(transcript.some((hint) => hint.includes("send"))).toBe(false);
  });

  it("offers the interrupt only while a run is active", () => {
    expect(hintsFor("input", true).some((hint) => hint.includes("interrupt"))).toBe(true);
    expect(hintsFor("input", false).some((hint) => hint.includes("interrupt"))).toBe(false);
  });
});

describe("hints are font-safe", () => {
  it("spells key names in ASCII rather than drawing them as symbols", () => {
    // `⏎` is Miscellaneous Technical and the arrows are Arrows — 7/256 and
    // 11/112 coverage in SF Mono — so both render through font fallback at a
    // mismatched advance width on a very common setup. This caught exactly that
    // mistake in the first version of hintsFor.
    for (const focus of ["input", "transcript"] as const) {
      for (const runActive of [true, false]) {
        for (const hint of hintsFor(focus, runActive)) {
          for (const character of hint) {
            const codePoint = character.codePointAt(0) ?? 0;
            expect(codePoint).toBeLessThan(128);
          }
        }
      }
    }
  });
});
