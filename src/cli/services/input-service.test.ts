import { describe, expect, test, beforeEach } from "bun:test";
import { Effect } from "effect";
import { createInputService } from "./input-service";
import { InputResults } from "./input-service";
import type { TerminalCapabilities } from "./terminal-service";
import { createDefaultKeyInfo } from "../input/escape-state-machine";
import type { KeyInfo } from "../input/escape-state-machine";

// ============================================================================
// Test Utilities
// ============================================================================

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

const defaultKey: KeyInfo = createDefaultKeyInfo();

function processInput(
  service: ReturnType<typeof createInputService>,
  input: string,
  key: KeyInfo = defaultKey,
): void {
  Effect.runSync(service.processInput(input, key));
}

// ============================================================================
// Tests
// ============================================================================

describe("InputService", () => {
  let service: ReturnType<typeof createInputService>;

  beforeEach(() => {
    service = createInputService(createMockCapabilities());
  });

  describe("ordered char application (text input ordering)", () => {
    test("multiple char events applied in order produce correct accumulated value", () => {
      let value = "";
      let cursor = 0;

      const cleanup = Effect.runSync(
        service.registerHandler({
          id: "text-accumulator",
          priority: 100,
          isActive: () => true,
          handle: (event) => {
            const action = event.action;
            if (action.type === "char") {
              value =
                value.slice(0, cursor) + action.char + value.slice(cursor);
              cursor += action.char.length;
              return InputResults.consumed();
            }
            if (action.type === "submit") {
              return InputResults.consumed();
            }
            return InputResults.ignored();
          },
        }),
      );

      try {
        processInput(service, "h");
        processInput(service, "e");
        processInput(service, "l");
        processInput(service, "l");
        processInput(service, "o");

        expect(value).toBe("hello");
        expect(cursor).toBe(5);
      } finally {
        cleanup();
      }
    });

    test("rapid sequential chars preserve order (simulates fast typing)", () => {
      let value = "";
      let cursor = 0;

      const cleanup = Effect.runSync(
        service.registerHandler({
          id: "text-accumulator",
          priority: 100,
          isActive: () => true,
          handle: (event) => {
            const action = event.action;
            if (action.type === "char") {
              value =
                value.slice(0, cursor) + action.char + value.slice(cursor);
              cursor += action.char.length;
              return InputResults.consumed();
            }
            return InputResults.ignored();
          },
        }),
      );

      try {
        for (const char of "ab") {
          processInput(service, char);
        }
        expect(value).toBe("ab");
        expect(cursor).toBe(2);
      } finally {
        cleanup();
      }
    });
  });
});
