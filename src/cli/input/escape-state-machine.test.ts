import { describe, expect, test, beforeEach } from "bun:test";
import { Effect } from "effect";
import {
  createEscapeStateMachine,
  createDefaultKeyInfo,
  type EscapeStateMachine,
  type KeyInfo,
} from "./escape-state-machine";
import type { TerminalCapabilities } from "../services/terminal-service";

// ============================================================================
// Test Utilities
// ============================================================================

/** Create mock terminal capabilities for testing */
function createMockCapabilities(): TerminalCapabilities {
  return {
    type: "unknown",
    supportsUnicode: true,
    supportsTrueColor: true,
    supportsHyperlinks: false,
    columns: 80,
    rows: 24,
    escapeSequences: {
      optionLeft: ["\x1b[1;3D", "\x1bb", "\x1b[1;5D", "\x1b[1;9D", "\x1b[3D"],
      optionRight: ["\x1b[1;3C", "\x1bf", "\x1b[1;5C", "\x1b[1;9C", "\x1b[3C"],
      optionDelete: ["\x1bd", "\x1b[3;3~"],
      optionBackspace: ["\x1b\x7f", "\x1b\x08"],
      ctrlLeft: ["\x1b[1;5D", "\x1b[5D"],
      ctrlRight: ["\x1b[1;5C", "\x1b[5C"],
      home: ["\x1b[H", "\x1bOH", "\x1b[1~"],
      end: ["\x1b[F", "\x1bOF", "\x1b[4~"],
      deleteKey: ["\x1b[3~"],
    },
    quirks: {
      interceptsOptionShortcuts: false,
      hasBlocksMode: false,
      backspaceIsDelete: true,
      supportsBracketedPaste: false,
    },
  };
}

/** Create default KeyInfo for testing */
const mockKey: KeyInfo = createDefaultKeyInfo();

/** Helper to process input through state machine */
function process(
  machine: EscapeStateMachine,
  input: string,
  key: KeyInfo = mockKey,
): ReturnType<typeof machine.process> extends Effect.Effect<infer A, never, never> ? A : never {
  return Effect.runSync(machine.process(input, key));
}

// ============================================================================
// Tests
// ============================================================================

describe("EscapeStateMachine", () => {
  let machine: EscapeStateMachine;
  let capabilities: TerminalCapabilities;

  beforeEach(() => {
    capabilities = createMockCapabilities();
    machine = createEscapeStateMachine(capabilities);
  });

  describe("Basic Input", () => {
    test("regular character input", () => {
      const result = process(machine, "a");
      expect(result.type).toBe("char");
      if (result.type === "char") {
        expect(result.char).toBe("a");
      }
    });

    test("multi-byte UTF-8 character", () => {
      const result = process(machine, "你");
      expect(result.type).toBe("char");
      if (result.type === "char") {
        expect(result.char).toBe("你");
      }
    });

    test("emoji character", () => {
      const result = process(machine, "🎵");
      expect(result.type).toBe("char");
      if (result.type === "char") {
        expect(result.char).toBe("🎵");
      }
    });

    test("space character", () => {
      const result = process(machine, " ");
      expect(result.type).toBe("char");
      if (result.type === "char") {
        expect(result.char).toBe(" ");
      }
    });
  });

  describe("Special Keys via KeyInfo", () => {
    test("Enter key (return)", () => {
      const result = process(machine, "", { ...mockKey, return: true });
      expect(result.type).toBe("submit");
    });

    test("Tab key", () => {
      const result = process(machine, "", { ...mockKey, tab: true });
      expect(result.type).toBe("tab");
    });

    test("Backspace key", () => {
      const result = process(machine, "", { ...mockKey, backspace: true });
      expect(result.type).toBe("backspace");
    });

    test("Delete key (from KeyInfo)", () => {
      const result = process(machine, "", { ...mockKey, delete: true });
      expect(result.type).toBe("backspace");
    });

    test("Left arrow", () => {
      const result = process(machine, "", { ...mockKey, leftArrow: true });
      expect(result.type).toBe("left");
    });

    test("Right arrow", () => {
      const result = process(machine, "", { ...mockKey, rightArrow: true });
      expect(result.type).toBe("right");
    });

    test("Up arrow", () => {
      const result = process(machine, "", { ...mockKey, upArrow: true });
      expect(result.type).toBe("up");
    });

    test("Down arrow", () => {
      const result = process(machine, "", { ...mockKey, downArrow: true });
      expect(result.type).toBe("down");
    });
  });

  describe("Option/Alt + Arrow Keys", () => {
    test("meta + leftArrow → word-left", () => {
      const result = process(machine, "", { ...mockKey, meta: true, leftArrow: true });
      expect(result.type).toBe("word-left");
    });

    test("meta + rightArrow → word-right", () => {
      const result = process(machine, "", { ...mockKey, meta: true, rightArrow: true });
      expect(result.type).toBe("word-right");
    });

    test("ESC b sequence → word-left", () => {
      const result = process(machine, "\x1bb");
      expect(result.type).toBe("word-left");
    });

    test("ESC f sequence → word-right", () => {
      const result = process(machine, "\x1bf");
      expect(result.type).toBe("word-right");
    });

    test("CSI 1;3D sequence → word-left", () => {
      const result = process(machine, "\x1b[1;3D");
      expect(result.type).toBe("word-left");
    });

    test("CSI 1;3C sequence → word-right", () => {
      const result = process(machine, "\x1b[1;3C");
      expect(result.type).toBe("word-right");
    });
  });

  describe("Ctrl Key Shortcuts", () => {
    test("Ctrl+A → line-start", () => {
      const result = process(machine, "a", { ...mockKey, ctrl: true });
      expect(result.type).toBe("line-start");
    });

    test("Ctrl+E → line-end", () => {
      const result = process(machine, "e", { ...mockKey, ctrl: true });
      expect(result.type).toBe("line-end");
    });

    test("Ctrl+U → kill-line-back", () => {
      const result = process(machine, "u", { ...mockKey, ctrl: true });
      expect(result.type).toBe("kill-line-back");
    });

    test("Ctrl+K → kill-line-forward", () => {
      const result = process(machine, "k", { ...mockKey, ctrl: true });
      expect(result.type).toBe("kill-line-forward");
    });

    test("Ctrl+W → delete-word-back", () => {
      const result = process(machine, "w", { ...mockKey, ctrl: true });
      expect(result.type).toBe("delete-word-back");
    });

    test("Ctrl+D → delete-char-forward", () => {
      const result = process(machine, "d", { ...mockKey, ctrl: true });
      expect(result.type).toBe("delete-char-forward");
    });

    test("Ctrl+H → backspace", () => {
      const result = process(machine, "h", { ...mockKey, ctrl: true });
      expect(result.type).toBe("backspace");
    });
  });

  describe("Delete Key Sequences", () => {
    test("ESC [ 3 ~ → delete-char-forward", () => {
      const result = process(machine, "\x1b[3~");
      expect(result.type).toBe("delete-char-forward");
    });

    test("ESC d → delete-word-forward", () => {
      const result = process(machine, "\x1bd");
      expect(result.type).toBe("delete-word-forward");
    });

    test("meta + backspace → delete-word-back", () => {
      const result = process(machine, "", { ...mockKey, meta: true, backspace: true });
      expect(result.type).toBe("delete-word-back");
    });

    test("meta + delete → delete-word-back", () => {
      const result = process(machine, "", { ...mockKey, meta: true, delete: true });
      expect(result.type).toBe("delete-word-back");
    });
  });

  describe("Home/End Keys", () => {
    test("ESC [ H → line-start", () => {
      const result = process(machine, "\x1b[H");
      expect(result.type).toBe("line-start");
    });

    test("ESC O H → line-start", () => {
      const result = process(machine, "\x1bOH");
      expect(result.type).toBe("line-start");
    });

    test("ESC [ F → line-end", () => {
      const result = process(machine, "\x1b[F");
      expect(result.type).toBe("line-end");
    });

    test("ESC O F → line-end", () => {
      const result = process(machine, "\x1bOF");
      expect(result.type).toBe("line-end");
    });
  });

  describe("State Machine Behavior", () => {
    test("reset clears state", async () => {
      // Start an escape sequence
      process(machine, "\x1b", { ...mockKey, escape: true });

      // Reset
      await Effect.runPromise(machine.reset);

      // State should be idle
      const state = await Effect.runPromise(machine.getState);
      expect(state._tag).toBe("Idle");
    });

    test("isBuffering returns true during escape sequence", () => {
      // Start escape sequence
      process(machine, "\x1b", { ...mockKey, escape: true });

      const buffering = Effect.runSync(machine.isBuffering);
      expect(buffering).toBe(true);
    });

    test("isBuffering returns false in idle state", () => {
      const buffering = Effect.runSync(machine.isBuffering);
      expect(buffering).toBe(false);
    });
  });

  describe("Character-by-Character Sequence Building", () => {
    test("builds CSI sequence character by character", () => {
      // First, send ESC
      const r1 = process(machine, "\x1b", { ...mockKey, escape: true });
      expect(r1.type).toBe("ignore"); // Buffering

      // Then [
      const r2 = process(machine, "[");
      expect(r2.type).toBe("ignore"); // Still buffering

      // Then 1
      const r3 = process(machine, "1");
      expect(r3.type).toBe("ignore"); // Still buffering

      // Then ;
      const r4 = process(machine, ";");
      expect(r4.type).toBe("ignore"); // Still buffering

      // Then 3
      const r5 = process(machine, "3");
      expect(r5.type).toBe("ignore"); // Still buffering

      // Finally D completes the sequence
      const r6 = process(machine, "D");
      expect(r6.type).toBe("word-left");
    });

    test("plain arrow keys work via CSI", () => {
      // ESC [ D = Left
      process(machine, "\x1b", { ...mockKey, escape: true });
      process(machine, "[");
      const result = process(machine, "D");
      expect(result.type).toBe("left");
    });
  });

  describe("Backspace Handling", () => {
    test("DEL character (0x7f) → backspace", () => {
      const result = process(machine, "\x7f");
      expect(result.type).toBe("backspace");
    });

    test("BS character (0x08) → backspace", () => {
      const result = process(machine, "\x08");
      expect(result.type).toBe("backspace");
    });

    test("ESC + DEL → delete-word-back", () => {
      process(machine, "\x1b", { ...mockKey, escape: true });
      const result = process(machine, "\x7f");
      expect(result.type).toBe("delete-word-back");
    });
  });

  describe("Warp Terminal Compatibility", () => {
    test("Ctrl-based word navigation (CSI 1;5D)", () => {
      const result = process(machine, "\x1b[1;5D");
      expect(result.type).toBe("word-left");
    });

    test("Ctrl-based word navigation (CSI 1;5C)", () => {
      const result = process(machine, "\x1b[1;5C");
      expect(result.type).toBe("word-right");
    });
  });
});
