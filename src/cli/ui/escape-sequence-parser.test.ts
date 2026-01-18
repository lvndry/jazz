import { describe, expect, test } from "bun:test";
import { parseInput, type KeyInfo } from "./escape-sequence-parser";

// Default mock key with all flags false
const mockKey: KeyInfo = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};

describe("escape-sequence-parser", () => {
  describe("Option+Left (word-left)", () => {
    test("ESC b sequence", () => {
      const result = parseInput("\x1bb", mockKey, "");
      expect(result.parsed.type).toBe("word-left");
    });

    test("double escape left (ESC ESC [ D)", () => {
      const result = parseInput("\x1b\x1b[D", mockKey, "");
      expect(result.parsed.type).toBe("word-left");
    });

    test("double escape SS3 left (ESC ESC O D)", () => {
      const result = parseInput("\x1b\x1bOD", mockKey, "");
      expect(result.parsed.type).toBe("word-left");
    });

    test("CSI sequence 1;3D", () => {
      const result = parseInput("\x1b[1;3D", mockKey, "");
      expect(result.parsed.type).toBe("word-left");
    });

    test("CSI sequence 1;5D", () => {
      const result = parseInput("\x1b[1;5D", mockKey, "");
      expect(result.parsed.type).toBe("word-left");
    });

    test("meta + leftArrow key", () => {
      const result = parseInput("", { ...mockKey, meta: true, leftArrow: true }, "");
      expect(result.parsed.type).toBe("word-left");
    });
  });

  describe("Option+Right (word-right)", () => {
    test("ESC f sequence", () => {
      const result = parseInput("\x1bf", mockKey, "");
      expect(result.parsed.type).toBe("word-right");
    });

    test("double escape right (ESC ESC [ C)", () => {
      const result = parseInput("\x1b\x1b[C", mockKey, "");
      expect(result.parsed.type).toBe("word-right");
    });

    test("double escape SS3 right (ESC ESC O C)", () => {
      const result = parseInput("\x1b\x1bOC", mockKey, "");
      expect(result.parsed.type).toBe("word-right");
    });

    test("CSI sequence 1;3C", () => {
      const result = parseInput("\x1b[1;3C", mockKey, "");
      expect(result.parsed.type).toBe("word-right");
    });

    test("meta + rightArrow key", () => {
      const result = parseInput("", { ...mockKey, meta: true, rightArrow: true }, "");
      expect(result.parsed.type).toBe("word-right");
    });
  });

  describe("Command+Left (line-start)", () => {
    test("CSI 1;2D sequence", () => {
      const result = parseInput("\x1b[1;2D", mockKey, "");
      expect(result.parsed.type).toBe("line-start");
    });

    test("CSI H (Home) sequence", () => {
      const result = parseInput("\x1b[H", mockKey, "");
      expect(result.parsed.type).toBe("line-start");
    });

    test("SS3 H sequence", () => {
      const result = parseInput("\x1bOH", mockKey, "");
      expect(result.parsed.type).toBe("line-start");
    });

    test("Ctrl+A readline shortcut", () => {
      const result = parseInput("a", { ...mockKey, ctrl: true }, "");
      expect(result.parsed.type).toBe("line-start");
    });
  });

  describe("Command+Right (line-end)", () => {
    test("CSI 1;2C sequence", () => {
      const result = parseInput("\x1b[1;2C", mockKey, "");
      expect(result.parsed.type).toBe("line-end");
    });

    test("CSI F (End) sequence", () => {
      const result = parseInput("\x1b[F", mockKey, "");
      expect(result.parsed.type).toBe("line-end");
    });

    test("SS3 F sequence", () => {
      const result = parseInput("\x1bOF", mockKey, "");
      expect(result.parsed.type).toBe("line-end");
    });

    test("Ctrl+E readline shortcut", () => {
      const result = parseInput("e", { ...mockKey, ctrl: true }, "");
      expect(result.parsed.type).toBe("line-end");
    });
  });

  describe("Option+Delete (delete-word-forward)", () => {
    test("ESC d sequence", () => {
      const result = parseInput("\x1bd", mockKey, "");
      expect(result.parsed.type).toBe("delete-word-forward");
    });

    test("meta + delete key", () => {
      const result = parseInput("", { ...mockKey, meta: true, delete: true }, "");
      expect(result.parsed.type).toBe("delete-word-forward");
    });
  });

  describe("Command+Delete (kill-line-back)", () => {
    test("CSI 3;2~ sequence", () => {
      const result = parseInput("\x1b[3;2~", mockKey, "");
      expect(result.parsed.type).toBe("kill-line-back");
    });

    test("Ctrl+U readline shortcut", () => {
      const result = parseInput("u", { ...mockKey, ctrl: true }, "");
      expect(result.parsed.type).toBe("kill-line-back");
    });
  });

  describe("Option+Backspace (delete-word-back)", () => {
    test("meta + backspace key", () => {
      const result = parseInput("", { ...mockKey, meta: true, backspace: true }, "");
      expect(result.parsed.type).toBe("delete-word-back");
    });

    test("Ctrl+W shortcut", () => {
      const result = parseInput("w", { ...mockKey, ctrl: true }, "");
      expect(result.parsed.type).toBe("delete-word-back");
    });
  });

  describe("Basic navigation", () => {
    test("left arrow", () => {
      const result = parseInput("", { ...mockKey, leftArrow: true }, "");
      expect(result.parsed.type).toBe("left");
    });

    test("right arrow", () => {
      const result = parseInput("", { ...mockKey, rightArrow: true }, "");
      expect(result.parsed.type).toBe("right");
    });
  });

  describe("Regular character input", () => {
    test("regular character", () => {
      const result = parseInput("a", mockKey, "");
      expect(result.parsed.type).toBe("char");
      if (result.parsed.type === "char") {
        expect(result.parsed.char).toBe("a");
      }
    });

    test("submit on return", () => {
      const result = parseInput("", { ...mockKey, return: true }, "");
      expect(result.parsed.type).toBe("submit");
    });
  });

  describe("Buffering behavior", () => {
    test("ESC alone causes buffering", () => {
      const result = parseInput("\x1b", mockKey, "");
      expect(result.parsed.type).toBe("buffering");
      expect(result.newBuffer).toBe("\x1b");
    });

    test("ESC [ causes buffering", () => {
      const result = parseInput("[", mockKey, "\x1b");
      expect(result.parsed.type).toBe("buffering");
    });
  });
});
